/** GitLab notes, Issues, merge requests and pipelines as Triggers, the Channel that answers them with notes, and the merge request rules. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, key, threadKey, type Assessor, type Executor, type OutboundMessage, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { gitlabLink, sendGitlab } from '../src/sources/gitlab-channel.ts'
import { claimMr, gitlabPullHost, mrEndNotices, observeMr, type Mr } from '../src/sources/gitlab-mr.ts'
import { gitlabAddress, gitlabChannel, IssueSchema, mentions, MergeRequestSchema, NoteSchema, noteTrigger, openedTrigger, pipelineTrigger,
  SOURCE, threadIdOf, type GitlabRef } from '../src/sources/gitlab-trigger.ts'
import { pullNumbers, pullOf } from '../src/sources/pulls.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment, testGitlabDeployment } from './fixtures/deployment.ts'

const AGENT = 'agent.bot'
// GitLab 11.7 serves its pages without the `/-/` that newer versions put before them.
const WEB = 'http://git.example.com/acme/widgets'
const issue: GitlabRef = { kind: 'issue', iid: 3, url: `${WEB}/issues/3` }
const mr: GitlabRef = { kind: 'mr', iid: 7, url: `${WEB}/merge_requests/7`, mrAuthor: 'carol' }
/** A note as GitLab 11.7 returns it, whose timestamps carry the instance's offset. */
const note = (overrides: Record<string, unknown> = {}) => NoteSchema.parse({ id: 5, body: 'This looks wrong', system: false,
  author: { id: 2, username: 'alice', name: 'Alice', state: 'active' }, created_at: '2026-11-01T10:00:00.000+08:00',
  updated_at: '2026-11-01T10:00:00.000+08:00', noteable_id: 70, noteable_type: 'MergeRequest', noteable_iid: 7, ...overrides })
/** An Issue as GitLab 11.7 returns it. */
const opened = (overrides: Record<string, unknown> = {}) => IssueSchema.parse({ id: 90, iid: 3, project_id: 42, title: 'Login fails',
  description: 'It fails after the update.', state: 'opened', author: { id: 2, username: 'alice', name: 'Alice' },
  created_at: '2026-11-01T02:00:00.000Z', updated_at: '2026-11-01T02:30:00.000Z', closed_at: null, web_url: `${WEB}/issues/3`, ...overrides })
/** A merge request as GitLab 11.7 returns it: a draft is `work_in_progress`, and there is no `draft`. */
const mrPayload = { id: 91, iid: 7, project_id: 42, title: 'Fix login', description: null, state: 'opened', author: { username: 'carol' },
  created_at: '2026-11-01T02:00:00.000Z', updated_at: '2026-11-01T02:30:00.000Z', closed_at: null, merged_at: null,
  source_branch: 'agent/fix-login', target_branch: 'master', source_project_id: 42, target_project_id: 42, work_in_progress: false,
  web_url: `${WEB}/merge_requests/7` }

describe('GitLab Triggers', () => {
  it('translates a note into a Trigger on the Thread of its Issue or merge request', () => {
    const trigger = noteTrigger(note({ body: 'Could @agent.bot take a look?' }), mr, AGENT)!
    expect(trigger).toEqual({ id: key('gitlab-note', 'mr:7', '5', '2026-11-01T10:00:00.000+08:00'), source: 'gitlab',
      threads: [{ source: 'gitlab', id: 'mr:7' }], actor: { source: 'gitlab', id: 'alice' }, human: true, addressed: 'mention',
      at: '2026-11-01T10:00:00.000+08:00', text: 'Could @agent.bot take a look?', url: mr.url,
      channel: { source: 'gitlab', thread: 'gitlab:mr:7', address: { kind: 'mr', iid: '7', url: mr.url } },
      meta: { iid: 7, isMr: true, mrAuthor: 'carol', noteId: 5, kind: 'note' } })
    // Without a page to point at, neither the Trigger nor its address carries a URL.
    const bare = noteTrigger(note(), { kind: 'issue', iid: 3 }, AGENT)!
    expect(bare).not.toHaveProperty('url')
    expect(bare).not.toHaveProperty('addressed')
    expect(bare.channel!.address).toEqual({ kind: 'issue', iid: '3' })
    expect(bare.meta).toEqual({ iid: 3, isMr: false, noteId: 5, kind: 'note' })
  })

  it('gives a note a stable id that changes when it is edited', () => {
    const first = noteTrigger(note(), mr, AGENT)!
    // Reading the note again gives the same Trigger, which intake takes for a duplicate.
    expect(noteTrigger(note(), mr, AGENT)).toEqual(first)
    // An edit moves `updated_at`: a new event on the same Thread, at the time of the edit.
    const edited = noteTrigger(note({ body: 'Sorry, this is fine', updated_at: '2026-11-01T10:05:00.000+08:00' }), mr, AGENT)!
    expect(edited.id).not.toBe(first.id)
    expect(edited).toMatchObject({ threads: first.threads, at: '2026-11-01T10:05:00.000+08:00', text: 'Sorry, this is fine' })
    // The Thread is part of the id.
    expect(noteTrigger(note(), { kind: 'issue', iid: 7 }, AGENT)!.id).not.toBe(first.id)
  })

  it('drops system notes and the agent\'s own notes', () => {
    // GitLab writes a system note for every event, such as a mention in another merge request; none of them asks the agent anything.
    expect(noteTrigger(note({ system: true, body: 'mentioned in merge request !9 @agent.bot' }), mr, AGENT)).toBeUndefined()
    expect(noteTrigger(note({ author: { username: AGENT } }), mr, AGENT)).toBeUndefined()
    // GitLab compares user names without regard to case.
    expect(noteTrigger(note({ author: { username: 'Agent.Bot' } }), mr, AGENT)).toBeUndefined()
    expect(noteTrigger(note({ author: { username: 'agent.bot2' } }), mr, AGENT)).toMatchObject({ actor: { id: 'agent.bot2' }, human: true })
  })

  it('addresses the agent only on a real mention', () => {
    for (const text of ['@agent.bot hi', 'hi @agent.bot', 'hi\n@agent.bot', '(@agent.bot)', '@AGENT.BOT hi', '请看一下@agent.bot',
      // The end of a sentence is not part of a user name.
      '@agent.bot.', '@agent.bot,', 'Thanks @agent.bot.', '@agent.bot: please look', '@agent.bot...']) {
      expect(mentions(text, AGENT), text).toBe(true)
    }
    for (const text of ['foo@agent.bot', 'mail a.b@agent.bot', 'foo.@agent.bot', 'foo-@agent.bot', '@@agent.bot', '@xagent.bot', '@agent', '@agentXbot',
      // A character that goes on with a user name is a longer name.
      '@agent.bots', '@agent.bot.x', '@agent.bot-2', '@agent.bot_x', '@agent.bot9']) {
      expect(mentions(text, AGENT), text).toBe(false)
    }
    expect(mentions('@agent_bot-2 go', 'agent_bot-2')).toBe(true)
    expect(mentions('@agent_bot-2x go', 'agent_bot-2')).toBe(false)
    expect(noteTrigger(note({ body: '@agent.bot please look' }), mr, AGENT)!.addressed).toBe('mention')
    expect(noteTrigger(note({ body: 'cc foo@agent.bot' }), mr, AGENT)).not.toHaveProperty('addressed')
  })

  it('keeps the id of an opened issue when its body changes', () => {
    const first = openedTrigger(opened(), issue, AGENT)
    expect(first.id).toBe(key('gitlab-opened', 'issue:3'))
    // GitLab moves `updated_at` for comments and labels too, so an edited description is not told apart: only the opening is ingested.
    const edited = opened({ description: 'It fails only on Safari.', updated_at: '2026-11-02T00:00:00.000Z' })
    expect(openedTrigger(edited, issue, AGENT).id).toBe(first.id)
    // Issues and merge requests are numbered separately.
    expect(openedTrigger(opened(), { kind: 'mr', iid: 3 }, AGENT).id).not.toBe(first.id)
  })

  it('translates a new Issue or merge request into a Trigger on its own Thread', () => {
    expect(openedTrigger(opened({ description: 'Hi @agent.bot, please look.' }), issue, AGENT)).toEqual({
      id: key('gitlab-opened', 'issue:3'), source: 'gitlab', threads: [{ source: 'gitlab', id: 'issue:3' }],
      actor: { source: 'gitlab', id: 'alice' }, human: true, addressed: 'mention', at: '2026-11-01T02:00:00.000Z',
      text: 'Login fails\n\nHi @agent.bot, please look.', url: `${WEB}/issues/3`,
      channel: { source: 'gitlab', thread: 'gitlab:issue:3', address: { kind: 'issue', iid: '3', url: `${WEB}/issues/3` } },
      meta: { iid: 3, isMr: false, kind: 'issue' } })
    // The title does not address the agent, and a missing description leaves the title alone.
    const request = openedTrigger(MergeRequestSchema.parse({ ...mrPayload, title: '@agent.bot fix login' }), { kind: 'mr', iid: 7 }, AGENT)
    expect(request).toMatchObject({ threads: [{ source: 'gitlab', id: 'mr:7' }], text: '@agent.bot fix login\n\n', url: `${WEB}/merge_requests/7`,
      meta: { iid: 7, isMr: true, mrAuthor: 'carol', kind: 'mr' } })
    expect(request).not.toHaveProperty('addressed')
    // The agent's own Issue is not a person's.
    expect(openedTrigger(opened({ author: { username: 'Agent.Bot' } }), issue, AGENT).human).toBe(false)
  })

  it('reads the merge request shapes of GitLab 11.7 and of newer versions', () => {
    // 11.7 marks a draft with `work_in_progress` and sends no `draft`; newer versions send both.
    expect(MergeRequestSchema.parse({ ...mrPayload, work_in_progress: true })).toMatchObject({ state: 'opened', work_in_progress: true })
    expect(MergeRequestSchema.parse({ ...mrPayload, work_in_progress: true, draft: true })).toMatchObject({ draft: true, work_in_progress: true })
    const { work_in_progress: _flag, ...bare } = mrPayload
    expect(MergeRequestSchema.parse(bare)).toMatchObject({ iid: 7, source_branch: 'agent/fix-login', source_project_id: 42, target_project_id: 42 })
    // A merged one has its time, and what the code does not read passes through.
    expect(MergeRequestSchema.parse({ ...mrPayload, state: 'merged', merged_at: '2026-11-01T12:00:00.000+08:00', labels: ['bug'] }))
      .toMatchObject({ state: 'merged', merged_at: '2026-11-01T12:00:00.000+08:00', labels: ['bug'] })
    // The fork of a merge request can be deleted, which leaves no source project.
    expect(MergeRequestSchema.parse({ ...mrPayload, source_project_id: null })).toMatchObject({ source_project_id: null, target_project_id: 42 })
    expect(MergeRequestSchema.safeParse({ ...mrPayload, iid: '7' }).success).toBe(false)
    expect(NoteSchema.safeParse({ ...note(), system: undefined }).success).toBe(false)
  })

  it('parses merge request links with and without /-/', () => {
    for (const url of [`${WEB}/merge_requests/197`, `${WEB}/-/merge_requests/197`, `${WEB}/merge_requests/197/`,
      `${WEB}/merge_requests/197#note_12`, `${WEB}/-/merge_requests/197?tab=notes#note_12`, 'https://git.example.com:8443/acme/widgets/merge_requests/197',
      // The project path is found after any URL root, and GitLab paths do not depend on case.
      'http://git.example.com/gitlab/acme/widgets/merge_requests/197', 'http://git.example.com/gitlab/acme/widgets/-/merge_requests/197',
      'http://git.example.com/ACME/Widgets/merge_requests/197']) {
      expect(gitlabAddress(url, 'acme/widgets'), url).toEqual({ kind: 'mr', iid: 197 })
    }
    expect(gitlabAddress(`${WEB}/issues/3`, 'acme/widgets')).toEqual({ kind: 'issue', iid: 3 })
    expect(gitlabAddress(`${WEB}/-/issues/3#note_2`, 'acme/widgets')).toEqual({ kind: 'issue', iid: 3 })
    expect(gitlabAddress('http://git.example.com/acme/team/widgets/merge_requests/4', 'acme/team/widgets')).toEqual({ kind: 'mr', iid: 4 })
    // Another project, including one whose path only starts or ends like this one.
    for (const url of ['http://git.example.com/acme/gadgets/merge_requests/197', 'http://git.example.com/acme/widgets2/merge_requests/197',
      'http://git.example.com/xacme/widgets/merge_requests/197', 'http://git.example.com/widgets/merge_requests/197',
      'http://git.example.com/acme/widgets/sub/merge_requests/197', 'http://git.example.com/acme/merge_requests/197']) {
      expect(gitlabAddress(url, 'acme/widgets'), url).toBeUndefined()
    }
    // Not the page of an Issue or merge request.
    for (const url of [WEB, `${WEB}/merge_requests`, `${WEB}/merge_requests/new`, `${WEB}/merge_requests/0`, `${WEB}/merge_requests/007`,
      `${WEB}/merge_requests/1e3`, `${WEB}/merge_requests/${'9'.repeat(30)}`, `${WEB}/tree/master`, `${WEB}/pipelines/197`,
      'acme/widgets/merge_requests/197', 'javascript:alert(1)', 'ftp://git.example.com/acme/widgets/merge_requests/197', '']) {
      expect(gitlabAddress(url, 'acme/widgets'), url).toBeUndefined()
    }
  })

  it('names a merge request Thread the way the pull request rules read it', () => {
    // The Thread key the Source files Triggers under, and the one a Ticket follows, as `pulls.ts` reads it.
    const thread = `${SOURCE}:${threadIdOf({ kind: 'mr', iid: 7 })}`
    expect(thread).toBe('gitlab:mr:7')
    expect(pullNumbers({ follows: [{ thread, own: true }] })).toEqual([7])
    const trigger = noteTrigger(note(), mr, AGENT)!
    expect(threadKey(trigger.threads[0]!)).toBe(thread)
    expect(trigger.channel!.thread).toBe(thread)
    // An Issue of the same number is not a pull request.
    const issueThread = `${SOURCE}:${threadIdOf({ kind: 'issue', iid: 7 })}`
    expect(issueThread).toBe('gitlab:issue:7')
    expect(pullNumbers({ follows: [{ thread: issueThread, own: true }] })).toEqual([])
  })

  it('reports a pipeline on its own Thread, as CI with nobody to answer', () => {
    const url = `${WEB}/pipelines/31`
    const trigger = pipelineTrigger('master', 'failed', 2, url)
    expect(trigger).toMatchObject({ id: key('gitlab-pipeline', 'master', '2'), source: 'gitlab', threads: [{ source: 'gitlab', id: 'pipeline:master' }],
      actor: { source: 'gitlab', id: '' }, human: false, text: 'Pipeline on master: failed', url,
      // `ci` keeps it out of the neighbours that a Trigger's resource shows.
      meta: { ci: true, ref: 'master', status: 'failed', revision: 2 } })
    expect(trigger).not.toHaveProperty('channel')
    expect(threadKey(trigger.threads[0]!)).toBe('gitlab:pipeline:master')
    // Each reported change is its own event.
    expect(pipelineTrigger('master', 'success', 3, url).id).not.toBe(trigger.id)
    expect(pipelineTrigger('master', 'failed', 2, url).id).toBe(trigger.id)
  })
})

describe('GitLab Channel', () => {
  const MARKER = '<!-- dsh-superagent:stable-operation -->'
  const reply: OutboundMessage = { id: 'stable-operation', channel: gitlabChannel(mr, mr.url), text: 'Done', kind: 'reply' }
  const read = (path = 'merge_requests/7/notes', page = 1) => ['api', `projects/42/${path}?per_page=100&page=${page}`]
  const post = (path = 'merge_requests/7/notes') => ['api', `projects/42/${path}`, '--method', 'POST', '-f', `body=Done\n\n${MARKER}`]
  /** A note already on the Issue or merge request, as `glab api` prints it. */
  const posted = (body: string, username = AGENT) => ({ id: 99, body, system: false, author: { username }, created_at: '2026-11-01T10:00:00.000+08:00',
    updated_at: '2026-11-01T10:00:00.000+08:00' })
  /** A `Commands` whose `glab` lists `notes` on every read and accepts every post, recording each call's arguments. */
  function glab(notes: unknown[] = []) {
    const commands = new Commands(() => testGitlabDeployment(), {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => args.includes('POST') ? '{"id":100}' : JSON.stringify(notes))
    return { commands, run, calls: () => run.mock.calls.map(call => call[1]) }
  }

  it('posts a note once per message id', async () => {
    const first = glab()
    expect(await sendGitlab({ commands: first.commands }, reply)).toBe('sent')
    expect(first.calls()).toEqual([read(), post()])
    // After an outcome the sender never learned, the retry finds the note with the marker and posts nothing.
    const retry = glab([posted(`Done\n\n${MARKER}`)])
    expect(await sendGitlab({ commands: retry.commands }, reply)).toBe('sent')
    expect(retry.calls()).toEqual([read()])
    // An Issue's notes are another path.
    const onIssue = glab()
    await sendGitlab({ commands: onIssue.commands }, { ...reply, channel: gitlabChannel(issue, issue.url) })
    expect(onIssue.calls()).toEqual([read('issues/3/notes'), post('issues/3/notes')])
  })

  it('posts when the marker is not the agent\'s note for this message', async () => {
    // Another account cannot hold back a reply by quoting its marker, and another message's marker is not this one's.
    for (const existing of [posted(MARKER, 'alice'), posted('<!-- dsh-superagent:another-operation -->'), posted('Done')]) {
      const { commands, calls } = glab([existing])
      expect(await sendGitlab({ commands }, reply)).toBe('sent')
      expect(calls()).toEqual([read(), post()])
    }
    // GitLab names the agent without regard to case.
    const same = glab([posted(MARKER, 'Agent.Bot')])
    await sendGitlab({ commands: same.commands }, reply)
    expect(same.calls()).toEqual([read()])
  })

  it('looks for the marker on every page of notes', async () => {
    const commands = new Commands(() => testGitlabDeployment(), {}, new AbortController().signal)
    const full = Array.from({ length: 100 }, (_, index) => posted(`note ${index}`, 'alice'))
    const run = vi.spyOn(commands, 'run').mockImplementation(async (_program, args) =>
      JSON.stringify(args[1]!.endsWith('page=1') ? full : [posted(`Done\n\n${MARKER}`)]))
    expect(await sendGitlab({ commands }, reply)).toBe('sent')
    expect(run.mock.calls.map(call => call[1])).toEqual([read('merge_requests/7/notes', 1), read('merge_requests/7/notes', 2)])
  })

  it('answers gone for a missing noteable and throws otherwise', async () => {
    const { commands, run } = glab()
    const refused = (status: number) => commandError({ stderr: `glab: HTTP ${status}`, code: 1 })
    // Gone for good, whether the read of the notes or the post finds out.
    run.mockRejectedValueOnce(refused(410))
    expect(await sendGitlab({ commands }, reply)).toBe('gone')
    run.mockResolvedValueOnce('[]').mockRejectedValueOnce(refused(410))
    expect(await sendGitlab({ commands }, reply)).toBe('gone')
    // GitLab also answers 404 for a project the agent lost access to, so that and server errors are retried rather than dropped.
    for (const status of [404, 500, 502]) {
      run.mockRejectedValueOnce(refused(status))
      await expect(sendGitlab({ commands }, reply)).rejects.toMatchObject({ code: status, message: `glab: HTTP ${status}` })
      run.mockResolvedValueOnce('[]').mockRejectedValueOnce(refused(status))
      await expect(sendGitlab({ commands }, reply)).rejects.toMatchObject({ code: status, message: `glab: HTTP ${status}` })
    }
    // So is a failure that carries no status, and an answer that is not a list of notes.
    run.mockRejectedValueOnce(new Error('spawn glab ENOENT'))
    await expect(sendGitlab({ commands }, reply)).rejects.toThrow('spawn glab ENOENT')
    run.mockResolvedValueOnce('{"message":"401 Unauthorized"}')
    await expect(sendGitlab({ commands }, reply)).rejects.toThrow()
  })

  it('refuses an address that names no Issue or merge request', async () => {
    const { commands, run } = glab()
    const addresses: Record<string, string>[] = [{}, { kind: 'mr' }, { kind: 'mr', iid: 'x' }, { kind: 'mr', iid: '0' }, { kind: 'mr', iid: '../7' },
      { kind: 'pipeline', iid: '7' }]
    for (const address of addresses) {
      await expect(sendGitlab({ commands }, { ...reply, channel: { ...reply.channel, address } })).rejects.toThrow('Missing GitLab reply target')
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses to send when the deployment has no GitLab account', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run')
    await expect(sendGitlab({ commands }, reply)).rejects.toThrow('This installation has no GitLab account')
    expect(run).not.toHaveBeenCalled()
  })

  it('links an address to the page GitLab named, with its label', () => {
    expect(gitlabLink(gitlabChannel(mr, mr.url).address, {})).toEqual({ url: mr.url, label: { zh: 'GitLab MR !7', en: 'GitLab MR !7' } })
    expect(gitlabLink(gitlabChannel(issue, issue.url).address, {})).toEqual({ url: issue.url, label: { zh: 'GitLab Issue #3', en: 'GitLab Issue #3' } })
    // With no page to name the link is empty, not built from the instance's address or the repository.
    expect(gitlabLink(gitlabChannel(mr).address, { repository: 'acme/widgets' })).toEqual({ url: '', label: { zh: 'GitLab MR !7', en: 'GitLab MR !7' } })
    expect(gitlabChannel(mr).address).toEqual({ kind: 'mr', iid: '7' })
  })
})

/** A `SourceContext` of the GitLab deployment over a real Store and Engine; what the Engine sends is kept as receipts, not delivered. */
function host() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { gitlab: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' } }))
  const sources = new SourceRegistry(() => store.settings(), new HealthBoard())
  const deployment = testGitlabDeployment()
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const context = sourceContextOf({ store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive }, { kind: SOURCE, health: [SOURCE] })
  return { ...context, store, engine, commands, receive, executor }
}
/** A ticket that has not ended and works in a directory named `fix-login`, so `agent/fix-login` is its branch. */
const live = (id: string, overrides: Partial<Ticket> = {}): Ticket => ({ id, title: id, decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: SOURCE, id: 'alice' }, scope: '' },
  channels: [], assignments: [{ id: `a-${id}`, state: 'running', createdAt: '2026-11-01T00:00:00.000Z' }], inputs: [], undelivered: [],
  createdAt: '', updatedAt: '', execution: { name: 'fix-login', directory: '/w/fix-login', assignment: '' },
  origin: { triggerId: `source-${id}`, triggerIds: [] }, ...overrides })

describe('GitLab merge requests', () => {
  /** A merge request the agent opened from the ticket branch of `live`. */
  const agents = (iid = 7, overrides: Record<string, unknown> = {}): Mr => MergeRequestSchema.parse({ ...mrPayload, iid, author: { username: AGENT },
    web_url: `${WEB}/merge_requests/${iid}`, ...overrides })

  it('binds an MR the agent opened from the ticket branch', async () => {
    const h = host()
    h.store.tickets.save(live('t1'))
    expect(claimMr(h, 't1', agents())).toBeUndefined()
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitlab:mr:7', own: true }])
    expect(pullOf(h.store.tickets.get('t1')!)).toBe(7)
    // The Thread keeps the page GitLab named and the author, and the ticket subscribes to it.
    expect(h.store.threads.get('gitlab:mr:7')).toMatchObject({ subscriptions: ['t1'],
      meta: { iid: 7, isMr: true, url: `${WEB}/merge_requests/7`, mrAuthor: AGENT } })
    // Claiming it again changes nothing, and a poll binds the agent's MR to the one ticket on its branch.
    expect(claimMr(h, 't1', agents())).toBeUndefined()
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitlab:mr:7', own: true }])
    h.store.tickets.save(live('t2', { execution: { name: 'fix-cart', directory: '/w/fix-cart', assignment: '' } }))
    expect(await observeMr(h, agents(9, { source_branch: 'agent/fix-cart' }))).toBe(false)
    expect(h.store.tickets.get('t2')!.follows).toEqual([{ thread: 'gitlab:mr:9', own: true }])
    // The merge request the ticket started from is one it follows, though it did not open it.
    const started = noteTrigger(note(), { kind: 'mr', iid: 5, url: `${WEB}/merge_requests/5`, mrAuthor: 'carol' }, AGENT)!
    h.store.triggers.save(started)
    h.store.tickets.save(live('t3', { origin: { triggerId: started.id, triggerIds: [started.id] } }))
    expect(claimMr(h, 't3', agents(5, { author: { username: 'carol' }, source_branch: 'fix' }))).toBeUndefined()
    expect(h.store.tickets.get('t3')!.follows).toEqual([{ thread: 'gitlab:mr:5', own: false }])
    h.store.close()
  })

  it('refuses an MR from another author or branch', async () => {
    const h = host()
    h.store.tickets.save(live('t1'))
    // Another author, another branch, a fork, a fork since deleted, and a project other than the configured one.
    for (const mr of [agents(7, { author: { username: 'carol' } }), agents(7, { source_branch: 'agent/other' }), agents(7, { source_branch: 'fix-login-2' }),
      agents(7, { source_project_id: 43 }), agents(7, { source_project_id: null }), agents(7, { source_project_id: 43, target_project_id: 43 })]) {
      expect(claimMr(h, 't1', mr)).toContain('MR does not belong to this ticket: use the source MR or an MR by agent.bot')
      // A poll does not bind it to the ticket on that branch either.
      await observeMr(h, mr)
    }
    expect(pullNumbers(h.store.tickets.get('t1')!)).toEqual([])
    expect(h.store.threads.get('gitlab:mr:7')).toBeUndefined()
    // The agent is told apart by its user name without regard to case, and the ticket's branch by its last path segment.
    expect(claimMr(h, 't1', agents(8, { author: { username: 'Agent.Bot' }, source_branch: 'feature/fix-login' }))).toBeUndefined()
    // A merge request that is not open is not bound, and that is no refusal.
    expect(claimMr(h, 't1', agents(10, { state: 'closed' }))).toBeUndefined()
    expect(pullNumbers(h.store.tickets.get('t1')!)).toEqual([8])
    // A ticket that has ended follows nothing more.
    h.store.tickets.save(live('t4', { ended: { at: '2026-11-01T01:00:00.000Z', by: 'executor', outcome: 'closed' } }))
    expect(claimMr(h, 't4', agents(11))).toBe('Ticket ended because its MR was closed')
    h.store.close()
  })

  it('refuses an MR that another open ticket holds', () => {
    const h = host()
    h.store.tickets.save(live('t1'))
    h.store.tickets.save(live('t2', { follows: [{ thread: 'gitlab:mr:7', own: true }] }))
    expect(claimMr(h, 't1', agents())).toBe('MR already belongs to another active ticket')
    expect(pullNumbers(h.store.tickets.get('t1')!)).toEqual([])
    // A pull request of that number on another code host is another thing, and a ticket that ended holds nothing.
    h.store.tickets.save(live('t2', { follows: [{ thread: 'github:7', own: true }] }))
    expect(claimMr(h, 't1', agents())).toBeUndefined()
    h.store.tickets.save(live('t1', { follows: undefined }))
    h.store.tickets.save(live('t2', { follows: [{ thread: 'gitlab:mr:7', own: true }], ended: { at: '2026-11-01T01:00:00.000Z', by: 'executor', outcome: 'closed' } }))
    expect(claimMr(h, 't1', agents())).toBeUndefined()
    h.store.close()
  })

  it('ends the ticket when the MR merges', async () => {
    const h = host()
    h.store.tickets.save(live('t1', { follows: [{ thread: 'gitlab:mr:7', own: true }] }))
    // The merge time carries the instance's offset, and the ticket ends at that instant.
    expect(await observeMr(h, agents(7, { state: 'merged', merged_at: '2026-11-01T12:00:00.000+08:00' }))).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { by: 'executor', outcome: 'merged', at: '2026-11-01T04:00:00.000Z' } })
    expect(h.executor.stop).toHaveBeenCalledOnce()
    // GitLab 11.7 can send no merge time, and the last change is then the merge.
    h.store.tickets.save(live('t2', { follows: [{ thread: 'gitlab:mr:8', own: true }] }))
    expect(await observeMr(h, agents(8, { state: 'merged', merged_at: null, updated_at: '2026-11-01T05:30:00.000Z' }))).toBe(true)
    expect(h.store.tickets.get('t2')).toMatchObject({ ended: { outcome: 'merged', at: '2026-11-01T05:30:00.000Z' } })
    // A merge request closed without merging ends it as closed, at the time GitLab names or else the last change.
    h.store.tickets.save(live('t3', { follows: [{ thread: 'gitlab:mr:9', own: true }, { thread: 'gitlab:mr:10', own: true }] }))
    expect(await observeMr(h, agents(9, { state: 'closed', closed_at: '2026-11-01T06:00:00.000Z' }))).toBe(true)
    expect(h.store.tickets.get('t3')).not.toHaveProperty('ended')
    expect(await observeMr(h, agents(10, { state: 'closed', closed_at: null, updated_at: '2026-11-01T15:00:00.000+08:00' }))).toBe(true)
    expect(h.store.tickets.get('t3')).toMatchObject({ ended: { outcome: 'closed', at: '2026-11-01T07:00:00.000Z' } })
    // A merge request nobody follows ends nothing, and is still ended.
    expect(await observeMr(h, agents(11, { state: 'merged' }))).toBe(true)
    h.store.close()
  })

  it('reads a work-in-progress MR with no draft field as open', async () => {
    const h = host()
    h.store.tickets.save(live('t1'))
    // GitLab 11.7 marks a draft with `work_in_progress` and sends no `draft`: the merge request is open, and still the ticket's.
    const draft = agents(7, { work_in_progress: true })
    expect(draft).not.toHaveProperty('draft')
    expect(await observeMr(h, draft)).toBe(false)
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitlab:mr:7', own: true }])
    expect(h.store.tickets.get('t1')).not.toHaveProperty('ended')
    // One being merged is not ended yet either.
    expect(await observeMr(h, agents(7, { state: 'locked' }))).toBe(false)
    expect(h.store.tickets.get('t1')).not.toHaveProperty('ended')
    // A merge request the ticket followed until it closed, and that is open again, is followed again.
    h.store.tickets.save(live('t2', { execution: { name: 'fix-cart', directory: '/w/fix-cart', assignment: '' },
      follows: [{ thread: 'gitlab:mr:8', own: true, closed: { at: '2026-11-01T02:00:00.000Z', outcome: 'closed' } }] }))
    await observeMr(h, agents(8, { source_branch: 'agent/fix-cart' }))
    expect(h.store.tickets.get('t2')!.follows).toEqual([{ thread: 'gitlab:mr:8', own: true }])
    h.store.close()
  })

  it('words the end notice as an MR with its web_url', () => {
    const h = host()
    const feishu = { source: 'feishu', thread: 'feishu:oc_1:om_1', address: { chatId: 'oc_1', messageId: 'om_1' } }
    const ended = (outcome: 'merged' | 'closed', overrides: Partial<Ticket> = {}): Ticket => live('t1', { channels: [feishu, gitlabChannel(mr, mr.url)],
      follows: [{ thread: 'gitlab:mr:7', own: true, closed: { at: '2026-11-01T04:00:00.000Z', outcome } }],
      ended: { at: '2026-11-01T04:00:00.000Z', by: 'executor', outcome }, ...overrides })
    // The page is the one GitLab named, which the Thread recorded; it is never built from the project's address.
    h.store.threads.save({ key: 'gitlab:mr:7', ref: { source: SOURCE, id: 'mr:7' }, createdAt: '', subscriptions: ['t1'], correlated: [], pending: [],
      meta: { url: `${WEB}/merge_requests/7` } })
    const pulls = gitlabPullHost(h)
    const link = `[MR !7](${WEB}/merge_requests/7)`
    // A request in Chinese gets the notice in Chinese, and only chat conversations get it: a GitLab one shows the merge itself.
    expect(pulls.endNotices(ended('merged'), '修一下登录')).toEqual([{ id: expect.any(String), channel: feishu, text: `${link} 已合并。`, kind: 'notice',
      ticketId: 't1' }])
    expect(pulls.endNotices(ended('closed'), '修一下登录')[0]!.text).toBe(`${link} 已关闭，未合并。`)
    expect(pulls.endNotices(ended('merged'), 'fix the login')[0]!.text).toBe(`${link} has merged.`)
    expect(pulls.endNotices(ended('closed'), 'ログインを直して (login)')[0]!.text).toBe(`${link} was closed without merging.`)
    // Each notice has an id of its own, the same one every time.
    const notice = pulls.endNotices(ended('merged'), 'fix')[0]!
    expect(pulls.endNotices(ended('merged'), 'fix')[0]!.id).toBe(notice.id)
    expect(pulls.endNotices(ended('closed'), 'fix')[0]!.id).not.toBe(notice.id)
    // The merge request the ticket opened last is named; a Thread with no recorded page is named without a link.
    const two = ended('merged', { follows: [{ thread: 'gitlab:mr:7', own: true, closed: { at: '2026-11-01T03:00:00.000Z', outcome: 'closed' } },
      { thread: 'gitlab:mr:8', own: true, closed: { at: '2026-11-01T04:00:00.000Z', outcome: 'merged' } }] })
    expect(pulls.endNotices(two, 'fix')[0]!.text).toBe('MR !8 has merged.')
    expect(mrEndNotices(two, 'fix', iid => `${WEB}/merge_requests/${iid}`)[0]!.text).toBe(`[MR !8](${WEB}/merge_requests/8) has merged.`)
    // A ticket that is still open, ended otherwise, or followed no merge request has no notice.
    expect(pulls.endNotices(live('t1', { channels: [feishu] }), 'fix')).toEqual([])
    expect(pulls.endNotices(ended('merged', { ended: { at: '2026-11-01T04:00:00.000Z', by: 'human', outcome: 'stopped' } }), 'fix')).toEqual([])
    expect(pulls.endNotices(ended('merged', { follows: [{ thread: 'gitlab:issue:3', own: true, closed: { at: '2026-11-01T04:00:00.000Z', outcome: 'merged' } }] }), 'fix')).toEqual([])
    h.store.close()
  })

  it('reads and binds the merge request the agent reports, and names the agent for the tools', async () => {
    const h = host()
    h.store.tickets.save(live('t1'))
    const run = vi.spyOn(h.commands, 'run').mockResolvedValue(JSON.stringify(agents(7, { description: 'x' })))
    const pulls = gitlabPullHost(h)
    expect(pulls.agent).toBe(AGENT)
    // The merge request is read through the project's API before the transaction that binds it.
    const claim = await pulls.prepare(7)
    expect(run.mock.calls.map(call => call[1])).toEqual([['api', 'projects/42/merge_requests/7']])
    expect(pullNumbers(h.store.tickets.get('t1')!)).toEqual([])
    expect(claim('t1')).toBeUndefined()
    expect(pullOf(h.store.tickets.get('t1')!)).toBe(7)
    // What GitLab sends that is no merge request fails the read, and so does a failure of the command.
    run.mockResolvedValueOnce('{"message":"404 Not found"}')
    await expect(pulls.prepare(8)).rejects.toThrow()
    run.mockRejectedValueOnce(commandError({ stderr: 'glab: HTTP 404', code: 1 }))
    await expect(pulls.prepare(8)).rejects.toMatchObject({ code: 404 })
    // A deployment with no GitLab account has no merge requests.
    expect(() => gitlabPullHost({ ...h, deployment: testDeployment() })).toThrow('This installation has no GitLab account')
    h.store.close()
  })
})

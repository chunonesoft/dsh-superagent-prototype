/** GitLab source kind definition, Todo and project polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Thread } from '../core/index.ts'
import { GitlabAccountsSchema, gitlabOf } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { observeMr, readMr, type Mr } from './gitlab-mr.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import { IssueSchema, NoteSchema, SOURCE, noteTrigger, openedTrigger, pipelineTrigger, threadIdOf, type GitlabNote, type GitlabRef } from './gitlab-trigger.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollFailure, pollThreads as pollEach } from './poll.ts'
import { pullNumbers } from './pulls.ts'

const GitlabConfigSchema = GitlabAccountsSchema.extend({ pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observeMergeRequests: z.boolean().default(false), observeNotes: z.boolean().default(false),
  observePipelines: z.boolean().default(false) }).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', mergeRequests: 'observeMergeRequests', notes: 'observeNotes', pipelines: 'observePipelines' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return typeof meta.ref === 'string' ? 'pipelines' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mr') return 'mergeRequests'
  return meta.kind === 'note' ? 'notes' : undefined
}
/** A commit email as a worker's environment may carry it: the instance reports it and a worker's shell reads it, so only a plain address passes. */
const PLAIN_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/
const numberOf = (value: unknown): number => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0

export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体在自托管 GitLab 上的账号；接收项目里发给它的待办、已订阅 Issue 与合并请求的讨论、默认分支的流水线变化和合并请求的合并关闭。', en: 'The agent\'s account on a self-hosted GitLab; receives the Todos sent to it in the project, discussion on subscribed Issues and merge requests, pipeline changes of the default branch, and merge request merge or close.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(/[A-Za-z0-9_.\\-]+)+', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 namespace/project（可以有子组）。这个来源接收这个项目的待办和讨论；保存时检查智能体账号能否推送到它，然后重启 dsh-superagent。一个部署只处理一个仓库，不能同时设置 GitHub 来源。', en: 'Written namespace/project, with any subgroups. This Source receives the project\'s Todos and discussion; saving checks that the agent account can push to it, then restarts dsh-superagent. An installation works on one repository, so the GitHub Source cannot be set as well.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GLAB_CONFIG_DIR 登录智能体账号的 glab 包装脚本。智能体以它登录的账号行事，执行器以 glab 调用它，而且只用 glab api。保存时检查它登录的账号能否推送到项目，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account through GLAB_CONFIG_DIR. The agent acts as the account it is signed in to, and the Executor calls it as glab, only as glab api. Saving checks that this account can push to the project, then restarts dsh-superagent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' }, hint: { zh: '每轮读一次待办、已订阅的讨论和打开的开关；太短会给 GitLab 添负担。', en: 'Each round reads the Todos, the subscribed discussions and whatever is switched on; too short an interval loads GitLab.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' }, hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收项目里的新合并请求', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新合并请求也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeNotes', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive notes in the project' },
      hint: { zh: '打开后，最近有更新的 Issue 和合并请求上没有 @ 智能体的评论也会收到（GitLab 没有项目级的评论接口，所以逐个读），由策略的接收表决定是否成为候选。', en: 'Notes on recently updated Issues and merge requests that do not mention the agent are received too, read one by one because GitLab has no project-wide notes list, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observePipelines', type: 'switch', label: { zh: '接收默认分支的流水线', en: 'Receive the default branch\'s pipelines' },
      hint: { zh: '打开后，默认分支的流水线结果（成功、失败、取消）变化时会收到，由策略的接收表决定是否成为候选。第一次只记下现状。', en: 'A change in the result of the default branch\'s pipeline (success, failure or cancellation) is received, and the Policy\'s admission table decides whether it becomes a candidate. The first look only records where it stands.' } }],
  // What the Source observes across the project it receives in full; elsewhere, only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: [SOURCE],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  // `#3` names an Issue, `!7` a merge request, a bare number either, and the page of either, of any project, its Thread.
  find: query => {
    const text = query.trim()
    const thread = (kind: GitlabRef['kind'], iid: string) => `${SOURCE}:${threadIdOf({ kind, iid: Number(iid) })}`
    const page = /\/(issues|merge_requests)\/([1-9]\d*)(?:[/?#]|$)/.exec(text)
    if (page) return { threads: [thread(page[1] === 'issues' ? 'issue' : 'mr', page[2]!)], terms: [] }
    const number = /^([#!]?)([1-9]\d*)$/.exec(text)
    if (!number) return { threads: [], terms: [] }
    const [, mark = '', iid = ''] = number
    return { threads: [...mark === '!' ? [] : [thread('issue', iid)], ...mark === '#' ? [] : [thread('mr', iid)]], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue、合并请求或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue, a merge request or a note.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: Localized) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('mergeRequests', { zh: '新合并请求', en: 'New merge requests' }),
        row('notes', { zh: '评论', en: 'Notes' }),
        // A pipeline has no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'pipelines', label: { zh: '默认分支的流水线', en: 'Default branch pipelines' }, note: config.observePipelines ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observePipelines } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的项目，namespace/project。智能体在这里开的合并请求，源分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单', en: 'The project this Source watches, as namespace/project. A merge request the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录，所有 GitLab 操作都只用 glab api，不用其他账号或凭据', en: 'The agent\'s GitLab account. glab is signed in to it; use only glab api for every GitLab operation, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 Issue 或合并请求的编号；工单不是从 GitLab 来的时为空', en: 'Number (iid) of the Issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接下工单的合并请求的 head 引用 refs/merge-requests/<编号>/head；不是合并请求时为空', en: 'Head ref refs/merge-requests/<iid>/head of the merge request that started the ticket; empty when it was not a merge request' } },
    ],
    values: ({ deployment, trigger }): Record<string, string> => {
      const { gitlab } = deployment
      // Without a GitLab account every variable stays empty.
      if (!gitlab) return {}
      const iid = trigger?.threads[0]?.source === SOURCE ? numberOf(trigger.meta.iid) : 0
      return { DSH_SUPERAGENT_GITLAB_PROJECT: gitlab.project, DSH_SUPERAGENT_GITLAB_ACCOUNT: gitlab.login,
        DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: PLAIN_EMAIL.test(gitlab.email) ? gitlab.email : '', DSH_SUPERAGENT_GITLAB_IID: iid ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_MR_HEAD: iid && trigger?.meta.isMr === true ? `refs/merge-requests/${iid}/head` : '' }
    },
    // Only an installation that works on GitLab has these; the others would see them empty.
    applies: deployment => !!deployment.gitlab,
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
  } : {},
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  // A deployment that only chat Sources or GitHub run has no GitLab account to poll as.
  if (!ctx.deployment.gitlab) { ctx.report(SOURCE, health('paused', 'sourceUnset')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) await pollRound(ctx, signal)
      else ctx.report(SOURCE, health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report(SOURCE, failed)
    }
    await pause((ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}

/** An Issue or a merge request of the project, which a Thread of the Source is. */
type Subject = Pick<GitlabRef, 'kind' | 'iid'>
interface Round {
  started: string; signal?: AbortSignal | undefined
  merges: Map<number, Promise<Mr>>; read: Set<string>; failures: string[]; dropped: string[]
  tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, merges: new Map(), read: new Set(),
  failures: [], dropped: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
const STOPPED = 'The GitLab Source stopped during the poll'
/** The later of two instants; GitLab's timestamps mix offsets (`+08:00` and `Z`), so none are compared as strings. */
const later = (a: string, b: string): string => Date.parse(a) >= Date.parse(b) || Number.isNaN(Date.parse(b)) ? a : b
/** True when GitLab answers HTTP 410 (Gone); 404 is retried because it can indicate lost access to a private project. */
const deleted = (error: unknown): boolean => error instanceof CliError && error.code === 410
/** The Issue or merge request a Thread id names, such as `mr:7`. */
function subjectOf(id: string): Subject | undefined {
  const match = /^(issue|mr):([1-9]\d*)$/.exec(id)
  return match ? { kind: match[1] as Subject['kind'], iid: Number(match[2]) } : undefined
}
/** Records a failed read on the Thread and in the round; a deleted (410) Thread does not fail the round. */
function failed(ctx: SourceContext, round: Round, thread: string, error: unknown): void {
  if (deleted(error)) round.dropped.push(thread)
  else round.failures.push(`${thread}: ${String(error)}`)
  ctx.threads.patch(`${SOURCE}:${thread}`, { pollError: String(error) })
}

const PipelineSchema = z.looseObject({ status: z.string(), web_url: z.string().nullish() })
/** What a Todo of the agent gives that locates a Thread: its project and the Issue or merge request it is on. */
const TodoSchema = z.looseObject({
  project: z.looseObject({ id: z.number() }).nullish(), target_type: z.string(), created_at: z.string(),
  target: z.looseObject({ iid: z.number().optional(), project_id: z.number().nullish() }).nullish(),
})
type Todo = z.infer<typeof TodoSchema>
const TARGET_KINDS = new Map<string, Subject['kind']>([['Issue', 'issue'], ['MergeRequest', 'mr']])
/** The Todos of the project that are new since `since`, newest first. GitLab has no filter by time, so pages are read until one reaches back before it. */
async function pendingTodos(ctx: SourceContext, round: Round, since: string): Promise<Todo[]> {
  const commands = ctx.commands.withSignal(round.signal)
  const { projectId } = gitlabOf(ctx.deployment)
  const found: Todo[] = []
  for (let page = 1; ; page++) {
    const listed = await commands.gitlabAccount(z.array(z.unknown()), `todos?project_id=${projectId}&state=pending&per_page=100&page=${page}`)
    const todos = validItems(TodoSchema, listed, round.tally)
    found.push(...todos.filter(todo => Date.parse(todo.created_at) >= Date.parse(since)))
    if (listed.length < 100 || todos.some(todo => Date.parse(todo.created_at) < Date.parse(since))) return found
  }
}
/**
 * Reads the Issues and merge requests the agent's pending Todos name, oldest Todo first and each Thread once. A Todo only locates its
 * Thread, whose Triggers come from its notes, so nothing depends on the note a Todo links to; Todos are never marked done, which would
 * change the account's state, so their `created_at` is the cursor. The cursor moves once every Thread was read, and stays when the round
 * is cut short or a read fails, so the same Todos are read again, whose Triggers intake takes for duplicates.
 * @returns the number of new Todos.
 */
async function pollTodos(ctx: SourceContext, round: Round): Promise<number> {
  const { state } = ctx
  const { projectId } = gitlabOf(ctx.deployment)
  const stored = state.get(KV.gitlab.since)
  const since = later(stored ?? round.started, new Date(Date.parse(round.started) - POLL_HORIZON_MS).toISOString())
  if (stored === undefined) state.set(KV.gitlab.since, since)
  const todos = await pendingTodos(ctx, round, since)
  // A Todo of another project, or of a commit, names no Thread of this one.
  const threads = new Map<string, Subject>()
  for (const todo of todos.reverse()) {
    const kind = TARGET_KINDS.get(todo.target_type), iid = todo.target?.iid
    if (!kind || iid === undefined || (todo.project?.id ?? todo.target?.project_id) !== projectId) continue
    threads.set(threadIdOf({ kind, iid }), { kind, iid })
  }
  let complete = true
  for (const [id, subject] of threads) {
    if (stopped(ctx, round)) return todos.length
    const cursor = state.get(KV.gitlab.cursor(id))
    try { await readThread(ctx, round, subject, cursor ? later(cursor, since) : since) }
    catch (error) {
      if (stopped(ctx, round)) return todos.length
      failed(ctx, round, id, error)
      if (!deleted(error)) complete = false
    }
  }
  if (complete) state.set(KV.gitlab.since, cursorAt(round.started))
  return todos.length
}

/** Reads and observes a merge request at most once per polling round. */
function mergeRequest(ctx: SourceContext, round: Round, iid: number): Promise<Mr> {
  let read = round.merges.get(iid)
  if (!read) {
    read = readMr(ctx, iid, round.signal).then(async mr => { await observeMr(ctx, mr); return mr })
    round.merges.set(iid, read)
  }
  return read
}
/** The notes of an Issue or merge request changed since `since`, oldest first; they are read newest first, page by page, until one reaches back before it. */
async function notesSince(ctx: SourceContext, round: Round, subject: Subject, since: string): Promise<GitlabNote[]> {
  const commands = ctx.commands.withSignal(round.signal)
  const path = `${subject.kind === 'mr' ? 'merge_requests' : 'issues'}/${subject.iid}/notes`
  const found: GitlabNote[] = []
  for (let page = 1; ; page++) {
    const listed = await commands.gitlab(z.array(z.unknown()), `${path}?order_by=updated_at&sort=desc&per_page=100&page=${page}`)
    const notes = validItems(NoteSchema, listed, round.tally)
    found.push(...notes.filter(note => Date.parse(note.updated_at) >= Date.parse(since)))
    if (listed.length < 100 || notes.some(note => Date.parse(note.updated_at) < Date.parse(since))) return found.reverse()
  }
}
function nameThread(ctx: SourceContext, ref: GitlabRef, title: string): void {
  const thread = `${SOURCE}:${threadIdOf(ref)}`
  const number = `${ref.kind === 'mr' ? '!' : '#'}${ref.iid}`
  ctx.threads.patch(thread, { title })
  ctx.threads.describe(thread, { label: `${number} ${title}`, ...ref.url ? { url: ref.url } : {}, facts: { number: { value: number } } })
}
/**
 * Reads an Issue or merge request, the notes changed since `since`, and, for a merge request, its state, then moves the Thread's cursor.
 * An Issue or merge request opened since by someone other than the agent brings its description so a mention in it reaches the gate; a
 * mention added by a later edit is not read, because only the author can be the actor of the description.
 */
async function readThread(ctx: SourceContext, round: Round, subject: Subject, since: string): Promise<void> {
  const id = threadIdOf(subject)
  const { login } = gitlabOf(ctx.deployment)
  round.read.add(id)
  const merge = subject.kind === 'mr' ? await mergeRequest(ctx, round, subject.iid) : undefined
  const item = merge ?? await ctx.commands.withSignal(round.signal).gitlab(IssueSchema, `issues/${subject.iid}`)
  const ref: GitlabRef = { ...subject, url: item.web_url, ...merge ? { mrAuthor: merge.author.username } : {} }
  if (stopped(ctx, round)) throw new Error(STOPPED)
  if (Date.parse(item.created_at) >= Date.parse(since) && !sameName(item.author.username, login)) await ctx.receive(openedTrigger(item, ref, login))
  for (const note of await notesSince(ctx, round, subject, since)) {
    // Stopping mid-read throws so the thread's cursor stays where it was.
    if (stopped(ctx, round)) throw new Error(STOPPED)
    const trigger = noteTrigger(note, ref, login)
    if (trigger?.text) await ctx.receive(trigger)
  }
  nameThread(ctx, ref, item.title)
  ctx.state.set(KV.gitlab.cursor(id), cursorAt(round.started))
  ctx.threads.patch(`${SOURCE}:${id}`, { pollError: undefined })
}

/**
 * Project-wide event streams. GitLab has no project-wide list of notes, so those are read from the recently updated Issues and merge
 * requests: each of those lists, and each Thread's notes, are read since the stream's cursor.
 */
const STREAMS = [
  { id: 'issues', observed: (config: GitlabConfig) => config.observeIssues, path: 'issues', by: 'created_at', after: 'created_after' },
  { id: 'merge-requests', observed: (config: GitlabConfig) => config.observeMergeRequests, path: 'merge_requests', by: 'created_at', after: 'created_after' },
  { id: 'issue-notes', observed: (config: GitlabConfig) => config.observeNotes, path: 'issues', by: 'updated_at', after: 'updated_after' },
  { id: 'merge-request-notes', observed: (config: GitlabConfig) => config.observeNotes, path: 'merge_requests', by: 'updated_at', after: 'updated_after' },
] as const
/**
 * Polls the project-wide streams and the default branch's pipeline; each stream reads from when it was switched on, resets when switched
 * off, and fails independently. When a stream is read, an Issue or merge request created (or, for notes, updated) before its cursor is
 * ignored even if GitLab returns it, as an old version that ignores the filter would.
 */
async function pollProject(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  for (const stream of STREAMS) {
    if (stopped(ctx, round)) return
    if (!stream.observed(config)) { ctx.state.set(KV.gitlab.stream(stream.id), undefined); continue }
    try { await readStream(ctx, round, stream) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${stream.id}: ${String(error)}`) }
  }
  // When pipeline observation is turned off, forget the status but keep the revision counter so future triggers have unique IDs.
  if (!config.observePipelines) {
    for (const name of ctx.state.keys(KV.gitlab.pipeline)) {
      const seen = ctx.state.get(name)
      if (seen?.status !== undefined) ctx.state.set(name, { revision: seen.revision })
    }
    return
  }
  try { await pollPipelines(ctx, round) }
  catch (error) { if (!stopped(ctx, round)) round.failures.push(`pipelines: ${String(error)}`) }
}
/**
 * Polls one stream (oldest first) since its cursor and steps the cursor to five seconds before the newest item, relying on Trigger ID
 * deduplication so repeated messages are no-ops. Items from before their kind was switched on or beyond the horizon are ignored.
 */
async function readStream(ctx: SourceContext, round: Round, stream: typeof STREAMS[number]): Promise<void> {
  const name = KV.gitlab.stream(stream.id)
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const since = new Date(Math.max(Date.parse(ctx.state.get(name)?.since ?? round.started), horizon)).toISOString()
  const commands = ctx.commands.withSignal(round.signal)
  const { login } = gitlabOf(ctx.deployment)
  const kind: Subject['kind'] = stream.path === 'issues' ? 'issue' : 'mr'
  const listed = `${stream.path}?state=all&order_by=${stream.by}&sort=asc&${stream.after}=${encodeURIComponent(since)}&per_page=100`
  const items = validItems(IssueSchema, await commands.gitlab(z.array(z.unknown()), listed), round.tally)
  for (const item of items) {
    // Stopping mid-stream aborts before advancing the cursor so unread items are retried.
    if (stopped(ctx, round)) throw new Error(STOPPED)
    const ref: GitlabRef = { kind, iid: item.iid, url: item.web_url, ...kind === 'mr' ? { mrAuthor: item.author.username } : {} }
    if (stream.by === 'created_at') {
      if (Date.parse(item.created_at) >= Date.parse(since) && !sameName(item.author.username, login)) await ctx.receive(openedTrigger(item, ref, login))
      nameThread(ctx, ref, item.title)
      continue
    }
    for (const note of await notesSince(ctx, round, ref, since)) {
      if (stopped(ctx, round)) throw new Error(STOPPED)
      const trigger = noteTrigger(note, ref, login)
      if (trigger?.text) await ctx.receive(trigger)
    }
  }
  const newest = Math.max(...items.map(item => Date.parse((stream.by === 'created_at' ? item.created_at : item.updated_at) ?? '')).filter(Number.isFinite))
  const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
  ctx.state.set(name, { since: Date.parse(moved) > Date.parse(since) ? moved : since })
}

/** A branch name as a Trigger may carry it to a model: GitLab sends it, so only the plain characters of ordinary names pass. */
const PLAIN_REF = /^[A-Za-z0-9._/-]{1,200}$/
/** The statuses of a pipeline that are a result; one still running, or that was skipped or waits for a person, changes nothing. */
const FINISHED = new Set(['success', 'failed', 'canceled'])
/** Polls the default branch's latest pipeline, emitting a trigger only when its finished status changes after the initial baseline. */
async function pollPipelines(ctx: SourceContext, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const { default_branch: branch } = await commands.gitlab(z.looseObject({ default_branch: z.string().nullish() }), '')
  // An empty project has no default branch, and no pipeline.
  if (!branch || !PLAIN_REF.test(branch)) return
  const [latest] = validItems(PipelineSchema, await commands.gitlab(z.array(z.unknown()), `pipelines?ref=${encodeURIComponent(branch)}&order_by=id&sort=desc&per_page=1`), round.tally)
  if (!latest || !FINISHED.has(latest.status)) return
  const name = KV.gitlab.pipeline(branch)
  const previous = ctx.state.get(name)
  // The first look after switching on, or after the default branch was renamed, establishes the baseline.
  if (previous?.status === undefined) { ctx.state.set(name, { status: latest.status, revision: previous?.revision ?? 0 }); return }
  if (previous.status === latest.status) return
  const revision = previous.revision + 1
  await ctx.receive(pipelineTrigger(branch, latest.status, revision, latest.web_url ?? ''))
  ctx.state.set(name, { status: latest.status, revision })
}

/** Polls the merge requests of open tickets, which ends a ticket whose merge request merged or closed, and binds the agent's merge request on a ticket's branch. */
export async function pollTicketMrs(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  // A ticket from before the installation moved from GitHub may still follow pull requests, which are no merge requests of this project.
  const iids = [...new Set(ctx.tickets.open().flatMap(ticket =>
    pullNumbers({ follows: ticket.follows?.filter(item => item.thread.startsWith(`${SOURCE}:`)) }, true)))]
  for (const iid of iids) {
    if (stopped(ctx, round)) return
    try { await mergeRequest(ctx, round, iid) }
    catch (error) { if (!stopped(ctx, round)) failed(ctx, round, threadIdOf({ kind: 'mr', iid }), error) }
  }
}
/** Polls subscribed Issue and merge request Threads not already read in this round; a deleted (410) one is still polled within the horizon (costing one read) and does not fail the round. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      if (deleted(error)) round.dropped.push(thread.ref.id); else round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(thread.ref.id))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  // The default branch's pipelines have no Issue or merge request to read; they arrive as Triggers.
  if (thread.ref.id.startsWith('pipeline:')) return
  const subject = subjectOf(thread.ref.id)
  if (!subject) throw new Error('Subscribed thread has no GitLab Issue or merge request number')
  await readThread(ctx, round, subject, ctx.state.get(KV.gitlab.cursor(thread.ref.id)) ?? thread.createdAt)
}

/**
 * One polling round: the Todos of the agent, then the observed project streams and the default branch's pipeline, then the merge
 * requests of open tickets, then subscribed Threads. Each step and each Issue, merge request, or Thread fails independently so all
 * steps run before the round fails. Other read failures (including 404) fail the round toward the error threshold, whereas deleted
 * (410) Threads are recorded only on the thread and in health detail.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const round = newRound(signal)
  const todos = await pollTodos(ctx, round).then(count => ({ count }), (error: unknown) => ({ error }))
  await pollProject(ctx, round)
  await pollTicketMrs(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  if ('error' in todos) throw todos.error
  if (signal?.aborted) return
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const dropped = round.dropped.length ? `; deleted on GitLab: ${[...new Set(round.dropped)].join(', ')}` : ''
  const skipped = round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''
  ctx.report(SOURCE, { state: 'ready', detail: `${todos.count} todos${dropped}${skipped}`, at: round.started })
}

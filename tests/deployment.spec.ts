import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Setup } from '../src/app/setup.ts'
import { Config, executable, machineOf, resolveDeployment, resolveDingtalkBot, resolveFeishuBot, resolveGitlab, sourcesSet, type Machine, type Probe } from '../src/deployment.ts'
import { workerGitConfig } from '../src/infra/environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { gitEnv, subprocess } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
/** The account and project as GitLab 11.7 answers: `web_url` without `/-/`, an email but no `commit_email`, and either `permissions` entry null. */
const gitlabUser = { id: 3, username: 'agent.bot', name: 'Agent Bot', state: 'active', web_url: 'http://git.example.com/agent.bot', email: 'agent@example.com' }
const accessOf = (access_level: number) => ({ access_level, notification_level: 3 })
const gitlabProject = (permissions: object = { project_access: accessOf(40), group_access: null }) =>
  ({ id: 42, path_with_namespace: 'acme/widgets', web_url: 'http://git.example.com/acme/widgets', default_branch: 'master', permissions })
/** Fake glab CLI answering `api user` with `user`, and `api projects/…` for acme/widgets (including its former path acme/gadgets) with `project`. */
const glab = (file: string, user: object = gitlabUser, project: object = gitlabProject()): string =>
  program(file, `case "$*" in\n  "api user") echo '${JSON.stringify(user)}' ;;\n  "api projects/acme%2F"*) echo '${JSON.stringify(project)}' ;;\n  *) exit 1 ;;\nesac`)
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
/** Fake dingtalk-bot CLI answering `auth status` with `status`, as the real one prints it once a token can be had. */
const dingtalkBot = (file: string, status: object = { clientId: 'ding123', robotCode: 'ding123', token: 'ok' }): string =>
  program(file, `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  *) exit 1 ;;\nesac`)
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  glab(join(dir, 'bin', 'glab'))
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  dingtalkBot(join(dir, 'bin', 'dingtalk-bot'))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  program(join(dir, 'state', 'worker-bin', 'glab'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'exit 1') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('resolves a GitLab account from the project web_url', async () => {
    const resolve = (project = 'acme/widgets') => resolveGitlab(machine(), { project, cli: 'glab' }, probe, path)
    expect(await resolve()).toEqual({ cli: join(dir, 'bin', 'glab'), login: 'agent.bot', email: 'agent@example.com', project: 'acme/widgets', projectId: 42,
      webUrl: 'http://git.example.com/acme/widgets', origin: 'http://git.example.com', defaultBranch: 'master' })
    // The project is the name GitLab returns, as GitHub's full_name is, so a project moved from its old path still matches.
    expect((await resolve('acme/gadgets')).project).toBe('acme/widgets')
    // The origin is scheme, host and port of web_url, nothing of its path; a project with no commit yet has no default branch.
    glab(join(dir, 'bin', 'glab'), gitlabUser, { ...gitlabProject(), web_url: 'https://git.example.com:8443/acme/widgets', default_branch: null })
    expect(await resolve()).toMatchObject({ origin: 'https://git.example.com:8443', webUrl: 'https://git.example.com:8443/acme/widgets', defaultBranch: '' })
  })
  it('takes the commit email the instance reports, and the account email when it reports none', async () => {
    const emailOf = async (user: object) => {
      glab(join(dir, 'bin', 'glab'), { ...gitlabUser, ...user })
      return (await resolveGitlab(machine(), { project: 'acme/widgets', cli: 'glab' }, probe, path)).email
    }
    expect(await emailOf({ commit_email: 'agent@users.noreply.example.com' })).toBe('agent@users.noreply.example.com')
    expect(await emailOf({ email: null, commit_email: 'agent@users.noreply.example.com' })).toBe('agent@users.noreply.example.com')
    // An instance as old as 11.7 reports no commit_email; another may report it empty or null.
    for (const user of [{}, { commit_email: '' }, { commit_email: null }]) expect(await emailOf(user)).toBe('agent@example.com')
  })
  it('takes push access from the greater of project and group access', async () => {
    const resolve = (permissions?: object) => {
      glab(join(dir, 'bin', 'glab'), gitlabUser, { ...gitlabProject(), permissions })
      return resolveGitlab(machine(), { project: 'acme/widgets', cli: 'glab' }, probe, path)
    }
    // Either entry may be null: the group's access grants what the project's does not.
    await expect(resolve({ project_access: null, group_access: accessOf(30) })).resolves.toMatchObject({ login: 'agent.bot' })
    await expect(resolve({ project_access: accessOf(40), group_access: accessOf(10) })).resolves.toMatchObject({ login: 'agent.bot' })
    const readOnly = setupError('gitlab', 'gitlabReadOnly', { account: 'agent.bot', project: 'acme/widgets' })
    await expect(resolve({ project_access: accessOf(20), group_access: accessOf(20) })).rejects.toEqual(readOnly)
    // An account that only sees the project, or an answer that reports no permissions, has no access to push with.
    await expect(resolve({ project_access: null, group_access: null })).rejects.toEqual(readOnly)
    await expect(resolve()).rejects.toEqual(readOnly)
  })
  it('names what GitLab setup needs and where it is set', async () => {
    const needs = (code: string, values: Record<string, unknown>, gitlab: unknown) =>
      expect(resolveGitlab(machine(), gitlab, probe, path)).rejects.toEqual(setupError('gitlab', code, values))
    const project = 'acme/widgets'
    await needs('gitlabProjectUnset', {}, { cli: 'glab' })
    await needs('gitlabCliUnset', {}, { project })
    await needs('gitlabCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { project, cli: join(dir, 'missing') })
    await needs('gitlabCliMissing', { output: 'bin/glab must be a command name or an absolute path' }, { project, cli: 'bin/glab' })
    // Signed out: the CLI fails, prints no JSON, or prints an account that has no login or no email to commit with.
    const rejected = program(join(dir, 'bin', 'glab-signed-out'), `echo 'glab: 401 Unauthorized (HTTP 401)' >&2; exit 1`)
    await needs('gitlabSignedOut', { output: expect.stringContaining('HTTP 401') }, { project, cli: rejected })
    await needs('gitlabSignedOut', {}, { project, cli: program(join(dir, 'bin', 'glab-login-page'), `echo '<html>Sign in</html>'`) })
    await needs('gitlabSignedOut', {}, { project, cli: glab(join(dir, 'bin', 'glab-nameless'), { id: 3, email: 'agent@example.com' }) })
    for (const email of [undefined, null, '']) {
      await needs('gitlabSignedOut', {}, { project, cli: glab(join(dir, 'bin', 'glab-emailless'), { id: 3, username: 'agent.bot', email, commit_email: email }) })
    }
    // Signed in, but the account cannot read the project (the instance answers 404 for what an account may not see), or its answer is no project.
    const outsider = program(join(dir, 'bin', 'glab-outsider'),
      `case "$*" in\n  "api user") echo '${JSON.stringify(gitlabUser)}' ;;\n  *) echo 'glab: 404 Project Not Found (HTTP 404)' >&2; exit 1 ;;\nesac`)
    const unreadable = { account: 'agent.bot', project: 'acme/widgets' }
    await needs('gitlabProjectUnreadable', { ...unreadable, output: expect.stringContaining('HTTP 404') }, { project, cli: outsider })
    await needs('gitlabProjectUnreadable', unreadable, { project, cli: glab(join(dir, 'bin', 'glab-empty'), gitlabUser, {}) })
    // web_url must be an http or https address, because the origin it gives is what git credentials are keyed by.
    for (const web_url of ['not a url', 'ftp://git.example.com/acme/widgets', 'git@git.example.com:acme/widgets']) {
      await needs('gitlabProjectUnreadable', unreadable, { project, cli: glab(join(dir, 'bin', 'glab-address'), gitlabUser, { ...gitlabProject(), web_url }) })
    }
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})

describe('DingTalk bot', () => {
  it('treats only a working bot CLI as set up', async () => {
    // A DingTalk Source that names no CLI is no bot, and one that names a working CLI is the bot its `auth status` reports.
    expect(await resolveDingtalkBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveDingtalkBot(machine(), { cli: 'dingtalk-bot' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'dingtalk-bot'), clientId: 'ding123', robotCode: 'ding123' })
    expect(sourcesSet(settingsOf({ dingtalk: { cli: 'dingtalk-bot' } }, false)).dingtalk).toBe(true)
    const refuses = async (code: string, values: Record<string, unknown> = {}, cli = 'dingtalk-bot') =>
      expect(resolveDingtalkBot(machine(), { cli }, probe, path)).rejects.toEqual(setupError('dingtalk', code, values))
    // Output that does not name the app and robot, or whose token is not ok, is not a bot.
    dingtalkBot(join(dir, 'bin', 'dingtalk-bot'), { clientId: 'ding123' })
    await refuses('dingtalkNoApp')
    dingtalkBot(join(dir, 'bin', 'dingtalk-bot'), { clientId: 'ding123', robotCode: 'ding123', token: 'expired' })
    await refuses('dingtalkNoApp')
    program(join(dir, 'bin', 'dingtalk-bot'), 'echo "No configuration found." >&2; exit 1')
    await refuses('dingtalkCliFailed', { output: expect.stringContaining('No configuration found.') })
    await refuses('dingtalkCliFailed', { output: expect.stringContaining('is not an executable file') }, join(dir, 'bin', 'missing'))
  })
})

/** Settings whose Sources hold `config`, by Source ID. */
const settingsOf = (config: Record<string, Record<string, unknown>>, enabled = true) =>
  SettingsSchema.parse({ sources: Object.fromEntries(Object.entries(config).map(([id, value]) => [id, { enabled, config: value }])) })

describe('sources set', () => {
  it('names the Sources with a setup field set, whether or not they are enabled', () => {
    const set = (config: Record<string, Record<string, unknown>>, enabled?: boolean) => sourcesSet(settingsOf(config, enabled))
    const none = { github: false, gitlab: false, feishu: false, dingtalk: false }
    expect(set({})).toEqual(none)
    // Either account field sets a Source, and a blank one does not. A setting that is no account field sets nothing, nor does a Source with no setup field.
    expect(set({ github: { repository: 'acme/widgets' } })).toEqual({ ...none, github: true })
    expect(set({ github: { cli: 'gh' } })).toEqual({ ...none, github: true })
    expect(set({ gitlab: { project: 'acme/widgets' } })).toEqual({ ...none, gitlab: true })
    expect(set({ gitlab: { cli: 'glab' } })).toEqual({ ...none, gitlab: true })
    expect(set({ feishu: { cli: 'lark-cli' } }, false)).toEqual({ ...none, feishu: true })
    expect(set({ github: { repository: ' ', cli: '', pollSeconds: 120 }, feishu: { cli: '  ' }, webhook: { cli: 'hook' } })).toEqual(none)
  })
})

describe('Setup', () => {
  const github = () => ({ repository: 'acme/widgets', cli: join(dir, 'bin', 'gh') })
  const gitlab = () => ({ project: 'acme/widgets', cli: join(dir, 'bin', 'glab') })
  const feishu = () => ({ cli: join(dir, 'bin', 'lark-cli') })
  const dingtalk = () => ({ cli: join(dir, 'bin', 'dingtalk-bot') })
  const feishuOff = () => program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
  const dingtalkOff = () => program(join(dir, 'bin', 'dingtalk-bot'), 'echo "token expired" >&2; exit 1')
  const started: Setup[] = []
  afterEach(() => { for (const setup of started.splice(0)) setup.restore() })
  /** Runs setup as the Runtime does at startup, over the Sources' configuration `config`: the stand-in CLIs above and the real git, with the agent environment applied to this process until `restore`. */
  async function start(config: Record<string, Record<string, unknown>>, value = machine({ stateDir: join(dir, 'agent') })) {
    mkdirSync(value.stateDir, { recursive: true })
    const context = { subprocess: subprocess(workerGitConfig(value.stateDir)), logger: { warn: () => {} } } as unknown as Context
    const setup = new Setup({ context, machine: value, lifetime: new AbortController().signal, restart: () => {} })
    started.push(setup)
    return { setup, resolved: await setup.run(settingsOf(config)) }
  }
  it('resolves with no code host when a chat Source is set', async () => {
    const { setup, resolved } = await start({ feishu: feishu() })
    expect(resolved).toBe(true)
    expect(setup.problem).toBeUndefined()
    expect(setup.deployment.github).toBeUndefined()
    expect(setup.deployment.repository).toBeUndefined()
    expect(setup.deployment.feishu).toMatchObject({ botId: 'ou_bot', name: 'Widgets Bot' })
  })
  it('still reports repositoryUnset when no Source is set', async () => {
    // A Source with no setup field set, or with an empty CLI, is no Source.
    const configs: Record<string, Record<string, unknown>>[] = [{}, { github: {}, feishu: { cli: '' } }]
    for (const config of configs) {
      const { setup, resolved } = await start(config)
      expect(resolved).toBe(false)
      expect(setup.configured()).toBe(false)
      expect(setup.problem).toMatchObject({ place: 'github', code: 'repositoryUnset' })
    }
  })
  it('resolves a GitHub-only deployment to the same object', async () => {
    const value = machine({ stateDir: join(dir, 'agent') })
    const { setup, resolved } = await start({ github: github() }, value)
    expect(resolved).toBe(true)
    expect(setup.deployment).toStrictEqual(await resolveDeployment(value, github(), probe, path))
  })
  it('makes a chat Source that fails the setup problem when it is the only Source', async () => {
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    const alone = await start({ feishu: feishu() })
    expect(alone.resolved).toBe(false)
    expect(alone.setup.problem).toMatchObject({ place: 'feishu', code: 'feishuUserIdentity', values: { mode: 'off' } })
    expect(alone.setup.feishuProblem).toBeUndefined()
    // With a code host to run, the same failure leaves only Feishu out.
    const hosted = await start({ feishu: feishu(), github: github() })
    expect(hosted.resolved).toBe(true)
    expect(hosted.setup.feishuProblem).toMatchObject({ place: 'feishu', code: 'feishuUserIdentity' })
    expect(hosted.setup.deployment.feishu).toBeUndefined()
  })
  it('accepts clearing GitHub when a working Feishu Source remains, and still names what a half-filled GitHub Source lacks', async () => {
    const { setup } = await start({})
    // The chat Source then runs the installation, and its account checks out, so the save may go through and setup run again.
    await expect(setup.checkAccounts('source:github', settingsOf({ github: { repository: '', cli: '' }, feishu: feishu() }))).resolves.toBeUndefined()
    await expect(setup.checkAccounts('source:github', settingsOf({ github: { repository: 'acme/widgets' } }))).rejects.toMatchObject({ code: 'agentCliUnset' })
  })
  it('refuses to clear GitHub when no other Source is set', async () => {
    const { setup } = await start({ github: github() })
    const cleared = { repository: '', cli: '' }
    // The restart would stop setup with repositoryUnset, as it does for any installation with no Source, so the save is refused before it.
    await expect(setup.checkAccounts('source:github', settingsOf({ github: cleared }))).rejects.toMatchObject({ place: 'github', code: 'repositoryUnset' })
    await expect(setup.checkAccounts('source:github', settingsOf({ github: cleared, feishu: { cli: '' } }))).rejects.toMatchObject({ code: 'repositoryUnset' })
  })
  it('refuses to clear GitHub when the only remaining Source fails', async () => {
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    // A running installation that leaves Feishu out for its bot, which would then be all there is to run.
    const { setup } = await start({ github: github(), feishu: feishu() })
    expect(setup.feishuProblem).toMatchObject({ code: 'feishuUserIdentity' })
    await expect(setup.checkAccounts('source:github', settingsOf({ github: { repository: '', cli: '' }, feishu: feishu() })))
      .rejects.toMatchObject({ place: 'feishu', code: 'feishuUserIdentity', values: { mode: 'off' } })
  })
  it('resolves a GitLab deployment with its project as the repository', async () => {
    const { setup, resolved } = await start({ gitlab: gitlab() })
    expect(resolved).toBe(true)
    expect(setup.problem).toBeUndefined()
    expect(setup.deployment).toMatchObject({ repository: 'acme/widgets',
      gitlab: { cli: join(dir, 'bin', 'glab'), login: 'agent.bot', project: 'acme/widgets', origin: 'http://git.example.com' } })
    expect(setup.deployment.github).toBeUndefined()
    // The agent's git configuration holds the credential helper of the instance, and setup verified that git reads it.
    expect(readFileSync(workerGitConfig(join(dir, 'agent')), 'utf8')).toContain('[credential "http://git.example.com"]')
  })
  it('refuses GitHub and GitLab together', async () => {
    const { setup, resolved } = await start({ github: github(), gitlab: gitlab() })
    expect(resolved).toBe(false)
    expect(setup.configured()).toBe(false)
    expect(setup.problem).toMatchObject({ place: 'deployment', code: 'codeHostsBoth' })
  })
  it('leaves a failing Feishu bot out of a GitLab deployment, as of a GitHub one', async () => {
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    const { setup, resolved } = await start({ gitlab: gitlab(), feishu: feishu() })
    expect(resolved).toBe(true)
    expect(setup.feishuProblem).toMatchObject({ place: 'feishu', code: 'feishuUserIdentity', values: { mode: 'off' } })
    expect(setup.deployment.feishu).toBeUndefined()
    expect(setup.deployment.repository).toBe('acme/widgets')
  })
  it('refuses to clear the last Feishu CLI of a Feishu-only installation', async () => {
    const { setup } = await start({ feishu: feishu() })
    // The restart would stop setup with repositoryUnset, so the save is refused before it, and says why.
    await expect(setup.checkAccounts('source:feishu', settingsOf({ feishu: { cli: '' } }))).rejects.toMatchObject({ place: 'deployment', code: 'lastSource' })
  })
  it('refuses to clear GitLab when no other Source is set', async () => {
    const { setup } = await start({ gitlab: gitlab() })
    const cleared = { project: '', cli: '' }
    await expect(setup.checkAccounts('source:gitlab', settingsOf({ gitlab: cleared }))).rejects.toMatchObject({ place: 'deployment', code: 'lastSource' })
    await expect(setup.checkAccounts('source:gitlab', settingsOf({ gitlab: cleared, feishu: { cli: '' } }))).rejects.toMatchObject({ code: 'lastSource' })
  })
  it('refuses to save GitLab while GitHub is set, and GitHub while GitLab is', async () => {
    const { setup } = await start({ github: github() })
    const both = settingsOf({ github: github(), gitlab: gitlab() })
    await expect(setup.checkAccounts('source:gitlab', both)).rejects.toMatchObject({ place: 'deployment', code: 'codeHostsBoth' })
    await expect(setup.checkAccounts('source:github', both)).rejects.toMatchObject({ place: 'deployment', code: 'codeHostsBoth' })
    // Whichever Source is saved, and whatever state the accounts are in: one installation works on one repository.
    await expect(setup.checkAccounts('source:feishu', settingsOf({ github: github(), gitlab: { project: 'acme/widgets' }, feishu: feishu() })))
      .rejects.toMatchObject({ code: 'codeHostsBoth' })
  })
  it('refuses to clear GitLab when the only remaining Source fails, and accepts it when that Source works', async () => {
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    const { setup } = await start({ gitlab: gitlab(), feishu: feishu() })
    expect(setup.feishuProblem).toMatchObject({ code: 'feishuUserIdentity' })
    const cleared = settingsOf({ gitlab: { project: '', cli: '' }, feishu: feishu() })
    await expect(setup.checkAccounts('source:gitlab', cleared)).rejects.toMatchObject({ place: 'feishu', code: 'feishuUserIdentity', values: { mode: 'off' } })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }))
    await expect(setup.checkAccounts('source:gitlab', cleared)).resolves.toBeUndefined()
  })
  it('names what a GitLab save lacks, and passes one that works', async () => {
    const { setup } = await start({ feishu: feishu() })
    const save = (gitlabConfig: Record<string, unknown>) => setup.checkAccounts('source:gitlab', settingsOf({ gitlab: gitlabConfig, feishu: feishu() }))
    await expect(save({ project: 'acme/widgets', cli: join(dir, 'bin', 'missing') })).rejects.toMatchObject({ place: 'gitlab', code: 'gitlabCliMissing' })
    await expect(save({ project: 'acme/widgets' })).rejects.toMatchObject({ place: 'gitlab', code: 'gitlabCliUnset' })
    await expect(save({ cli: join(dir, 'bin', 'glab') })).rejects.toMatchObject({ place: 'gitlab', code: 'gitlabProjectUnset' })
    await expect(save(gitlab())).resolves.toBeUndefined()
  })
  it('checks only the Source that is saved once a code host is set', async () => {
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    const { setup } = await start({ gitlab: gitlab() })
    const broken = { project: 'acme/widgets', cli: join(dir, 'bin', 'missing') }
    // Saving Feishu is refused for Feishu's own failure, and not for a failure of the GitLab account it does not touch.
    await expect(setup.checkAccounts('source:feishu', settingsOf({ gitlab: gitlab(), feishu: feishu() }))).rejects.toMatchObject({ place: 'feishu', code: 'feishuUserIdentity' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }))
    await expect(setup.checkAccounts('source:feishu', settingsOf({ gitlab: broken, feishu: feishu() }))).resolves.toBeUndefined()
    // Clearing GitHub from an installation that holds both is the way out of codeHostsBoth, whatever state the GitLab account is in.
    await expect(setup.checkAccounts('source:github', settingsOf({ github: { repository: '', cli: '' }, gitlab: broken }))).resolves.toBeUndefined()
    await expect(setup.checkAccounts('source:gitlab', settingsOf({ github: github(), gitlab: { project: '', cli: '' } }))).resolves.toBeUndefined()
  })

  it('resolves with no code host when a DingTalk Source is set', async () => {
    const { setup, resolved } = await start({ dingtalk: dingtalk() })
    expect(resolved).toBe(true)
    expect(setup.problem).toBeUndefined()
    expect(setup.deployment).toMatchObject({ dingtalk: { cli: join(dir, 'bin', 'dingtalk-bot'), clientId: 'ding123', robotCode: 'ding123' } })
    expect([setup.deployment.repository, setup.deployment.github, setup.deployment.feishu]).toEqual([undefined, undefined, undefined])
    // The worker shim runs the bot CLI, so a worker's `dingtalk-bot` is the bot.
    expect(readFileSync(join(dir, 'agent', 'worker-bin', 'dingtalk-bot'), 'utf8')).toContain(join(dir, 'bin', 'dingtalk-bot'))
  })
  it('makes a DingTalk Source that fails the setup problem when it is the only one', async () => {
    dingtalkOff()
    const alone = await start({ dingtalk: dingtalk() })
    expect(alone.resolved).toBe(false)
    expect(alone.setup.problem).toMatchObject({ place: 'dingtalk', code: 'dingtalkCliFailed', values: { output: expect.stringContaining('token expired') } })
    expect(alone.setup.dingtalkProblem).toBeUndefined()
    // With a code host to run, the same failure leaves only DingTalk out.
    const hosted = await start({ dingtalk: dingtalk(), github: github() })
    expect(hosted.resolved).toBe(true)
    expect(hosted.setup.dingtalkProblem).toMatchObject({ place: 'dingtalk', code: 'dingtalkCliFailed' })
    expect([hosted.setup.problem, hosted.setup.deployment.dingtalk]).toEqual([undefined, undefined])
  })
  it('sets up on the chat Source that works when the other one fails, and stops when none does', async () => {
    feishuOff()
    const feishuFails = await start({ feishu: feishu(), dingtalk: dingtalk() })
    expect(feishuFails.resolved).toBe(true)
    expect(feishuFails.setup.feishuProblem).toMatchObject({ place: 'feishu', code: 'feishuUserIdentity' })
    expect([feishuFails.setup.dingtalkProblem, feishuFails.setup.problem, feishuFails.setup.deployment.feishu]).toEqual([undefined, undefined, undefined])
    expect(feishuFails.setup.deployment.dingtalk).toMatchObject({ robotCode: 'ding123' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }))
    dingtalkOff()
    const dingtalkFails = await start({ feishu: feishu(), dingtalk: dingtalk() })
    expect(dingtalkFails.resolved).toBe(true)
    expect(dingtalkFails.setup.dingtalkProblem).toMatchObject({ place: 'dingtalk', code: 'dingtalkCliFailed' })
    expect([dingtalkFails.setup.feishuProblem, dingtalkFails.setup.deployment.dingtalk]).toEqual([undefined, undefined])
    expect(dingtalkFails.setup.deployment.feishu).toMatchObject({ botId: 'ou_bot' })
    // Neither works, and nothing else runs the installation: setup stops on the first, and records no problem of a Source left out.
    feishuOff()
    const neither = await start({ feishu: feishu(), dingtalk: dingtalk() })
    expect(neither.resolved).toBe(false)
    expect(neither.setup.problem).toMatchObject({ place: 'feishu', code: 'feishuUserIdentity' })
    expect([neither.setup.feishuProblem, neither.setup.dingtalkProblem]).toEqual([undefined, undefined])
  })
  it('refuses to clear the last DingTalk CLI of a DingTalk-only installation', async () => {
    const { setup } = await start({ dingtalk: dingtalk() })
    await expect(setup.checkAccounts('source:dingtalk', settingsOf({ dingtalk: { cli: '' } }))).rejects.toMatchObject({ place: 'deployment', code: 'lastSource' })
    // Clearing the GitHub Source of an installation that holds nothing else is refused as before, and a working DingTalk Source is a Source to keep.
    await expect(setup.checkAccounts('source:github', settingsOf({ github: { repository: '', cli: '' }, dingtalk: { cli: '' } }))).rejects.toMatchObject({ code: 'repositoryUnset' })
    await expect(setup.checkAccounts('source:github', settingsOf({ github: { repository: '', cli: '' }, dingtalk: dingtalk() }))).resolves.toBeUndefined()
    await expect(setup.checkAccounts('source:dingtalk', settingsOf({ dingtalk: dingtalk() }))).resolves.toBeUndefined()
  })
  it('checks the DingTalk Source that is saved, and a save that would leave no chat Source working', async () => {
    const { setup } = await start({ feishu: feishu(), dingtalk: dingtalk() })
    // With no code host, a save is refused when the Source it saves fails, or when none of the chat Sources works.
    dingtalkOff()
    await expect(setup.checkAccounts('source:dingtalk', settingsOf({ feishu: feishu(), dingtalk: dingtalk() }))).rejects.toMatchObject({ place: 'dingtalk', code: 'dingtalkCliFailed' })
    await expect(setup.checkAccounts('source:feishu', settingsOf({ feishu: feishu(), dingtalk: dingtalk() }))).resolves.toBeUndefined()
    await expect(setup.checkAccounts('source:github', settingsOf({ github: { repository: '', cli: '' }, feishu: feishu(), dingtalk: dingtalk() }))).resolves.toBeUndefined()
    feishuOff()
    await expect(setup.checkAccounts('source:feishu', settingsOf({ feishu: feishu(), dingtalk: dingtalk() }))).rejects.toMatchObject({ place: 'feishu', code: 'feishuUserIdentity' })
    await expect(setup.checkAccounts('source:github', settingsOf({ github: { repository: '', cli: '' }, feishu: feishu(), dingtalk: dingtalk() }))).rejects.toMatchObject({ place: 'feishu' })
    // With a code host, only the Source that is saved is checked, as for Feishu.
    const hosted = await start({ gitlab: gitlab() })
    await expect(hosted.setup.checkAccounts('source:dingtalk', settingsOf({ gitlab: gitlab(), dingtalk: dingtalk() }))).rejects.toMatchObject({ place: 'dingtalk', code: 'dingtalkCliFailed' })
    await expect(hosted.setup.checkAccounts('source:feishu', settingsOf({ gitlab: gitlab(), feishu: { cli: '' }, dingtalk: dingtalk() }))).resolves.toBeUndefined()
    dingtalkBot(join(dir, 'bin', 'dingtalk-bot'))
    await expect(hosted.setup.checkAccounts('source:dingtalk', settingsOf({ gitlab: gitlab(), dingtalk: dingtalk() }))).resolves.toBeUndefined()
  })
})

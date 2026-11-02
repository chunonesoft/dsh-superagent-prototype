import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Setup } from '../src/app/setup.ts'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, sourcesSet, type Machine, type Probe } from '../src/deployment.ts'
import { workerGitConfig } from '../src/infra/environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { gitEnv, subprocess } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
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
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
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
    expect(set({ feishu: { cli: 'lark-cli' } }, false)).toEqual({ ...none, feishu: true })
    expect(set({ github: { repository: ' ', cli: '', pollSeconds: 120 }, feishu: { cli: '  ' }, webhook: { cli: 'hook' } })).toEqual(none)
  })
})

describe('Setup', () => {
  const github = () => ({ repository: 'acme/widgets', cli: join(dir, 'bin', 'gh') })
  const feishu = () => ({ cli: join(dir, 'bin', 'lark-cli') })
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
  it('accepts a GitHub Source whose account fields are all cleared, and still names what a half-filled one lacks', async () => {
    const { setup } = await start({})
    // Clearing the fields leaves no GitHub account to check, so the save may go through and setup run again.
    await expect(setup.checkAccounts('source:github', settingsOf({ github: { repository: '', cli: '' }, feishu: feishu() }))).resolves.toBeUndefined()
    await expect(setup.checkAccounts('source:github', settingsOf({ github: { repository: 'acme/widgets' } }))).rejects.toMatchObject({ code: 'agentCliUnset' })
  })
})

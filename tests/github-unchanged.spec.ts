/**
 * What a deployment on GitHub assembles, pinned to what the upstream prototype (commit 6337fc8) assembled, so that the GitLab and DingTalk
 * Sources cannot change it: the prompts of both roles, the skills, the resolved deployment with the environment it writes, and what the
 * status script prints. `fixtures/github-prompts.json` holds what that commit produced, with and without Feishu: `observe` below, run
 * unchanged in a checkout of that commit, measured it. A test that fails here means the code changed what a GitHub deployment gets:
 * undo the change, never edit the fixture.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { environmentOf, type Variable } from '../src/app/execution-environment.ts'
import { Prompts, SKILL_PREFIX, environmentSection, policySection, promptParts } from '../src/app/prompts.ts'
import { bundledSkills } from '../src/app/skill-files.ts'
import { Store } from '../src/app/store.ts'
import type { Trigger } from '../src/core/index.ts'
import { resolveDeployment, resolveFeishuBot, type Deployment, type FeishuBot, type GithubAccount, type Probe } from '../src/deployment.ts'
import { writeEnvironment } from '../src/infra/environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testMachine } from './fixtures/deployment.ts'

const VARIANTS = ['github', 'github-feishu'] as const
type Variant = typeof VARIANTS[number]
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const GITHUB: GithubAccount = { cli: '/opt/agent/gh-agent', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' }
const FEISHU: FeishuBot = { cli: '/opt/agent/lark-bot', appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot', name: 'Widgets Bot' }
/** The Ticket a worker prompt is assembled for, and the pull request comment that started it. */
const TICKET = { id: 'ticket-1', name: 'fix-regression', directory: '/work/fix-regression' }
const TRIGGER: Trigger = { id: 'trigger-1', source: 'github', threads: [{ source: 'github', id: '12' }], actor: { source: 'github', id: 'alice' }, human: true,
  at: '2026-09-09T00:00:00.000Z', text: 'Please fix the regression.', meta: { number: 12, isPr: true } }

/** The prompt of one role and its parts, as hashes: the parts say where a prompt differs when the whole does. */
interface Assembled { sha: string; parts: Record<string, string> }
interface Observed {
  prompts: Record<Variant, { main: Assembled; worker: Assembled }>
  skills: Record<Variant, { name: string; description: string; content: string }[]>
  deployment: Record<Variant, unknown>
  environment: Record<Variant, { gitconfig: string[]; shims: Record<string, string> }>
  status: Record<string, { code: number; output: string[] }>
}

/** Runs `body` with a temporary directory, which is gone afterwards. */
async function within<T>(body: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'github-unchanged-'))
  try { return await body(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
const settingsOf = (variant: Variant) => SettingsSchema.parse({
  sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: GITHUB.cli } },
    ...variant === 'github-feishu' ? { feishu: { enabled: true, config: { cli: FEISHU.cli } } } : {} },
  executor: { blockedCommands: ['personal-gh'] },
})

/** The prompts of both roles, assembled from the default text with the variables a GitHub deployment declares, and the skills Sessions register. */
function observePrompts(variant: Variant) {
  const feishu = variant === 'github-feishu'
  const settings = settingsOf(variant)
  const deployment: Deployment = { ...testMachine(), repository: 'acme/widgets', github: GITHUB, ...feishu ? { feishu: FEISHU } : {} }
  const sources = new SourceRegistry(() => settings)
  sources.register(githubKind)
  if (feishu) sources.register(feishuKind)
  return within(dir => {
    const store = new Store(join(dir, 'db'))
    try {
      store.saveSettings(settings)
      const main = environmentOf({ deployment, sources, settings })
      const worker = environmentOf({ deployment, sources, settings, ticket: TICKET, trigger: TRIGGER })
      const prompts = new Prompts(store, () => 100_000, () => main, () => feishu)
      const config = prompts.current().config
      const assemble = (role: 'orchestrator' | 'worker', variables: Variable[]): Assembled => ({
        sha: sha(prompts.compose(config, role, variables)),
        parts: Object.fromEntries(promptParts(config, role, environmentSection(config, variables), role === 'orchestrator' ? policySection(settings, config) : undefined)
          .map(part => [part.name, sha(part.text)])),
      })
      return {
        prompts: { main: assemble('orchestrator', main), worker: assemble('worker', worker) },
        // What Sessions register for each skill: its name under the prefix, the packaged description, and the text a Session reads.
        skills: prompts.skills(config).map(([name, content]) => ({ name: `${SKILL_PREFIX}${name}`, description: bundledSkills[name as 'github' | 'feishu'].description, content: sha(content) })),
      }
    } finally { store.close() }
  })
}

/** What the account checks resolve for the deployment, as stand-ins answer them; paths are those of the temporary directory. */
function observeDeployment(variant: Variant) {
  return within(async dir => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    for (const name of ['gh-agent', 'lark-bot']) writeFileSync(join(bin, name), '#!/bin/sh\n', { mode: 0o755 })
    const machine = testMachine({ stateDir: join(dir, 'state') })
    const answer = (call: string): string => {
      if (call.endsWith('api user')) return '{"login":"Agent-Bot","id":7}'
      if (call.includes('api repos/acme/widgets')) return '{"name":"acme/widgets","push":true}\n'
      if (call.endsWith('auth status')) return '{"appId":"cli_bot","brand":"lark","identities":{"bot":{"status":"ready"}}}'
      if (call.endsWith('config strict-mode')) return 'strict-mode: bot (source: profile)'
      if (call.includes('/open-apis/bot/v3/info')) return '{"bot":{"open_id":"ou_bot","app_name":"Widgets Bot"},"code":0}'
      throw new Error(`The stand-ins answer nothing to ${call}`)
    }
    const probe: Probe = async argv => answer(argv.join(' '))
    const github = await resolveDeployment(machine, { repository: 'acme/widgets', cli: 'gh-agent' }, probe, bin)
    const feishu = variant === 'github-feishu' ? await resolveFeishuBot(machine, { cli: 'lark-bot' }, probe, bin) : undefined
    // The machine's limits are references the plugin updates in place; the account and the repository are what setup resolves.
    const { stateDir: _stateDir, promptMaxChars: _prompt, admissionContextMaxPages: _pages, admissionContextTimeoutMs: _timeout, ...resolved } = { ...github, ...feishu ? { feishu } : {} }
    return JSON.parse(JSON.stringify(resolved).replaceAll(dir, '<dir>')) as unknown
  })
}

/** The git configuration and the shims setup writes for the deployment: the configuration as lines, the shims as hashes of their text. */
function observeEnvironment(variant: Variant) {
  return within(async dir => {
    await writeEnvironment({ stateDir: dir, repository: 'acme/widgets', github: GITHUB, ...variant === 'github-feishu' ? { feishu: FEISHU } : {} }, ['personal-gh'])
    const read = (...parts: string[]): string => readFileSync(join(dir, ...parts), 'utf8').replaceAll(dir, '<state>')
    return { gitconfig: read('worker-gitconfig').split('\n'),
      shims: Object.fromEntries(['gh', 'lark-cli', 'personal-gh'].map(name => [name, sha(read('worker-bin', name))])) }
  })
}

/** The state a service answers when it works on GitHub, with `health` and `setup` as the scenario says. */
const READY = { runtime: { state: 'ready', detail: '' }, models: { state: 'ready', detail: '' }, evals: { state: 'ready', detail: '' },
  assessment: { state: 'ready', detail: '' }, launch: { state: 'ready', detail: '' }, delivery: { state: 'ready', detail: '' }, relay: { state: 'ready', detail: '' },
  notice: { state: 'ready', detail: '' }, reply: { state: 'ready', detail: '' }, github: { state: 'ready', detail: '3 notifications' } }
const ACCOUNTS = { repository: 'acme/widgets', agent: 'agent-bot', feishu: null }
const SCENARIOS: Record<string, { health: Record<string, unknown>; setup: Record<string, unknown> }> = {
  healthy: { health: READY, setup: { problem: null, feishuProblem: null, accounts: ACCOUNTS } },
  'a part reports an error': { health: { ...READY, github: { state: 'error', detail: '3 consecutive failed polls; last: Error: bad token' } },
    setup: { problem: null, feishuProblem: null, accounts: ACCOUNTS } },
  'setup waits': { health: { ...READY, runtime: { state: 'paused', detail: '' } },
    setup: { problem: { place: 'github', code: 'repositoryUnset', values: {}, detail: 'The GitHub Source names no repository.' }, feishuProblem: null, accounts: null } },
  'a Feishu bot could not be checked': { health: READY,
    setup: { problem: null, feishuProblem: { place: 'feishu', code: 'feishuCliFailed', values: {}, detail: 'The bot lark-cli does not work.' }, accounts: ACCOUNTS } },
}
/** Prints what the service script's `status` prints for each state, with the one process, the checkout and the port made fixed. */
function observeStatus() {
  return within(async dir => {
    const root = join(dir, 'checkout')
    mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(join(root, 'bin'))
    copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent'), join(root, 'scripts', 'dsh-superagent'))
    writeFileSync(join(root, 'bin', 'ps'), '#!/bin/sh\necho "4242 node node /opt/dsh --profile superagent --no-open"\n', { mode: 0o755 })
    let state: unknown
    const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state)) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const status: Observed['status'] = {}
      for (const [name, scenario] of Object.entries(SCENARIOS)) {
        state = { ...scenario, load: { running: 0, queued: 0, maxWorkers: 4 }, paused: false, masterId: 'orchestrator-1' }
        const result = await new Promise<{ code: number; stdout: string }>(resolve => execFile('python3',
          [join(root, 'scripts', 'dsh-superagent'), 'status', '--url', `http://127.0.0.1:${port}`],
          { env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '' }, timeout: 20_000 },
          (error, stdout) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout })))
        status[name] = { code: result.code, output: result.stdout.replaceAll(realpathSync(root), '<checkout>').replaceAll(`:${port}`, ':<port>').split('\n') }
      }
      return status
    } finally { server.close() }
  })
}

async function observe(): Promise<Observed> {
  const assembled = await Promise.all(VARIANTS.map(observePrompts))
  const entries = <T>(values: T[]): Record<Variant, T> => Object.fromEntries(VARIANTS.map((variant, index) => [variant, values[index]])) as Record<Variant, T>
  return {
    prompts: entries(assembled.map(item => item.prompts)), skills: entries(assembled.map(item => item.skills)),
    deployment: entries(await Promise.all(VARIANTS.map(observeDeployment))), environment: entries(await Promise.all(VARIANTS.map(observeEnvironment))),
    status: await observeStatus(),
  }
}

// The tests below compare what `observe` measures with the fixture.
describe('a GitHub deployment', () => {
  const baseline = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'github-prompts.json'), 'utf8')) as { commit: string } & Observed
  let observed: Observed
  beforeAll(async () => { observed = await observe() }, 60_000)

  it('assembles the same prompts for a GitHub deployment', () => {
    expect(observed.prompts, `the prompts as commit ${baseline.commit} assembled them`).toEqual(baseline.prompts)
  })
  it('registers the same skills for a GitHub deployment', () => {
    expect(observed.skills, `the skills as commit ${baseline.commit} registered them`).toEqual(baseline.skills)
  })
  it('resolves the same deployment object', () => {
    // The object setup resolves, and the git configuration and shims it writes for it. Only the shims of `gh`, `lark-cli` and a blocked
    // command are compared: the GitLab and DingTalk Sources add shims of their own CLIs, which fail on a deployment that has none.
    expect(observed.deployment, `the deployment as commit ${baseline.commit} resolved it`).toEqual(baseline.deployment)
    expect(observed.environment, `the environment as commit ${baseline.commit} wrote it`).toEqual(baseline.environment)
  })
  it('keeps the status script output for a GitHub deployment', () => {
    expect(observed.status, `the output of the status script of commit ${baseline.commit}`).toEqual(baseline.status)
  })
})

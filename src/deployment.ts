/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import type { Settings } from './policy.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const GitlabAccountsSchema = z.object({ project: z.string().trim().default(''), cli: z.string().trim().default('') })
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
export const DingtalkBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape),
  gitlab: Object.keys(GitlabAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape), dingtalk: Object.keys(DingtalkBotSchema.shape) }

/** The agent's GitHub account: the CLI it acts through, its login, and its commit email. */
export interface GithubAccount { cli: string; login: string; noreply: string }
/**
 * The agent's account on a self-hosted GitLab and the project it works on. `project` is the `path_with_namespace` the instance returned,
 * which differs from the configured path after a move. `origin` (scheme, host and port) comes from the project's `web_url` and is where
 * git credentials are keyed. `email` is the commit email the instance reports, or else the account's email.
 */
export interface GitlabAccount { cli: string; login: string; email: string; project: string; projectId: number; webUrl: string; origin: string; defaultBranch: string }
/**
 * What setup resolved: the machine settings and the accounts of the Sources that are set. `github` or `gitlab` is the agent's account on
 * the code host and comes with its `repository` (for GitLab the project's `path_with_namespace`); one installation has at most one code
 * host, and a deployment that only chat Sources run has neither.
 */
export interface Deployment extends Machine {
  repository?: string
  github?: GithubAccount
  gitlab?: GitlabAccount
  feishu?: FeishuBot
  dingtalk?: DingtalkBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }
/** The DingTalk robot a bot CLI reports: the app's `clientId` and the `robotCode` the robot sends with. The app's secret stays in the CLI's own configuration. */
export interface DingtalkBot { cli: string; clientId: string; robotCode: string }

/** The agent's GitHub account, for code that acts only on a GitHub deployment. @throws when the deployment has none. */
export function githubOf(deployment: Pick<Deployment, 'github'>): GithubAccount {
  if (!deployment.github) throw new Error('This installation has no GitHub account; set the repository and the agent CLI on the GitHub Source')
  return deployment.github
}

/** The agent's GitLab account, for code that acts only on a GitLab deployment. @throws when the deployment has none. */
export function gitlabOf(deployment: Pick<Deployment, 'gitlab'>): GitlabAccount {
  if (!deployment.gitlab) throw new Error('This installation has no GitLab account; set the project and the agent CLI on the GitLab Source')
  return deployment.gitlab
}

export interface SourcesSet { github: boolean; gitlab: boolean; feishu: boolean; dingtalk: boolean }
/** Which Sources hold a value in one of their `SETUP_FIELDS`, enabled or not, as setup reads them; a kind without an entry there sets nothing. */
export function sourcesSet(settings: Pick<Settings, 'sources'>): SourcesSet {
  const set = (id: string): boolean => (SETUP_FIELDS[id] ?? []).some(key => {
    const value = settings.sources[id]?.config[key]
    return typeof value === 'string' && value.trim() !== ''
  })
  return { github: set('github'), gitlab: set('gitlab'), feishu: set('feishu'), dingtalk: set('dingtalk') }
}

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` or `glab` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

// Shapes measured on GitLab CE 11.7: `/user` has `email` and no `commit_email`, `web_url` has no `/-/`, and either `permissions` entry may be null.
const GitlabUser = z.object({ username: z.string().regex(/^[A-Za-z0-9_.-]+$/), email: z.string().nullish(), commit_email: z.string().nullish() })
const GitlabAccess = z.object({ access_level: z.number() }).nullish()
const GitlabProject = z.object({
  id: z.number().int().positive(), path_with_namespace: z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/), web_url: z.string(),
  default_branch: z.string().nullish(), permissions: z.object({ project_access: GitlabAccess, group_access: GitlabAccess }).optional(),
})
/** The lowest GitLab access level that pushes branches: Developer. */
const GITLAB_PUSH_LEVEL = 30
/** The origin of an http or https address, or undefined for anything else. */
function originOf(address: string): string | undefined {
  try {
    const url = new URL(address)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch { return undefined /* Not an address; the caller surfaces the setup failure. */ }
}
/**
 * Verify the agent's GitLab CLI identity and push access to the configured project. The project's `web_url` gives the instance's origin,
 * so git credentials need not be configured by hand. Only `glab api` is used: the higher-level commands panic on old instances.
 */
export async function resolveGitlab(machine: Machine, gitlab: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<GitlabAccount> {
  const { stateDir } = machine
  const accounts = GitlabAccountsSchema.parse(gitlab ?? {})
  const configured = accounts.project
  if (!configured) throw new SetupError('gitlabProjectUnset')
  if (!accounts.cli) throw new SetupError('gitlabCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('gitlabCliMissing', { output: reason(error) }) }
  const user = parsed(GitlabUser, await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('gitlabSignedOut', { output: reason(error) }) }))
  // The commit email the instance sets for the account wins over its sign-in email; an account with neither has no email to commit with.
  const email = user?.commit_email || user?.email
  if (!user || !email) throw new SetupError('gitlabSignedOut')
  const { username: login } = user
  const unreadable = (output?: string) => new SetupError('gitlabProjectUnreadable', { account: login, project: configured, ...output ? { output } : {} })
  const project = parsed(GitlabProject, await probe([cli, 'api', `projects/${encodeURIComponent(configured)}`]).catch((error: unknown) => { throw unreadable(reason(error)) }))
  const origin = project && originOf(project.web_url)
  if (!project || !origin) throw unreadable()
  // The account's role in the project or in its group decides; the instance reports null for the one it holds none in.
  const access = Math.max(project.permissions?.project_access?.access_level ?? 0, project.permissions?.group_access?.access_level ?? 0)
  // Use the canonical path GitLab returns, as for GitHub's full_name, so a project that moved still matches incoming events.
  const projectPath = project.path_with_namespace
  if (access < GITLAB_PUSH_LEVEL) throw new SetupError('gitlabReadOnly', { account: login, project: projectPath })
  return { cli, login, email, project: projectPath, projectId: project.id, webUrl: project.web_url, origin, defaultBranch: project.default_branch ?? '' }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}

const BotStatus = z.object({ clientId: z.string().min(1), robotCode: z.string().min(1), token: z.literal('ok') })
/**
 * Verify that the configured DingTalk bot CLI works: its `auth status` names the app and the robot, and has got a token with the app's secret.
 * Workers invoke this CLI as `dingtalk-bot`. It sends as the robot only and has no command that reads a person's messages, and its
 * secret lives in its own configuration, never in the settings.
 */
export async function resolveDingtalkBot(machine: Machine, dingtalk: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<DingtalkBot | undefined> {
  const { cli: name } = DingtalkBotSchema.parse(dingtalk ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('dingtalkCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const text = await probe([cli, 'auth', 'status']).catch(fail)
  const status = parsed(BotStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('dingtalkNoApp'))
  return { cli, clientId: status.clientId, robotCode: status.robotCode }
}

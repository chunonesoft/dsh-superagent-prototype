/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveDingtalkBot, resolveFeishuBot, resolveGitlab, sourcesSet, workerProbe, type Deployment, type Machine, type SourcesSet } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)
/** Whether no Source holds a value in its setup fields. */
const nothingSet = (set: SourcesSet): boolean => !Object.values(set).some(Boolean)
/**
 * Whether setup checks the GitHub account: a GitHub field is set, or no Source is set at all and the check reports `repositoryUnset`.
 * Otherwise a GitLab field is set, or only chat Sources are, and those run the installation. Both code hosts set is refused before this is asked.
 */
const checksGithub = (set: SourcesSet): boolean => set.github || nothingSet(set)
/** The outcome of a chat Source's bot check: the bot, or the setup problem that failed it; a Source that is not set has neither. */
const attempt = <Bot>(check: Promise<Bot | undefined>): Promise<{ bot?: Bot; error?: SetupError }> =>
  check.then(bot => bot ? { bot } : {}, (error: unknown) => { if (!(error instanceof SetupError)) throw error; return { error } })

/**
 * Resolves the target repository and the agent's account on the code host, GitHub or GitLab, when its Source is set, and the optional Feishu and DingTalk bots, by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  dingtalkProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem`/`dingtalkProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and the chat bots are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem && !this.dingtalkProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /**
   * Verify account CLIs for a modified source block before saving; `settings` are the settings as the save leaves them.
   * A save that would restart into a failed setup is refused: one that leaves both code hosts set, or no Source at all (`repositoryUnset`
   * on the GitHub block, `lastSource` on any other). With no code host left, the chat Sources (Feishu and DingTalk) run the installation,
   * so the save is refused when none of them works, or when the Source being saved is one that fails. With one, the check is the saved
   * block's (a chat bot, or the code host) and setup errors belonging to other blocks are ignored.
   */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const set = sourcesSet(settings)
    if (set.github && set.gitlab) throw new SetupError('codeHostsBoth')
    if (nothingSet(set)) throw new SetupError(block === 'source:github' ? 'repositoryUnset' : 'lastSource')
    const { machine } = this.host
    const probe = this.probe()
    // The checks of the chat Sources, in one place, by Source ID; the check of a Source that is not set passes.
    const chats = { feishu: () => resolveFeishuBot(machine, settings.sources.feishu?.config, probe),
      dingtalk: () => resolveDingtalkBot(machine, settings.sources.dingtalk?.config, probe) }
    const saved = block.slice(7)
    if (!set.github && !set.gitlab) {
      const failures: SetupError[] = []
      let working = 0
      for (const id of ['feishu', 'dingtalk'] as const) {
        if (!set[id]) continue
        try { await chats[id](); working++ }
        catch (error) { if (!(error instanceof SetupError)) throw error; failures.push(error) }
      }
      const own = failures.find(error => error.place === saved)
      if (own || failures.length && !working) throw own ?? failures[0]
      return
    }
    const codeHost = () => set.gitlab ? resolveGitlab(machine, settings.sources.gitlab?.config, probe) : resolveDeployment(machine, settings.sources.github?.config, probe)
    const chat = Object.hasOwn(chats, saved) ? chats[saved as keyof typeof chats] : undefined
    const check: Promise<unknown> = chat ? chat() : codeHost()
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === saved) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const set = sourcesSet(settings)
    if (set.github && set.gitlab) throw new SetupError('codeHostsBoth')
    const account = set.gitlab ? await resolveGitlab(machine, settings.sources.gitlab?.config, probe) : undefined
    const deployment: Deployment = account ? { ...machine, repository: account.project, gitlab: account }
      : checksGithub(set) ? await resolveDeployment(machine, settings.sources.github?.config, probe) : machine
    const feishu = await attempt(resolveFeishuBot(machine, settings.sources.feishu?.config, probe))
    const dingtalk = await attempt(resolveDingtalkBot(machine, settings.sources.dingtalk?.config, probe))
    // A code host comes with its repository. Without one the chat Sources are all there is to run, so setup stops only when none works.
    const failure = feishu.error ?? dingtalk.error
    if (failure && !deployment.repository && !feishu.bot && !dingtalk.bot) throw failure
    // A chat Source that fails while another Source works is left out, with its problem recorded for the panel.
    if (feishu.error) {
      this.feishuProblem = feishu.error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', feishu.error.message)
    }
    if (dingtalk.error) {
      this.dingtalkProblem = dingtalk.error.problem
      context.logger.warn('dsh-superagent leaves DingTalk out: %s', dingtalk.error.message)
    }
    const resolved = { ...deployment, ...(feishu.bot ? { feishu: feishu.bot } : {}), ...(dingtalk.bot ? { dingtalk: dingtalk.bot } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}

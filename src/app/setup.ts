/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, resolveGitlab, sourcesSet, workerProbe, type Deployment, type Machine } from '../deployment.ts'
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
/**
 * Whether setup checks the GitHub account: a GitHub field is set, or no Source is set at all and the check reports `repositoryUnset`.
 * Otherwise a GitLab field is set, or only chat Sources are, and those run the installation. Both code hosts set is refused before this is asked.
 */
const checksGithub = (settings: Settings): boolean => {
  const set = sourcesSet(settings)
  return set.github || !Object.values(set).some(Boolean)
}

/**
 * Resolves the target repository and the agent's account on the code host, GitHub or GitLab, when its Source is set, and the optional Feishu bot, by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
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
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /**
   * Verify account CLIs for a modified source block before saving; `settings` are the settings as the save leaves them.
   * A save that would restart into a failed setup is refused: one that leaves both code hosts set, or no Source at all (`repositoryUnset`
   * on the GitHub block, `lastSource` on any other). With no code host left, the chat Sources run the installation, so any one that
   * fails refuses the save. With one, the check is the saved block's (the Feishu bot, or the code host) and setup errors belonging to
   * other blocks are ignored.
   */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const set = sourcesSet(settings)
    if (set.github && set.gitlab) throw new SetupError('codeHostsBoth')
    if (!Object.values(set).some(Boolean)) throw new SetupError(block === 'source:github' ? 'repositoryUnset' : 'lastSource')
    const { machine } = this.host
    const probe = this.probe()
    // The checks of the chat Sources, in one place.
    const chat = () => resolveFeishuBot(machine, settings.sources.feishu?.config, probe)
    if (!set.github && !set.gitlab) { await chat(); return }
    const codeHost = () => set.gitlab ? resolveGitlab(machine, settings.sources.gitlab?.config, probe) : resolveDeployment(machine, settings.sources.github?.config, probe)
    const check = block === 'source:feishu' ? chat() : codeHost()
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
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
      : checksGithub(settings) ? await resolveDeployment(machine, settings.sources.github?.config, probe) : machine
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      // A code host comes with its repository. Without one the chat Source is all there is to run, so its failure stops setup.
      if (!deployment.repository) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
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

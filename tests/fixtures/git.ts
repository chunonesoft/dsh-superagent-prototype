/** The environment of the git processes the tests start, and a subprocess runtime that starts them as workers do. */
import { spawn } from 'node:child_process'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { GIT_LOCATION } from '../../src/infra/environment.ts'

/**
 * The process environment with `extra`, and without the variables that tell git which repository to act on (`GIT_LOCATION`):
 * the tests run inside `git rebase --exec` inherit GIT_DIR, and a `git init` there would reinitialize the repository under test.
 */
export const gitEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> =>
  ({ ...process.env, ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])), ...extra })

/** Minimal SubprocessRuntime backed by child_process.spawn with an isolated global git config. */
export const subprocess = (config: string): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }) })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime

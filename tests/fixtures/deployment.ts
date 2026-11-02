/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, GithubAccount, Machine } from '../../src/deployment.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
/** A deployment run through GitHub and Feishu; `testChatDeployment` is the one with no code host. */
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment & { repository: string; github: GithubAccount } => ({
  ...testMachine(), repository: 'acme/widgets',
  github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
  feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
  ...overrides,
})
/** A deployment that only a chat Source runs: `testDeployment` without its repository and GitHub account. */
export const testChatDeployment = (overrides: Partial<Deployment> = {}): Deployment => {
  const { repository: _repository, github: _github, ...chat } = testDeployment()
  return { ...chat, ...overrides }
}

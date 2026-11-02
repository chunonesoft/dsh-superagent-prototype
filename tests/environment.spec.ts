import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import { GIT_LOCATION, agentVariables, credentialHelper, runAsWorker, verifyDirectory, verifyEnvironment, withoutDirectory, workerBin, workerGitConfig, writeEnvironment }
  from '../src/infra/environment.ts'
import { CliError } from '../src/infra/commands.ts'
import type { GitlabAccount } from '../src/deployment.ts'
import { testChatDeployment, testDeployment, testGitlabDeployment } from './fixtures/deployment.ts'
import { gitEnv, subprocess } from './fixtures/git.ts'

// Git and shell subprocesses can exceed the 5s default timeout when the test suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let dir: string
const program = (path: string, body: string): string => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }
/** Worker shell environment after DSH strips credential-shaped variables. */
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0])))
/** git as a worker runs it in `dir`, with the agent's variables over an operator's environment whose home is `dir`. */
const workerGit = () => {
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, ...agentVariables(dir) })
  return { env, git: async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim() }
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('worker shims', () => {
  it('run a wrapper that calls `gh` by name without reaching the shim again, and keep the caller\'s other PATH entries', async () => {
    program(join(dir, 'real', 'gh'), 'echo "{\\"login\\":\\"agent-bot\\",\\"config\\":\\"$GH_CONFIG_DIR\\",\\"path\\":\\"$PATH\\"}"')
    const wrapper = program(join(dir, 'gh-agent'), `GH_CONFIG_DIR=${dir}/agent-config exec gh "$@"`)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: wrapper }, feishu: undefined }), [])
    const bin = workerBin(dir)
    const path = [bin, join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':')
    const { stdout } = await exec('gh', ['api', 'user'], { env: { PATH: path }, timeout: 10_000 })
    expect(JSON.parse(stdout)).toEqual({ login: 'agent-bot', config: `${dir}/agent-config`, path: [join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':') })
  })
  it('make `lark-cli` fail without a Feishu bot and each blocked command fail with the agent\'s login', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    const bin = workerBin(dir)
    await expect(exec(join(bin, 'lark-cli'), ['im', '+chat-list'])).rejects.toMatchObject({ code: 1, stderr: 'lark-cli is unavailable: this installation has no Feishu bot.\n' })
    await expect(exec(join(bin, 'personal-gh'), [])).rejects.toMatchObject({ code: 1, stderr: 'personal-gh is blocked in this installation; use gh, which acts as agent-bot.\n' })
  })
  it('writes a gh shim that fails without a GitHub account', async () => {
    await writeEnvironment(testChatDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    const bin = workerBin(dir)
    await expect(exec(join(bin, 'gh'), ['api', 'user'])).rejects.toMatchObject({ code: 1, stderr: 'gh is unavailable: this installation has no GitHub account.\n' })
    // A blocked command cannot point to the agent's gh, which does not exist.
    await expect(exec(join(bin, 'personal-gh'), [])).rejects.toMatchObject({ code: 1, stderr: 'personal-gh is blocked in this installation.\n' })
  })
  it('writes a glab shim that runs the GitLab CLI, and one that fails without a GitLab account', async () => {
    const agent = program(join(dir, 'glab-agent'), 'echo glab "$@"')
    await writeEnvironment(testGitlabDeployment({ stateDir: dir, gitlab: { ...testGitlabDeployment().gitlab, cli: agent } }), ['personal-glab'])
    const bin = workerBin(dir)
    expect((await exec(join(bin, 'glab'), ['api', 'user'])).stdout).toBe('glab api user\n')
    // With a GitLab account `gh` has none to act as, and a blocked command points to the CLI that does exist.
    await expect(exec(join(bin, 'gh'), ['api', 'user'])).rejects.toMatchObject({ code: 1, stderr: 'gh is unavailable: this installation has no GitHub account.\n' })
    await expect(exec(join(bin, 'personal-glab'), [])).rejects.toMatchObject({ code: 1, stderr: 'personal-glab is blocked in this installation; use glab, which acts as agent.bot.\n' })
    // With a GitHub account, or none, glab fails the way gh does without its account.
    for (const deployment of [testDeployment({ stateDir: dir }), testChatDeployment({ stateDir: dir })]) {
      await writeEnvironment(deployment, [])
      await expect(exec(join(bin, 'glab'), ['api', 'user'])).rejects.toMatchObject({ code: 1, stderr: 'glab is unavailable: this installation has no GitLab account.\n' })
    }
  })
  it('ignores glab among the blocked commands: its shim runs the GitLab CLI, or fails without a GitLab account', async () => {
    const agent = program(join(dir, 'glab-agent'), 'echo glab "$@"')
    const bin = workerBin(dir)
    await writeEnvironment(testGitlabDeployment({ stateDir: dir, gitlab: { ...testGitlabDeployment().gitlab, cli: agent } }), ['glab'])
    expect((await exec(join(bin, 'glab'), ['api', 'user'])).stdout).toBe('glab api user\n')
    for (const deployment of [testDeployment({ stateDir: dir }), testChatDeployment({ stateDir: dir })]) {
      await writeEnvironment(deployment, ['glab'])
      await expect(exec(join(bin, 'glab'), ['api', 'user'])).rejects.toMatchObject({ code: 1, stderr: 'glab is unavailable: this installation has no GitLab account.\n' })
    }
    expect(readdirSync(bin).sort()).toEqual(['dingtalk-bot', 'gh', 'glab', 'lark-cli'])
  })
  it('keep `gh` and `lark-cli` working, and shim no `git`, when the blocked commands name the commands workers need', async () => {
    const gh = program(join(dir, 'gh-agent'), 'echo gh "$@"'), lark = program(join(dir, 'lark-bot'), 'echo lark "$@"')
    const base = testDeployment()
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github, cli: gh }, feishu: { ...base.feishu!, cli: lark } }), ['gh', 'git', 'lark-cli'])
    const bin = workerBin(dir)
    expect([(await exec(join(bin, 'gh'), ['api', 'user'])).stdout, (await exec(join(bin, 'lark-cli'), ['im'])).stdout]).toEqual(['gh api user\n', 'lark im\n'])
    expect(readdirSync(bin)).not.toContain('git')
  })
  it('replace only what dsh-superagent wrote and refuse anything else in its places', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli'])
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['dingtalk-bot', 'gh', 'glab', 'lark-cli'])
    // A file that merely contains the marker on a later line, a symlink to a shim, and a foreign gitconfig are all rejected.
    writeFileSync(join(workerBin(dir), 'notes'), `notes\nmore\n${readFileSync(join(workerBin(dir), 'gh'), 'utf8').split('\n')[1]}\n`)
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${join(workerBin(dir), 'notes')} was not written by dsh-superagent`)
    rmSync(join(workerBin(dir), 'notes'))
    symlinkSync(join(workerBin(dir), 'gh'), join(workerBin(dir), 'link'))
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('link was not written by dsh-superagent')
    rmSync(join(workerBin(dir), 'link'))
    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${workerGitConfig(dir)} was not written by dsh-superagent`)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe('[user]\n\tname = someone\n')
  })
  it('replaces the files it wrote under the project\'s earlier names', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli', 'older-cli'])
    const legacy = (file: string, name: string) => writeFileSync(file, readFileSync(file, 'utf8').replace('Written by dsh-superagent', `Written by ${name}`))
    legacy(join(workerBin(dir), 'old-cli'), 'dsh-tag'); legacy(join(workerBin(dir), 'older-cli'), 'dsh-freelancer'); legacy(workerGitConfig(dir), 'dsh-go')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['dingtalk-bot', 'gh', 'glab', 'lark-cli'])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
  })
})

describe('agent git configuration', () => {
  it('ignores the operator\'s global and system git configuration, also after DSH drops credential-shaped variables', async () => {
    const home = join(dir, 'home'); mkdirSync(home)
    // Operator configuration that rewrites HTTPS to SSH, enables commit signing, and sets a credential helper.
    writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: '/opt/agent tools/gh' } })
    await writeEnvironment(deployment, [])
    // Operator identity variables and git's fallback from the OS username must not apply to worker commits.
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(dir) })
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir, env })
    expect(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/acme/widgets.git')
    expect(await git('config', '--show-origin', '--get-all', 'credential.https://github.com.helper')).toBe(`file:${workerGitConfig(dir)}\t${credentialHelper('/opt/agent tools/gh')}`)
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
    await expect(git('config', 'commit.gpgsign')).rejects.toThrow()
    await expect(git('config', 'core.abbrev')).rejects.toThrow()
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    await expect(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity')).rejects.toMatchObject({ stderr: expect.stringContaining('no email was given') })
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
    expect(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('Alice <alice@example.com> / Alice <alice@example.com>')
  })
  it('writes the same file for a GitHub deployment as before GitLab was supported', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: '/opt/agent tools/gh' } }), [])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe([
      '# Written by dsh-superagent on every start; edits are lost.', '[user]', '\tuseConfigOnly = true', '[credential]', '\thelper =',
      '[credential "https://github.com"]', '\thelper = "!\'/opt/agent tools/gh\' auth git-credential"',
      '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
      '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true', '',
    ].join('\n'))
  })
})

describe('agent git configuration for GitLab', () => {
  const gitlab = (cli = '/opt/agent tools/glab', account: Partial<GitlabAccount> = {}) =>
    testGitlabDeployment({ stateDir: dir, gitlab: { ...testGitlabDeployment().gitlab, cli, ...account } })
  /** The address git uses for a remote, which is the one it fetches from, or with `--push` the one it pushes to. */
  const addressesOf = async () => {
    const { git } = workerGit()
    await git('init', '-q', 'repo')
    return async (remote: string, ...flags: string[]): Promise<string> => {
      await git('-C', 'repo', 'remote', 'add', 'origin', remote)
      try { return await git('-C', 'repo', 'remote', 'get-url', ...flags, 'origin') } finally { await git('-C', 'repo', 'remote', 'remove', 'origin') }
    }
  }
  /** An agent CLI that gives an account to a git credential request. */
  const credentialAgent = (): string =>
    program(join(dir, 'real', 'glab'), 'if [ "$1 $2 $3" = "auth git-credential get" ]; then cat > /dev/null; echo username=agent.bot; echo password=from-the-agent-cli; fi')
  /** What `git credential fill` answers to the request `input`. */
  const fill = (input: string) => {
    const run = exec('git', ['credential', 'fill'], { cwd: dir, env: workerGit().env, timeout: 10_000 })
    run.child.stdin?.end(`${input}\n\n`)
    return run
  }
  it('writes the credential helper for an http origin', async () => {
    await writeEnvironment(gitlab(), [])
    const config = readFileSync(workerGitConfig(dir), 'utf8')
    expect(config).toContain('[credential "http://git.example.com"]')
    expect(config).not.toContain('credential "https://github.com"')
    // git finds the agent CLI under the origin's own key, in the agent's file only.
    const { git } = workerGit()
    expect(await git('config', '--show-origin', '--get-all', 'credential.http://git.example.com.helper'))
      .toBe(`file:${workerGitConfig(dir)}\t${credentialHelper('/opt/agent tools/glab')}`)
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
  })
  it('hands the agent CLI the credential requests of the instance and no others', async () => {
    await writeEnvironment(gitlab(credentialAgent()), [])
    expect((await fill('protocol=http\nhost=git.example.com')).stdout).toContain('password=from-the-agent-cli')
    // Another host is not the instance's origin: no helper answers, and git does not ask.
    await expect(fill('protocol=http\nhost=other.example.com')).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  })
  it('rewrites the SSH addresses of the instance to its origin, so a clone uses the agent\'s account and not the operator\'s keys', async () => {
    await writeEnvironment(gitlab(), [])
    // The addresses are written quoted: bare, a `;` or `#` in a value starts a comment.
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('[url "http://git.example.com/"]\n\tinsteadOf = "git@git.example.com:"\n\tinsteadOf = "ssh://git@git.example.com/"\n')
    const address = await addressesOf()
    for (const remote of ['git@git.example.com:acme/widgets.git', 'ssh://git@git.example.com/acme/widgets.git']) {
      expect(await address(remote)).toBe('http://git.example.com/acme/widgets.git')
      expect(await address(remote, '--push')).toBe('http://git.example.com/acme/widgets.git')
    }
    // An address of another host is left as it is.
    expect(await address('git@other.example.com:acme/widgets.git')).toBe('git@other.example.com:acme/widgets.git')
  })
  it('does not let a character of the instance\'s host that git reads as a comment cut the rewrite short', async () => {
    // URL parsing admits `;` in a host, and the host comes from the instance's answer.
    const origin = 'http://git;x.example.com'
    await writeEnvironment(gitlab(undefined, { origin, webUrl: `${origin}/acme/widgets` }), [])
    const address = await addressesOf()
    expect(await address('git@git;x.example.com:acme/widgets.git')).toBe('http://git;x.example.com/acme/widgets.git')
    // Cut at the `;`, the prefix `git@git` would rewrite the address of any host that starts so.
    expect(await address('git@git.other.example:acme/widgets.git')).toBe('git@git.other.example:acme/widgets.git')
  })
  it('rewrites to the instance root when GitLab is served under a relative URL root, and keeps the credential key to scheme and host', async () => {
    await writeEnvironment(gitlab(credentialAgent(), { webUrl: 'http://git.example.com/gitlab/acme/widgets' }), [])
    const address = await addressesOf()
    for (const remote of ['git@git.example.com:acme/widgets.git', 'ssh://git@git.example.com/acme/widgets.git']) {
      expect(await address(remote)).toBe('http://git.example.com/gitlab/acme/widgets.git')
      expect(await address(remote, '--push')).toBe('http://git.example.com/gitlab/acme/widgets.git')
    }
    // A credential key with a path would match no request, so it stays the origin, and git still asks the agent CLI for that address.
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('[credential "http://git.example.com"]')
    expect((await fill('url=http://git.example.com/gitlab/acme/widgets.git')).stdout).toContain('password=from-the-agent-cli')
  })
  it('takes the origin as the root when web_url does not end with the project', async () => {
    await writeEnvironment(gitlab(undefined, { webUrl: 'http://git.example.com/acme/other' }), [])
    expect(await (await addressesOf())('git@git.example.com:acme/widgets.git')).toBe('http://git.example.com/acme/widgets.git')
  })
  it('clears the ambient credentials of the GitHub and GitLab CLIs, which they would prefer to their own configuration', () => {
    const cleared = Object.entries(agentVariables(dir)).filter(([, value]) => value === undefined).map(([name]) => name)
    expect(cleared).toEqual(expect.arrayContaining(['GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN']))
  })
})

describe('agent git configuration without a code host', () => {
  it('keeps the git isolation with no code host', async () => {
    const home = join(dir, 'home'); mkdirSync(home)
    writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[credential]\n\thelper = osxkeychain\n')
    await writeEnvironment(testChatDeployment({ stateDir: dir }), [])
    // With no GitHub account the file holds no GitHub credential helper and rewrites no address to HTTPS.
    const config = readFileSync(workerGitConfig(dir), 'utf8')
    expect(config).not.toContain('credential "https://github.com"')
    expect(config).not.toContain('\tinsteadOf')
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, ...agentVariables(dir) })
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: dir, env })
    // The operator's helper and rewrite stay out, as with an account: its rewrite to SSH would show in the address git fetches from.
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
    expect(await git('-C', 'repo', 'remote', 'get-url', 'origin')).toBe('https://github.com/acme/widgets.git')
  })
  it('stops pushes to github.com with no GitHub account', async () => {
    const { git } = workerGit()
    await git('init', '-q', 'repo')
    for (const deployment of [testChatDeployment({ stateDir: dir }), testGitlabDeployment({ stateDir: dir })]) {
      await writeEnvironment(deployment, [])
      for (const remote of ['https://github.com/acme/widgets.git', 'git@github.com:acme/widgets.git', 'ssh://git@github.com/acme/widgets.git']) {
        await git('-C', 'repo', 'remote', 'add', 'origin', remote)
        // Fetching is as it was; a push goes to an address that never resolves.
        expect(await git('-C', 'repo', 'remote', 'get-url', 'origin')).toBe(remote)
        expect(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).toBe('https://github.invalid/acme/widgets.git')
        await git('-C', 'repo', 'remote', 'remove', 'origin')
      }
    }
    // With a GitHub account the guard is not written, and its pushes go to GitHub.
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).not.toContain('github.invalid')
  })
  it('checks that git reads the agent\'s configuration, with a GitHub account, a GitLab account and none', async () => {
    writeFileSync(join(dir, 'operator'), '[credential]\n\thelper = osxkeychain\n[credential "https://github.com"]\n\thelper = osxkeychain\n[credential "http://git.example.com"]\n\thelper = osxkeychain\n')
    const signal = new AbortController().signal
    // A GitHub deployment keeps the sentence about github.com; without a GitHub account the sentence names no host.
    const unread = {
      gitTooOld: 'git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later.',
      gitConfigUnread: 'git does not read the credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later.',
    }
    const cases = [[testDeployment({ stateDir: dir }), 'gitTooOld'], [testGitlabDeployment({ stateDir: dir }), 'gitConfigUnread'],
      [testChatDeployment({ stateDir: dir }), 'gitConfigUnread']] as const
    for (const [deployment, code] of cases) {
      await writeEnvironment(deployment, [])
      await expect(verifyEnvironment(deployment, subprocess(workerGitConfig(dir)), signal)).resolves.toBeUndefined()
      // git older than 2.32 ignores GIT_CONFIG_GLOBAL and reads the operator's file instead.
      await expect(verifyEnvironment(deployment, subprocess(join(dir, 'operator')), signal)).rejects.toMatchObject({ code, message: unread[code] })
    }
  })
})

it('fails instead of asking the operator\'s askpass helpers when the agent\'s credential helper has no answer', async () => {
  const log = join(dir, 'asked')
  const askpass = program(join(dir, 'askpass'), `echo asked >> ${log}; echo operator-secret`)
  const agent = program(join(dir, 'real', 'gh'), 'exit 0')
  const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: agent } })
  await writeEnvironment(deployment, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(dir) })
  await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
  await exec('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: dir, env })
  const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

it('removes every spelling of a directory from PATH and keeps the other entries', () => {
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  symlinkSync(join(dir, 'state'), join(dir, 'link'))
  const bin = join(dir, 'state', 'worker-bin')
  expect(withoutDirectory([`${bin}/`, join(dir, 'link', 'worker-bin'), '/usr/bin', 'node_modules/.bin'].join(':'), bin)).toBe('/usr/bin:node_modules/.bin')
})

describe('ticket directory check', () => {
  const signal = new AbortController().signal
  const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' })
  const git = (...args: string[]) => exec('git', args, { cwd: dir, env: env() })
  const check = (directory: string) => verifyDirectory(join(dir, directory), subprocess(join(dir, 'global')), signal)
  beforeEach(() => { writeFileSync(join(dir, 'global'), '[credential]\n\thelper = global-helper\n') })
  it('passes a directory whose repository adds no credentials, and one outside any repository', async () => {
    await git('init', '-q', 'repo')
    await expect(check('repo')).resolves.toBeUndefined()
    // When no config key matches at all, git config --get-regexp exits with status 1.
    writeFileSync(join(dir, 'global'), '')
    await expect(check('real')).resolves.toBeUndefined()
  })
  it('names the credential settings of the repository\'s own configuration', async () => {
    await git('init', '-q', 'repo')
    await git('-C', 'repo', 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x')
    await expect(check('repo')).rejects.toThrow('sets http.https://github.com/.extraheader')
  })
  it('fails when git cannot read the repository\'s configuration, instead of passing it', async () => {
    await git('init', '-q', 'repo')
    writeFileSync(join(dir, 'repo', '.git', 'config'), '[core\n')
    await expect(check('repo')).rejects.toThrow(/bad config/)
  })
  it('reports a failed command\'s exit status', async () => {
    const failing = ['sh', '-c', 'echo nope >&2; exit 3']
    const error = await runAsWorker(subprocess(join(dir, 'global')), failing, dir, signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'nope', exitCode: 3 })
  })
})

describe('the repository the host\'s environment names', () => {
  it('is left alone by the tests\' git and named in no worker\'s environment, as when they run inside `git rebase --exec`', async () => {
    // A scratch repository stands for the one under test, which `git rebase --exec` names in GIT_DIR and GIT_WORK_TREE.
    await exec('git', ['init', '-q', 'scratch'], { cwd: dir, env: gitEnv() })
    const config = () => readFileSync(join(dir, 'scratch', '.git', 'config'), 'utf8')
    const before = config()
    vi.stubEnv('GIT_DIR', join(dir, 'scratch', '.git')); vi.stubEnv('GIT_WORK_TREE', join(dir, 'scratch'))
    // The operator's limit on git's search for a repository names none, and stays.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', dir)
    try {
      // What the tests do: a repository of their own, checked as a ticket directory.
      await exec('git', ['init', '-q', 'repo'], { cwd: dir, env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' }) })
      writeFileSync(join(dir, 'global'), '')
      await expect(verifyDirectory(join(dir, 'repo'), subprocess(join(dir, 'global')), new AbortController().signal)).resolves.toBeUndefined()
      expect(readdirSync(join(dir, 'repo'))).toContain('.git')
      expect(config()).toBe(before)
      // The worker environment, which workers' shells and the host's own commands get, names no repository.
      const env = workerEnv({ ...process.env, ...agentVariables(dir) })
      for (const name of GIT_LOCATION) expect(env, name).not.toHaveProperty(name)
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir)
    } finally { vi.unstubAllEnvs() }
  })
})

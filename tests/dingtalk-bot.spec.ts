/** The dingtalk-bot CLI: its configuration, the Stream consumer, the sends, and how a failure is reported. Every call goes to a stand-in. */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDLE_MS, ROBOT_TOPIC, handleFrame, main, openConnection, runConsume, sendMessage, type BotConfig, type Frame, type Io, type Reply }
  from '../src/cli/dingtalk-bot.ts'
import { commandError } from '../src/infra/commands.ts'

type Fetch = typeof fetch
const config: BotConfig = { clientId: 'ding123', clientSecret: 's3cret', robotCode: 'ding123' }
const API = 'https://api.dingtalk.com'
const HOOK = 'https://hooks.example.test/robot/sendBySession?session=hook-token'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dingtalk-bot-')) })
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

/** A WebSocket that records what is sent and lets a test play the gateway. */
class FakeSocket {
  sent: string[] = []
  closed = false
  private listeners: Record<string, ((event?: unknown) => void)[]> = {}
  constructor(readonly url: string) {}
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: string, listener: (event: never) => void): void { (this.listeners[type] ??= []).push(listener as (event?: unknown) => void) }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.closed = true }
  emit(type: string, event?: unknown): void { for (const listener of this.listeners[type] ?? []) listener(event) }
  frame(frame: Frame): void { this.emit('message', { data: JSON.stringify(frame) }) }
}
interface Call { url: string; headers: Record<string, string>; body: Record<string, unknown> }
const answer = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
/** A fetch that answers by address and records what it was asked; an address with no route is a test mistake. */
function respond(routes: Record<string, () => Response | Error>) {
  const calls: Call[] = []
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> })
    const route = routes[url]?.()
    if (!route) throw new Error(`Unexpected call to ${url}`)
    if (route instanceof Error) throw route
    return route
  }) as unknown as Fetch
  return { fetch: fetcher, calls }
}
const OPEN = `${API}/v1.0/gateway/connections/open`
const TOKEN = `${API}/v1.0/oauth2/accessToken`
const gateway = { [OPEN]: () => answer({ endpoint: 'wss://stream.example.test/connect', ticket: 'tick et' }) }
function setup(options: { stdin?: string | Readable; fetch?: Fetch; signal?: AbortSignal; env?: Record<string, string> } = {}) {
  const out: string[] = [], err: string[] = [], sockets: FakeSocket[] = []
  class Socket extends FakeSocket { constructor(url: string) { super(url); sockets.push(this) } }
  const io: Io = { env: { DINGTALK_BOT_CONFIG_DIR: join(dir, 'conf'), ...options.env }, stdin: typeof options.stdin === 'object' ? options.stdin : Readable.from(options.stdin ? [options.stdin] : []),
    stdout: { write: chunk => out.push(chunk) }, stderr: { write: chunk => err.push(chunk) }, fetch: options.fetch ?? respond({}).fetch,
    WebSocket: Socket, signal: options.signal ?? new AbortController().signal }
  return { io, sockets, out: () => out.join(''), err: () => err.join('') }
}
/** Writes the configuration through the CLI itself, then returns the setup that reads it. */
async function configured(options: Parameters<typeof setup>[0] = {}) {
  await main(['config', 'init', '--client-id', config.clientId, '--client-secret-stdin'], setup({ ...options, stdin: config.clientSecret }).io)
  return setup(options)
}
const reply = (messageId: string, data: string): Reply => ({ code: 200, headers: { contentType: 'application/json', messageId }, message: 'OK', data })
/** A robot message as the Stream gateway delivers it: the event is the frame's `data`, a string. */
const botMessage = { msgId: 'msg-1', conversationId: 'cid-test==', conversationType: '2', senderStaffId: 'staff-1', isInAtList: true, msgtype: 'text',
  text: { content: ' hello' }, sessionWebhook: HOOK, sessionWebhookExpiredTime: 1_790_000_000_000, robotCode: 'ding123', chatbotUserId: '$:LWCP_v1:$bot' }
const callback = (messageId: string, data: string, topic = ROBOT_TOPIC): Frame =>
  ({ specVersion: '1.0', type: 'CALLBACK', headers: { messageId, topic, contentType: 'application/json' }, data })

describe('configuration', () => {
  it('writes the config with mode 600 and reads the secret from stdin', async () => {
    const run = setup({ stdin: 's3cret\n' })
    expect(await main(['config', 'init', '--client-id', 'ding123', '--client-secret-stdin'], run.io)).toBe(0)
    const file = join(dir, 'conf', 'config.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // The robot code is the app's key unless it is given, and the secret is the line on stdin without its newline.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(config)
    expect(run.out() + run.err()).not.toContain('s3cret')
    await main(['config', 'init', '--client-id', 'ding123', '--client-secret-stdin', '--robot-code', 'ding-robot'], setup({ stdin: 's3cret' }).io)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ robotCode: 'ding-robot' })
    // A secret on the command line would show in the process list, so no option takes one, and the refusal does not repeat it.
    const argument = setup()
    expect(await main(['config', 'init', '--client-id', 'ding123', '--client-secret', 'argv-secret'], argument.io)).toBe(1)
    expect(argument.err()).not.toContain('argv-secret')
  })

  it('reports the app and robot once a token can be had, and says what to do without a configuration', async () => {
    const missing = setup()
    expect(await main(['auth', 'status'], missing.io)).toBe(1)
    expect(JSON.parse(missing.err())).toEqual({ error: { message: expect.stringContaining('config init') } })
    const { fetch } = respond({ [TOKEN]: () => answer({ accessToken: 'tok-1', expireIn: 7200 }) })
    const ok = await configured({ fetch })
    expect(await main(['auth', 'status'], ok.io)).toBe(0)
    expect(JSON.parse(ok.out())).toEqual({ clientId: 'ding123', robotCode: 'ding123', token: 'ok' })
  })
})

describe('event consume', () => {
  it('prints each robot message as one line and acknowledges it', async () => {
    const { fetch, calls } = respond(gateway)
    const abort = new AbortController()
    const run = setup({ fetch, signal: abort.signal })
    const consuming = runConsume(config, run.io)
    await vi.waitFor(() => { expect(run.sockets).toHaveLength(1) })
    const socket = run.sockets[0]!
    // The subscription names the robot's topic, and the ticket is part of the address.
    expect(calls[0]!.body).toEqual({ clientId: 'ding123', clientSecret: 's3cret', subscriptions: [{ type: 'CALLBACK', topic: ROBOT_TOPIC }], ua: 'dsh-superagent' })
    expect(socket.url).toBe('wss://stream.example.test/connect?ticket=tick%20et')
    socket.emit('open')
    expect(run.err()).toBe('[event] ready\n')
    // The gateway may pretty-print the event; the output is still one line.
    socket.frame(callback('frame-1', JSON.stringify(botMessage, null, 2)))
    expect(run.out()).toBe(`${JSON.stringify(botMessage)}\n`)
    expect(socket.sent.map(sent => JSON.parse(sent))).toEqual([reply('frame-1', '{"response":null}')])
    // What is not a robot message, or not JSON, is acknowledged without a line, so the gateway does not send it again.
    socket.frame(callback('frame-2', '{"other":true}', '/v1.0/other'))
    socket.frame(callback('frame-3', 'not json'))
    expect(run.out()).toBe(`${JSON.stringify(botMessage)}\n`)
    expect(socket.sent.map(sent => (JSON.parse(sent) as Reply).headers.messageId)).toEqual(['frame-1', 'frame-2', 'frame-3'])
    abort.abort()
    await expect(consuming).resolves.toBeUndefined()
    expect(socket.closed).toBe(true)
  })

  it('answers ping with its data and exits on disconnect', async () => {
    // A frame on its own: the reply carries the ping's data as it came.
    const replies: Reply[] = []
    const send = { reply: (frame: Reply) => replies.push(frame), message: vi.fn(), disconnect: vi.fn() }
    handleFrame({ type: 'SYSTEM', headers: { messageId: 'p0', topic: 'ping' }, data: '{"opaque":"abc"}' }, send)
    expect(replies).toEqual([reply('p0', '{"opaque":"abc"}')])
    expect([send.message.mock.calls.length, send.disconnect.mock.calls.length]).toEqual([0, 0])
    handleFrame({ type: 'SYSTEM', headers: { messageId: 'd0', topic: 'disconnect' }, data: '{}' }, send)
    expect([replies.length, send.disconnect.mock.calls.length]).toEqual([1, 1])

    // On a connection, the process ends with an error line when the gateway disconnects, and the host starts it again.
    const { fetch } = respond(gateway)
    // The host holds stdin open for as long as it wants the consumer.
    const run = await configured({ fetch, stdin: new PassThrough() })
    const ended = main(['event', 'consume'], run.io)
    await vi.waitFor(() => { expect(run.sockets).toHaveLength(1) })
    const socket = run.sockets[0]!
    socket.emit('open')
    socket.frame({ type: 'SYSTEM', headers: { messageId: 'p1', topic: 'ping' }, data: '{"opaque":"xyz"}' })
    expect(socket.sent.map(sent => JSON.parse(sent))).toEqual([reply('p1', '{"opaque":"xyz"}')])
    socket.frame({ type: 'SYSTEM', headers: { messageId: 'd1', topic: 'disconnect' }, data: '{}' })
    expect(await ended).toBe(1)
    expect(socket.closed).toBe(true)
    expect(JSON.parse(run.err().split('\n').filter(line => line.startsWith('{'))[0]!)).toEqual({ error: { message: expect.stringContaining('disconnect') } })
  })

  it('ends quietly when its stdin closes, as it does when the host is gone', async () => {
    const { fetch } = respond(gateway)
    const host = new PassThrough()
    const run = await configured({ fetch, stdin: host })
    const ended = main(['event', 'consume'], run.io)
    await vi.waitFor(() => { expect(run.sockets).toHaveLength(1) })
    const socket = run.sockets[0]!
    socket.emit('open')
    // Anything the host writes is ignored; only the end of the pipe counts.
    host.write('noise\n')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(socket.closed).toBe(false)
    host.end()
    expect(await ended).toBe(0)
    expect(socket.closed).toBe(true)
    expect(run.out()).toBe('')
  })

  it('ends when the connection closes or goes silent, and quietly when told to stop', async () => {
    const { fetch } = respond(gateway)
    const open = async () => {
      const run = setup({ fetch })
      const consuming = runConsume(config, run.io)
      await vi.waitFor(() => { expect(run.sockets).toHaveLength(1) })
      return { socket: run.sockets[0]!, consuming }
    }
    const closed = await open()
    closed.socket.emit('close')
    await expect(closed.consuming).rejects.toThrow('closed')
    vi.useFakeTimers()
    const silent = await open()
    silent.socket.emit('open')
    // Any frame, a ping included, keeps the connection; none for IDLE_MS ends it.
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    silent.socket.frame({ type: 'SYSTEM', headers: { messageId: 'p', topic: 'ping' }, data: '{}' })
    const outcome = expect(silent.consuming).rejects.toThrow('silent')
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(silent.socket.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await outcome
    expect(silent.socket.closed).toBe(true)
  })
})

describe('message send', () => {
  const send = ['message', 'send', '--conversation', 'cid-test==', '--title', 'dsh #a1b2c3d4', '--text-stdin']

  it('sends to a live webhook with the people it mentions', async () => {
    const { fetch, calls } = respond({ [HOOK]: () => answer({ errcode: 0, errmsg: 'ok' }) })
    const run = await configured({ fetch, stdin: 'Done, see the report.\n' })
    expect(await main([...send, '--webhook', HOOK, '--at', 'staff-1', '--at', 'staff-2'], run.io)).toBe(0)
    expect(JSON.parse(run.out())).toEqual({ ok: true })
    // A webhook needs no token. The text names the people, as Markdown mentions only show then, and `at` lists them.
    expect(calls).toEqual([{ url: HOOK, headers: expect.any(Object), body: { msgtype: 'markdown',
      markdown: { title: 'dsh #a1b2c3d4', text: '@staff-1 @staff-2\n\nDone, see the report.' }, at: { atUserIds: ['staff-1', 'staff-2'] } } }])
    // Someone the text already names is not named twice.
    const again = await configured({ fetch, stdin: 'Hi @staff-1' })
    await main([...send, '--webhook', HOOK, '--at', 'staff-1'], again.io)
    expect(calls[1]!.body).toMatchObject({ markdown: { text: 'Hi @staff-1' }, at: { atUserIds: ['staff-1'] } })
  })

  it('reads the webhook from its variable only when told to', async () => {
    const { fetch, calls } = respond({ [HOOK]: () => answer({ errcode: 0, errmsg: 'ok' }) })
    const run = await configured({ fetch, stdin: 'Done.', env: { DINGTALK_BOT_WEBHOOK: HOOK } })
    expect(await main([...send, '--webhook-env', '--at', 'staff-1'], run.io)).toBe(0)
    expect(calls.map(call => call.url)).toEqual([HOOK])
    // A variable left in the environment does not turn a send into a webhook send.
    const ambient = respond({ [TOKEN]: () => answer({ accessToken: 'tok-1' }), [`${API}/v1.0/robot/groupMessages/send`]: () => answer({ processQueryKey: 'k' }) })
    expect(await main(send, (await configured({ fetch: ambient.fetch, stdin: 'x', env: { DINGTALK_BOT_WEBHOOK: HOOK } })).io)).toBe(0)
    expect(ambient.calls.map(call => call.url)).not.toContain(HOOK)
    // Asked for and missing, it fails rather than sending another way; a refusal hides the address as an argument's would be.
    const empty = await configured({ fetch, stdin: 'x' })
    expect(await main([...send, '--webhook-env'], empty.io)).toBe(1)
    expect(empty.err()).toContain('DINGTALK_BOT_WEBHOOK')
    const refusing = respond({ [HOOK]: () => answer({ errcode: 310000, errmsg: `bad ${HOOK}` }) })
    const hidden = await configured({ fetch: refusing.fetch, stdin: 'x', env: { DINGTALK_BOT_WEBHOOK: HOOK } })
    expect(await main([...send, '--webhook-env'], hidden.io)).toBe(1)
    expect(hidden.err()).not.toContain('hook-token')
  })

  it('refuses a webhook that DingTalk turns down, without repeating its address', async () => {
    const { fetch } = respond({ [HOOK]: () => answer({ errcode: 310000, errmsg: 'session expired' }) })
    const run = await configured({ fetch, stdin: 'x' })
    expect(await main([...send, '--webhook', HOOK], run.io)).toBe(1)
    expect(JSON.parse(run.err())).toEqual({ error: { code: 310000, message: 'DingTalk refused the webhook message: session expired' } })
    expect(run.err()).not.toContain('hook-token')
    const elsewhere = await configured({ fetch, stdin: 'x' })
    expect(await main([...send, '--webhook', 'http://hooks.example.test/robot'], elsewhere.io)).toBe(1)
    expect(elsewhere.err()).toContain('https')
  })

  it('sends through the OpenAPI without a webhook', async () => {
    const { fetch, calls } = respond({ [TOKEN]: () => answer({ accessToken: 'tok-1', expireIn: 7200 }),
      [`${API}/v1.0/robot/groupMessages/send`]: () => answer({ processQueryKey: 'key-1' }),
      [`${API}/v1.0/robot/oToMessages/batchSend`]: () => answer({ processQueryKey: 'key-2', invalidStaffIdList: [], flowControlStaffIdList: [] }) })
    const run = await configured({ fetch, stdin: 'Done.\n' })
    expect(await main([...send, '--at', 'staff-1'], run.io)).toBe(0)
    expect(JSON.parse(run.out())).toEqual({ key: 'key-1' })
    expect(calls[0]).toMatchObject({ url: TOKEN, body: { appKey: 'ding123', appSecret: 's3cret' } })
    // `msgParam` is a string of JSON, as the API takes it, and the API cannot mention anyone.
    expect(calls[1]).toMatchObject({ url: `${API}/v1.0/robot/groupMessages/send`, headers: { 'x-acs-dingtalk-access-token': 'tok-1' },
      body: { robotCode: 'ding123', openConversationId: 'cid-test==', msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 'dsh #a1b2c3d4', text: 'Done.' }) } })
    // A direct chat is reached by the person's staff ID.
    const direct = await configured({ fetch, stdin: 'Done.' })
    expect(await main(['message', 'send', '--user', 'staff-1', '--title', 'dsh #a1b2c3d4', '--text-stdin'], direct.io)).toBe(0)
    expect(JSON.parse(direct.out())).toEqual({ key: 'key-2' })
    expect(calls.at(-1)).toMatchObject({ url: `${API}/v1.0/robot/oToMessages/batchSend`, body: { robotCode: 'ding123', userIds: ['staff-1'], msgKey: 'sampleMarkdown' } })
    // DingTalk lists the people it did not send to, and that is a failure.
    const refused = respond({ [TOKEN]: () => answer({ accessToken: 'tok-1' }),
      [`${API}/v1.0/robot/oToMessages/batchSend`]: () => answer({ processQueryKey: 'k', invalidStaffIdList: ['staff-1'], flowControlStaffIdList: [] }) })
    const unknown = await configured({ fetch: refused.fetch, stdin: 'x' })
    expect(await main(['message', 'send', '--user', 'staff-1', '--title', 't', '--text-stdin'], unknown.io)).toBe(1)
    expect(JSON.parse(unknown.err())).toMatchObject({ error: { code: 400 } })
  })

  it('sends nowhere without a target', async () => {
    const { fetch } = respond({ [TOKEN]: () => answer({ accessToken: 'tok-1' }) })
    const run = await configured({ fetch, stdin: 'x' })
    expect(await main(['message', 'send', '--title', 't', '--text-stdin'], run.io)).toBe(1)
    expect(run.err()).toContain('Name a conversation')
  })
})

describe('failures', () => {
  it('never prints the secret in an error', async () => {
    // A network error that echoes the request, and an answer that echoes the secret, are both blanked out.
    for (const route of [() => new Error('connect ECONNREFUSED: {"clientSecret":"s3cret"}'), () => answer({ code: 'InvalidAuthentication', message: 'bad secret s3cret' }, 401)]) {
      const { fetch } = respond({ [OPEN]: route })
      const run = await configured({ fetch })
      expect(await main(['event', 'consume'], run.io)).toBe(1)
      expect(run.err()).not.toContain('s3cret')
      expect(run.out()).toBe('')
      expect(run.sockets).toHaveLength(0)
    }
    await expect(openConnection(config, respond({ [OPEN]: () => new Error('unreachable') }).fetch)).rejects.toThrow('Could not reach DingTalk: unreachable')
    await expect(sendMessage(config, { title: 't', text: 'x', webhook: HOOK }, respond({ [HOOK]: () => new Error(`posting to ${HOOK} failed`) }).fetch))
      .rejects.toThrow('Could not reach DingTalk: posting to *** failed')
  })

  it('reports a failed call in the shape commandError reads', async () => {
    const { fetch } = respond({ [TOKEN]: () => answer({ code: 'Forbidden.AccessDenied', message: 'no permission', requestid: 'r-1' }, 403) })
    const run = await configured({ fetch })
    expect(await main(['auth', 'status'], run.io)).toBe(1)
    expect(JSON.parse(run.err())).toEqual({ error: { code: 403, message: 'Forbidden.AccessDenied: no permission' } })
    // The host reads it as it reads any CLI: the status is the code, and nothing of the request is in the message.
    const failure = Object.assign(new Error('Command failed'), { code: 1, stderr: run.err() })
    expect(commandError(failure, '/usr/local/bin/dingtalk-bot')).toMatchObject({ message: 'Forbidden.AccessDenied: no permission (403)', code: 403, exitCode: 1 })
    // Without an answer there is no status to report.
    const none = await configured({ fetch: respond({ [TOKEN]: () => new Error('offline') }).fetch })
    await main(['auth', 'status'], none.io)
    expect(JSON.parse(none.err())).toEqual({ error: { message: 'Could not reach DingTalk: offline' } })
  })
})

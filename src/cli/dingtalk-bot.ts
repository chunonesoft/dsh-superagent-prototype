/**
 * The `dingtalk-bot` CLI: a DingTalk enterprise robot over Stream mode and the robot API, with the commands the DingTalk Source needs of a
 * bot CLI (`config init`, `auth status`, `event consume`, `message send`). It uses only Node's `fetch` and `WebSocket`, which connect
 * directly, and it reads no proxy variable itself. It imports nothing of the package, so it runs alone as `lib/dingtalk-bot.js`.
 * The client secret lives in the CLI's own configuration directory (mode 600) and nowhere else: no output, log line or error holds it.
 */
import { realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const API = 'https://api.dingtalk.com'
/** The Stream topic of the messages people send to the robot. */
export const ROBOT_TOPIC = '/v1.0/im/bot/messages/get'
/** A connection that hears nothing, not even the gateway's pings, for this long is taken for dead; the host restarts the consumer. */
export const IDLE_MS = 300_000
/** The variable `message send --webhook-env` reads the session webhook from: an argument would show in the process list. */
export const WEBHOOK_VARIABLE = 'DINGTALK_BOT_WEBHOOK'

export interface BotConfig { clientId: string; clientSecret: string; robotCode: string }
type Fetch = typeof fetch
interface Writer { write(chunk: string): unknown }

/** A failed call. `status` is the HTTP status (or the code DingTalk's webhook reports); 0 when the call got no answer. */
export class BotError extends Error { constructor(message: string, readonly status = 0) { super(message) } }

/** The robot API's message type that renders Markdown, which both a group and a direct send use. */
const MSG_KEY = 'sampleMarkdown'
const json = (body: unknown, headers: Record<string, string> = {}): RequestInit =>
  ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'error' })
/** What an error says without the request: its message and the system code beneath it, such as ECONNREFUSED. */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined
  return (typeof code === 'string' ? `${message} (${code})` : message).slice(0, 300)
}
/**
 * Calls DingTalk and returns the JSON object it answers. A failure carries the HTTP status and what DingTalk said, never the request;
 * `secrets` (the client secret, a webhook address, a token) are blanked out of whatever an answer or a network error says.
 */
async function call(fetch: Fetch, url: string, init: RequestInit, secrets: readonly string[]): Promise<Record<string, unknown>> {
  const hide = (text: string): string => secrets.filter(Boolean).reduce((result, secret) => result.replaceAll(secret, '***'), text)
  let response: Response
  try { response = await fetch(url, init) }
  catch (error) { throw new BotError(`Could not reach DingTalk: ${hide(reason(error))}`) }
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await response.text())
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
  } catch { /* An answer that is not JSON has no fields to read. */ }
  if (response.ok) return body
  const said = [body.code, body.message ?? body.errmsg].filter(part => typeof part === 'string' && part).join(': ')
  throw new BotError(hide(said || `DingTalk answered HTTP ${response.status}`), response.status)
}
const text = (value: unknown): string => typeof value === 'string' ? value : ''

export const configDir = (env: Record<string, string | undefined>): string => env.DINGTALK_BOT_CONFIG_DIR || join(homedir(), '.config', 'dingtalk-bot')
/** Writes the configuration atomically with mode 600; a directory this creates is private to the user too. */
export async function writeConfig(dir: string, config: BotConfig): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'config.json'), temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  // `mode` applies only to a file that is created, so a leftover temporary file is made private too.
  await chmod(temporary, 0o600)
  await rename(temporary, file)
}
export async function readConfig(dir: string): Promise<BotConfig> {
  const hint = `Run: dingtalk-bot config init --client-id <id> --client-secret-stdin (configuration directory ${dir})`
  let stored: unknown
  try { stored = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) }
  catch (error) { throw new BotError((error as NodeJS.ErrnoException).code === 'ENOENT' ? `No configuration found. ${hint}` : `The configuration cannot be read. ${hint}`) }
  const { clientId, clientSecret, robotCode } = (stored ?? {}) as Record<string, unknown>
  if (!text(clientId) || !text(clientSecret) || !text(robotCode)) throw new BotError(`The configuration is incomplete. ${hint}`)
  return { clientId: text(clientId), clientSecret: text(clientSecret), robotCode: text(robotCode) }
}

/**
 * Opens a Stream connection that receives the robot's messages and returns the address of its WebSocket.
 * @throws BotError when the gateway refuses the credentials or names no endpoint.
 */
export async function openConnection(config: BotConfig, fetch: Fetch): Promise<string> {
  const body = await call(fetch, `${API}/v1.0/gateway/connections/open`, json({ clientId: config.clientId, clientSecret: config.clientSecret,
    subscriptions: [{ type: 'CALLBACK', topic: ROBOT_TOPIC }], ua: 'dsh-superagent' }), [config.clientSecret])
  const { endpoint, ticket } = body
  if (!text(endpoint) || !text(ticket)) throw new BotError('DingTalk did not name a Stream endpoint')
  return `${text(endpoint)}?ticket=${encodeURIComponent(text(ticket))}`
}
/** An access token of the app, which the robot API takes in the `x-acs-dingtalk-access-token` header. */
async function accessToken(config: BotConfig, fetch: Fetch): Promise<string> {
  const body = await call(fetch, `${API}/v1.0/oauth2/accessToken`, json({ appKey: config.clientId, appSecret: config.clientSecret }), [config.clientSecret])
  if (!text(body.accessToken)) throw new BotError('DingTalk did not return an access token')
  return text(body.accessToken)
}

export interface SendInput {
  title: string; text: string
  /** The conversation to send to (`openConversationId`), or the person (`staffId`) in a direct chat. */
  conversation?: string | undefined; user?: string | undefined
  /** A live `sessionWebhook`, which can mention people; without it the robot API sends. */
  webhook?: string | undefined; at?: readonly string[] | undefined
}
/**
 * Sends a Markdown message and returns `{ key }` (the robot API's message key) or `{ ok: true }` (through a webhook, which names none).
 * A webhook that DingTalk refuses fails with the code it reports, as a failed API call fails with its HTTP status.
 */
export async function sendMessage(config: BotConfig, input: SendInput, fetch: Fetch): Promise<{ key: string } | { ok: true }> {
  const { title, text: body } = input
  const { webhook } = input
  if (webhook) {
    if (!URL.canParse(webhook) || new URL(webhook).protocol !== 'https:') throw new BotError('The webhook is not an https address')
    // Markdown mentions only show when the text names the person too.
    const named = (input.at ?? []).filter(id => !body.includes(`@${id}`)).map(id => `@${id}`)
    const shown = named.length ? `${named.join(' ')}\n\n${body}` : body
    const answer = await call(fetch, webhook, json({ msgtype: 'markdown', markdown: { title, text: shown }, at: { atUserIds: input.at ?? [] } }), [webhook])
    if (answer.errcode !== 0) throw new BotError(`DingTalk refused the webhook message: ${text(answer.errmsg) || 'no reason given'}`.slice(0, 300), Number(answer.errcode) || 0)
    return { ok: true }
  }
  if (!input.user && !input.conversation) throw new BotError('Name a conversation, a person or a webhook to send to')
  const headers = { 'x-acs-dingtalk-access-token': await accessToken(config, fetch) }
  const msgParam = JSON.stringify({ title, text: body })
  const secrets = [config.clientSecret, headers['x-acs-dingtalk-access-token']]
  if (input.user) {
    const answer = await call(fetch, `${API}/v1.0/robot/oToMessages/batchSend`, json({ robotCode: config.robotCode, userIds: [input.user], msgKey: MSG_KEY, msgParam }, headers), secrets)
    const listed = (name: string): boolean => { const list = answer[name]; return Array.isArray(list) && list.includes(input.user) }
    if (listed('invalidStaffIdList')) throw new BotError('DingTalk does not know the person to send to', 400)
    if (listed('flowControlStaffIdList')) throw new BotError('DingTalk is limiting the messages to this person', 429)
    return { key: text(answer.processQueryKey) }
  }
  const answer = await call(fetch, `${API}/v1.0/robot/groupMessages/send`, json({ robotCode: config.robotCode, openConversationId: input.conversation, msgKey: MSG_KEY, msgParam }, headers), secrets)
  return { key: text(answer.processQueryKey) }
}

export interface Frame { specVersion?: string; type?: string; headers?: { messageId?: string; topic?: string; [name: string]: unknown }; data?: string }
export interface Reply { code: 200; headers: { contentType: 'application/json'; messageId: string }; message: 'OK'; data: string }
/** Where a frame's effects go: the reply to the gateway, a robot message to stdout, and the end of the connection. */
export interface Sender { reply(frame: Reply): void; message(line: string): void; disconnect(): void }
const reply = (messageId: string, data: string): Reply => ({ code: 200, headers: { contentType: 'application/json', messageId }, message: 'OK', data })
/** A frame's data as one line, or undefined when it is not JSON. */
function oneLine(data: string): string | undefined {
  try { return JSON.stringify(JSON.parse(data)) } catch { return undefined /* Nothing a Source could read. */ }
}
/**
 * Acts on one frame of the Stream connection: a robot message goes to the output as one line and is acknowledged with the id of the
 * frame, so DingTalk does not send it again; a ping is answered with its own data; a disconnect ends the connection.
 */
export function handleFrame(frame: Frame, send: Sender): void {
  const messageId = frame.headers?.messageId
  if (frame.type === 'SYSTEM') {
    if (frame.headers?.topic === 'ping' && messageId) send.reply(reply(messageId, frame.data ?? ''))
    else if (frame.headers?.topic === 'disconnect') send.disconnect()
    return
  }
  if (frame.type !== 'CALLBACK') return
  // The message is out before its acknowledgement: a crash in between makes DingTalk deliver it again under the same msgId.
  const line = frame.headers?.topic === ROBOT_TOPIC && frame.data ? oneLine(frame.data) : undefined
  if (line) send.message(line)
  if (messageId) send.reply(reply(messageId, '{"response":null}'))
}

/** The part of the WebSocket API the consumer uses, which Node's global WebSocket and a test's stand-in both have. */
export interface Socket {
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}
export interface ConsumeIo { fetch: Fetch; WebSocket: new (url: string) => Socket; stdout: Writer; stderr: Writer; signal: AbortSignal }
/**
 * Prints the robot's messages as one JSON line each until the signal aborts, which ends it quietly; as a command it also ends when its
 * stdin closes, so a consumer whose host is gone does not keep the robot's connection. It writes `[event] ready` to stderr
 * once connected, and fails with a BotError when the connection ends, is told to disconnect or goes silent: the host restarts it.
 */
export async function runConsume(config: BotConfig, io: ConsumeIo): Promise<void> {
  const { stdout, stderr, signal } = io
  const url = await openConnection(config, (address, init) => io.fetch(address, { ...init, signal }))
  if (signal.aborted) return
  await new Promise<void>((resolve, reject) => {
    const socket = new io.WebSocket(url)
    let idle: ReturnType<typeof setTimeout> | undefined
    let ended = false
    const end = (failure?: BotError): void => {
      if (ended) return
      ended = true; clearTimeout(idle); signal.removeEventListener('abort', aborted)
      try { socket.close() } catch { /* A socket that is already closed has nothing to close. */ }
      if (failure) reject(failure); else resolve()
    }
    const aborted = (): void => end()
    const hearing = (): void => { clearTimeout(idle); idle = setTimeout(() => end(new BotError('The connection to DingTalk went silent')), IDLE_MS) }
    signal.addEventListener('abort', aborted, { once: true })
    socket.addEventListener('open', () => { hearing(); stderr.write('[event] ready\n') })
    socket.addEventListener('error', () => end(new BotError('The connection to DingTalk failed')))
    socket.addEventListener('close', () => end(new BotError('The connection to DingTalk closed')))
    socket.addEventListener('message', event => {
      hearing()
      let frame: Frame
      try { frame = JSON.parse(String(event.data)) as Frame } catch { return /* Not a frame; the gateway sends JSON. */ }
      handleFrame(frame ?? {}, { reply: sent => { socket.send(JSON.stringify(sent)) }, message: line => { stdout.write(`${line}\n`) },
        disconnect: () => end(new BotError('DingTalk asked the consumer to disconnect')) })
    })
  })
}

export interface Io {
  env: Record<string, string | undefined>
  stdin: AsyncIterable<string | Uint8Array>
  stdout: Writer; stderr: Writer; fetch: Fetch; WebSocket: ConsumeIo['WebSocket']; signal: AbortSignal
}
async function readAll(stream: Io['stdin']): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
/** The command words and options; a malformed command line says so without echoing it, since an argument could be a secret. */
function parse(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: { 'client-id': { type: 'string' }, 'client-secret-stdin': { type: 'boolean' },
      'robot-code': { type: 'string' }, conversation: { type: 'string' }, user: { type: 'string' }, title: { type: 'string' },
      'text-stdin': { type: 'boolean' }, webhook: { type: 'string' }, 'webhook-env': { type: 'boolean' }, at: { type: 'string', multiple: true } } })
  } catch { throw new BotError('Unrecognized command line. Commands: config init, auth status, event consume, message send') }
}
async function dispatch(argv: string[], io: Io, secrets: string[]): Promise<unknown> {
  const { positionals, values } = parse(argv)
  const dir = configDir(io.env)
  const configured = async (): Promise<BotConfig> => {
    const config = await readConfig(dir)
    secrets.push(config.clientSecret)
    return config
  }
  switch (positionals.join(' ')) {
    case 'config init': {
      if (!values['client-id'] || !values['client-secret-stdin']) throw new BotError('Pass --client-id and --client-secret-stdin; the secret is read from stdin, never from an argument')
      const clientSecret = (await readAll(io.stdin)).trim()
      secrets.push(clientSecret)
      if (!clientSecret) throw new BotError('The client secret on stdin is empty')
      await writeConfig(dir, { clientId: values['client-id'], clientSecret, robotCode: values['robot-code'] || values['client-id'] })
      return { ok: true }
    }
    case 'auth status': {
      const config = await configured()
      await accessToken(config, io.fetch)
      return { clientId: config.clientId, robotCode: config.robotCode, token: 'ok' }
    }
    case 'event consume': {
      const config = await configured()
      // The host holds the consumer's stdin open and never writes to it. When that pipe closes, the host is gone, even one killed too
      // hard to stop its children, and a consumer that stayed would keep a Stream connection that takes the robot's messages from the next.
      const orphaned = new AbortController()
      void (async () => { try { for await (const _ of io.stdin) { /* Nothing is read from the host. */ } } catch { /* A broken pipe ends it too. */ } orphaned.abort() })()
      return runConsume(config, { ...io, signal: AbortSignal.any([io.signal, orphaned.signal]) })
    }
    case 'message send': {
      if (!values.title || !values['text-stdin']) throw new BotError('Pass --title and --text-stdin; the text is read from stdin')
      const config = await configured()
      // Read only when asked for, so a variable left in a shell never turns a send into a webhook send.
      const webhook = values['webhook-env'] ? io.env[WEBHOOK_VARIABLE] : values.webhook
      if (values['webhook-env'] && !webhook) throw new BotError(`--webhook-env reads the webhook from ${WEBHOOK_VARIABLE}, which is empty`)
      if (webhook) secrets.push(webhook)
      return sendMessage(config, { title: values.title, text: (await readAll(io.stdin)).replace(/\n$/, ''), conversation: values.conversation,
        user: values.user, webhook, at: values.at }, io.fetch)
    }
    default: throw new BotError('Unrecognized command. Commands: config init, auth status, event consume, message send')
  }
}
/**
 * Runs one command: a result prints as one JSON line on stdout, and a failure as `{"error":{"code","message"}}` on stderr (the shape
 * of `commandError`), where `code` is the HTTP status and is left out when the call got no answer. Returns the exit code.
 */
export async function main(argv: string[], io: Io): Promise<number> {
  const secrets: string[] = []
  try {
    const result = await dispatch(argv, io, secrets)
    if (result !== undefined) io.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    const failure = error instanceof BotError ? error : new BotError(reason(error))
    const message = secrets.filter(Boolean).reduce((result, secret) => result.replaceAll(secret, '***'), failure.message)
    io.stderr.write(`${JSON.stringify({ error: { ...failure.status ? { code: failure.status } : {}, message } })}\n`)
    return 1
  }
}
/** Runs the CLI as the process: SIGTERM and SIGINT end a consumer without an error. */
export async function run(): Promise<void> {
  const abort = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { abort.abort() })
  const code = await main(process.argv.slice(2), { env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
    fetch, WebSocket, signal: abort.signal })
  process.exitCode = code
  // A socket that does not finish closing must not keep the process: the host waits for it to exit.
  setTimeout(() => { process.exit(code) }, 3000).unref()
}
/** `node lib/dingtalk-bot.js …` runs the CLI; `bin/dingtalk-bot` and the tests import it instead. */
const sameFile = (a: string, b: string): boolean => { try { return realpathSync(a) === realpathSync(b) } catch { return false /* Not a file, so not this one. */ } }
if (process.argv[1] && sameFile(process.argv[1], fileURLToPath(import.meta.url))) void run()

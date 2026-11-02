/** DingTalk background loops: the live event consumer that turns robot messages into Triggers, and the upkeep of what a quote needs. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { threadKey, type Trigger } from '../core/index.ts'
import type { DingtalkBot } from '../deployment.ts'
import { KV } from '../kv.ts'
import type { DingtalkConfig } from './dingtalk.ts'
import { BotMessageSchema, SOURCE, dingtalkTrigger, threadMarker, type BotMessage, type Roots } from './dingtalk-trigger.ts'
import { consumerRetry } from './feishu-loops.ts'
import { health, type SourceContext } from './host.ts'

/** How long the Source remembers a message or a marker for the quotes that come after. */
const RETAIN_MS = 14 * 86_400_000

export const runDingtalk = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> =>
  Promise.allSettled([watch, upkeep].map(loop => loop(ctx, signal)))
const enabled = (ctx: SourceContext): DingtalkConfig | undefined => ctx.config<DingtalkConfig>(SOURCE)
const bot = (ctx: SourceContext): DingtalkBot => {
  const resolved = ctx.deployment.dingtalk
  if (!resolved) throw new Error('The DingTalk Source has no working bot CLI')
  return resolved
}
function available(ctx: SourceContext): boolean {
  if (ctx.configured() && ctx.deployment.dingtalk) return true
  const waiting = health('paused', ctx.configured() ? 'dingtalkCliUnset' : 'setupPending')
  ctx.report('dingtalk', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}

/** The Threads that earlier messages and replies belong to, as the Source remembers them; an entry older than its time is forgotten. */
const roots = (ctx: SourceContext): Roots => {
  const recent = (entry: { thread: string; at: string } | undefined): string | undefined =>
    entry && Date.now() - Date.parse(entry.at) < RETAIN_MS ? entry.thread : undefined
  return { rootOf: id => recent(ctx.state.get(KV.dingtalk.root(id))), markedThread: marker => recent(ctx.state.get(KV.dingtalk.marker(marker))) }
}
/** Reads one line of the consumer's output. A failure says what is wrong with the line, never what it holds: that includes a session webhook. */
function read(line: string): BotMessage {
  let value: unknown
  try { value = JSON.parse(line) } catch { throw new Error('DingTalk event is not valid JSON') }
  const result = BotMessageSchema.safeParse(value)
  if (!result.success) throw new Error(`DingTalk event is unreadable: ${[...new Set(result.error.issues.map(issue => issue.path.join('.') || 'event'))].join(', ')}`)
  return result.data
}
async function receive(ctx: SourceContext, trigger: Trigger, message: BotMessage): Promise<void> {
  const ref = trigger.threads[0]!
  const seen = new Date().toISOString()
  // Every reply of the Thread is titled with its marker, so what the marker stands for is recorded before any reply is sent.
  ctx.state.set(KV.dingtalk.marker(threadMarker(threadKey(ref))), { thread: ref.id, at: seen })
  ctx.state.set(KV.dingtalk.root(message.msgId), { thread: ref.id, at: seen })
  await ctx.receive(trigger)
  const direct = trigger.meta.direct === true
  // DingTalk lists no chats; a group's name is the title its messages bring.
  if (!direct && message.conversationTitle) {
    const labels = ctx.state.get(KV.sources.labels(SOURCE)) ?? {}
    if (labels[message.conversationId] !== message.conversationTitle) ctx.state.set(KV.sources.labels(SOURCE), { ...labels, [message.conversationId]: message.conversationTitle })
  }
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[message.conversationId] ?? message.conversationId
  const chat = direct ? { value: { zh: '私聊', en: 'Direct message' } } : { value: name }
  for (const thread of trigger.threads) ctx.threads.describe(threadKey(thread), { facts: { chat } })
}

/** Runs the live event consumer only while the Source is enabled; disabling it stops the consumer within five seconds. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the bot; until then nothing runs.
  if (!available(ctx)) return
  let retry: number | undefined
  while (!signal.aborted) {
    if (!enabled(ctx)) {
      ctx.report('dingtalk', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    const check = setInterval(() => { if (!enabled(ctx)) running.abort() }, 5000)
    const stop = () => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    try { await consume(ctx, running.signal) }
    catch (error) { if (!running.signal.aborted) ctx.report('dingtalk', { state: 'error', detail: String(error) }) }
    finally { clearInterval(check); signal.removeEventListener('abort', stop) }
    if (running.signal.aborted) continue
    // The consumer is not started again at once: a second after a run that stayed up, and longer after each that did not.
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}
async function consume(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const child = spawn(bot(ctx).cli, ['event', 'consume'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout = createInterface({ input: child.stdout }); const stderr = createInterface({ input: child.stderr })
  let chain = Promise.resolve(); let diagnostic = ''; let ready = false
  const stop = (): void => { child.stdin.end(); child.kill('SIGTERM') }
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(() => { diagnostic = 'DingTalk event consumer did not become ready within 45 seconds'; stop() }, 45_000)
  stderr.on('line', (line: string) => {
    diagnostic = line.slice(0, 4000)
    if (line.startsWith('[event] ready')) {
      ready = true; clearTimeout(timeout)
      ctx.report('dingtalk', { state: 'ready', detail: 'Listening for bot events', at: new Date().toISOString() })
    } else if (/WARN|drop|error/.test(line)) ctx.report('dingtalk', { state: 'error', detail: diagnostic })
  })
  stdout.on('line', (line: string) => {
    chain = chain.then(async () => {
      if (line.length > 1_048_576) throw new Error('DingTalk event exceeds 1 MiB')
      const message = read(line)
      const trigger = dingtalkTrigger(message, roots(ctx))
      // Events already read when the Source is disabled are dropped; the consumer stops shortly after.
      if (!trigger || !enabled(ctx)) return
      await receive(ctx, trigger, message)
    }).catch(error => { ctx.report('dingtalk', { state: 'error', detail: String(error) }) })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      const exited = (code: number | null) => new Error(`DingTalk event consumer exited (${code}, ready=${ready}): ${diagnostic}`)
      child.once('close', (code) => signal.aborted ? resolve() : reject(exited(code)))
    })
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', stop); stdout.close(); stderr.close(); await chain }
}

/** Forgets the messages and markers older than they are kept. */
export function prune(ctx: SourceContext, now: number): void {
  for (const family of [KV.dingtalk.root, KV.dingtalk.marker]) {
    for (const name of ctx.state.keys(family)) {
      const entry = ctx.state.get(name)
      if (!entry || !(now - Date.parse(entry.at) < RETAIN_MS)) ctx.state.set(name, undefined)
    }
  }
}
/** Prunes what quotes need at startup and every hour after. */
async function upkeep(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  while (!signal.aborted) {
    prune(ctx, Date.now())
    await delay(3_600_000, undefined, { signal }).catch(() => {})
  }
}

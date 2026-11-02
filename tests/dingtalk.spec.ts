/** DingTalk robot messages as Triggers, the Channel that answers them, the DingTalk Source's settings, and its event consumer. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type OutboundMessage, type Thread, type Trigger } from '../src/core/index.ts'
import { Prompts, defaultPrompts } from '../src/app/prompts.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { settingsView } from '../src/app/views/settings.ts'
import { Store } from '../src/app/store.ts'
import { bundledSkills } from '../src/app/skill-files.ts'
import { CliError, Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { apply as applyDingtalk, dingtalkKind } from '../src/sources/dingtalk.ts'
import { sendDingtalk } from '../src/sources/dingtalk-channel.ts'
import { prune, runDingtalk } from '../src/sources/dingtalk-loops.ts'
import { BotMessageSchema, SOURCE, dingtalkTrigger, dingtalkTriggerId, markerIn, replyTitle, threadMarker, type Roots }
  from '../src/sources/dingtalk-trigger.ts'
import { consumerRetry } from '../src/sources/feishu-loops.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testChatDeployment } from './fixtures/deployment.ts'

const BOT = '$:LWCP_v1:$bot'
const ALICE = '$:LWCP_v1:$alice'
const HOOK = 'https://hooks.example.test/robot/sendBySession?session=abc'
const SENT = 1_790_000_000_000
const THREAD = 'cid-test==:msg-1'
/** A robot message as DingTalk delivers it (fake IDs and names): a group message that mentions the robot, in the `text` shape. */
const event = (overrides: Record<string, unknown> = {}) => BotMessageSchema.parse({ msgId: 'msg-1', conversationId: 'cid-test==', conversationType: '2',
  conversationTitle: 'Team chat', chatbotUserId: BOT, chatbotCorpId: 'corp-1', senderId: ALICE, senderStaffId: 'staff-1', senderNick: 'Alice',
  senderCorpId: 'corp-1', isAdmin: false, isInAtList: true, atUsers: [{ dingtalkId: BOT }], msgtype: 'text', text: { content: ' fix the login page' },
  robotCode: 'ding123', createAt: SENT, sessionWebhook: HOOK, sessionWebhookExpiredTime: SENT + 5_400_000, openThreadId: 'thread-1', ...overrides })
const richText = (parts: object[], overrides: Record<string, unknown> = {}) =>
  event({ msgtype: 'richText', text: undefined, content: { richText: parts }, ...overrides })
const roots = (known: { messages?: Record<string, string>; markers?: Record<string, string> } = {}): Roots =>
  ({ rootOf: id => known.messages?.[id], markedThread: marker => known.markers?.[marker] })
/** A message a reply quotes: a person's holds its text, a robot's the title it was sent with. */
const quoted = (overrides: Record<string, unknown> = {}) => ({ msgId: 'msg-0', senderId: '$:LWCP_v1:$bob', msgType: 'text', createdAt: SENT - 60_000,
  content: { text: 'the first request' }, ...overrides })
const replying = (repliedMsg: object, content = ' and the footer?') => event({ msgId: 'msg-3', text: { content, isReplyMsg: true, repliedMsg } })

describe('DingTalk Triggers', () => {
  it('names the Trigger after msgId, stable across redelivery', () => {
    const first = dingtalkTrigger(event(), roots())!
    expect(first).toEqual({ id: key('dingtalk', 'msg-1'), source: 'dingtalk', threads: [{ source: 'dingtalk', id: THREAD }],
      actor: { source: 'dingtalk', id: 'staff-1' }, human: true, addressed: 'mention', at: new Date(SENT).toISOString(), text: 'fix the login page',
      channel: { source: 'dingtalk', thread: 'dingtalk:cid-test==', address: { conversationId: 'cid-test==', messageId: 'msg-1', thread: THREAD,
        staffId: 'staff-1', webhook: HOOK, expires: String(SENT + 5_400_000) } },
      meta: { chatId: 'cid-test==', messageId: 'msg-1', direct: false, mentioned: true, staffId: 'staff-1' } })
    expect(dingtalkTriggerId('msg-1')).toBe(first.id)
    // A redelivery brings a session webhook of its own, and is still the same Trigger.
    const again = dingtalkTrigger(event({ sessionWebhook: `${HOOK}2` }), roots())!
    expect(again.id).toBe(first.id)
    expect(dingtalkTrigger(event({ msgId: 'msg-2' }), roots())!.id).not.toBe(first.id)
    // No webhook, no address for one: the reply then goes through the robot API.
    expect(dingtalkTrigger(event({ sessionWebhook: undefined, sessionWebhookExpiredTime: undefined }), roots())!.channel!.address)
      .toEqual({ conversationId: 'cid-test==', messageId: 'msg-1', thread: THREAD, staffId: 'staff-1' })
  })

  it('uses senderStaffId, and an opaque senderId that no list can match', () => {
    // A sender outside the organization has no staff ID; DingTalk's opaque id stands in, and it holds `$` and `:`.
    const external = dingtalkTrigger(event({ senderStaffId: undefined }), roots())!
    expect(external.actor).toEqual({ source: 'dingtalk', id: ALICE })
    expect(external.meta).not.toHaveProperty('staffId')
    expect(external.channel!.address).not.toHaveProperty('staffId')
    const policy = dingtalkKind.policy!.schema
    expect(policy.safeParse({ allowed: [{ id: ALICE }] }).success).toBe(false)
    expect(policy.safeParse({ allowed: [{ id: 'staff-1', name: 'Alice' }, { id: 'manager4220' }] }).success).toBe(true)
    expect(policy.safeParse({ allowed: [{ id: 'staff-1' }, { id: 'staff-1' }] }).success).toBe(false)
    // The gate agrees: a listed staff ID may originate work and the same person's opaque id may not.
    const settings = SettingsSchema.parse({ policy: { sources: { dingtalk: { allowed: [{ id: 'staff-1' }] } } },
      sources: { dingtalk: { enabled: true, config: { cli: 'dingtalk-bot' } } } })
    const sources = new SourceRegistry(() => settings)
    sources.register(dingtalkKind)
    const thread: Thread = { key: `dingtalk:${THREAD}`, ref: { source: SOURCE, id: THREAD }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} }
    const gate = (trigger: Trigger) => settingsPolicy(settings, sources).gate(trigger, thread, [])
    expect(gate(dingtalkTrigger(event(), roots())!)).toMatchObject({ admissible: true, strength: 'explicit' })
    expect(gate(external)).toMatchObject({ admissible: false })
  })

  it('addresses the agent in a direct chat and on a mention', () => {
    expect(dingtalkTrigger(event({ conversationType: '1', isInAtList: undefined }), roots())).toMatchObject({ addressed: 'direct',
      meta: { direct: true, mentioned: false }, channel: { address: { direct: 'true' } } })
    expect(dingtalkTrigger(event(), roots())).toMatchObject({ addressed: 'mention', meta: { direct: false, mentioned: true } })
    // The robot receives only what mentions it in a group; a message that does not is not addressed to it.
    expect(dingtalkTrigger(event({ isInAtList: false }), roots())).not.toHaveProperty('addressed')
    expect(dingtalkTrigger(event({ isInAtList: undefined }), roots())).not.toHaveProperty('addressed')
  })

  it('produces no Trigger for the bot itself', () => {
    expect(dingtalkTrigger(event({ senderId: BOT }), roots())).toBeUndefined()
    // Whatever else the event says, its sender is the robot.
    expect(dingtalkTrigger(event({ senderId: BOT, senderStaffId: 'staff-1', conversationType: '1' }), roots())).toBeUndefined()
    expect(dingtalkTrigger(event({ senderId: `${BOT}2` }), roots())).toBeDefined()
  })

  it('joins a quoted user message to its Thread', () => {
    const known = roots({ messages: { 'msg-0': 'cid-test==:msg-root' } })
    // The quote is in the Thread already, so its words are not copied again.
    expect(dingtalkTrigger(replying(quoted()), known)).toMatchObject({ threads: [{ source: 'dingtalk', id: 'cid-test==:msg-root' }],
      text: 'and the footer?', channel: { address: { thread: 'cid-test==:msg-root' } }, meta: { repliedId: 'msg-0' } })
    // A Thread of another conversation is not joined, whatever the store says.
    const other = roots({ messages: { 'msg-0': 'cid-other==:msg-root' } })
    expect(dingtalkTrigger(replying(quoted()), other)!.threads).toEqual([{ source: 'dingtalk', id: 'cid-test==:msg-3' }])
  })

  it('joins a quoted bot reply by the marker in its title', () => {
    const reply = quoted({ msgId: 'msg-bot', senderId: BOT, msgType: 'markdown', content: { text: 'dsh #a1b2c3d4' } })
    const known = roots({ markers: { a1b2c3d4: THREAD } })
    expect(dingtalkTrigger(replying(reply, ' thanks'), known)).toMatchObject({ threads: [{ source: 'dingtalk', id: THREAD }], text: 'thanks',
      channel: { address: { thread: THREAD } } })
    // A title carries the marker of the Thread it was sent in, which a reply to that Thread names by `replyTitle`.
    const marker = threadMarker(`dingtalk:${THREAD}`)
    expect(marker).toMatch(/^[0-9a-f]{8}$/)
    expect(replyTitle(`dingtalk:${THREAD}`)).toBe(`dsh #${marker}`)
    expect(markerIn(`dsh #${marker}`)).toBe(marker)
    expect([markerIn('dsh #a1b2c3d'), markerIn('dsh #A1B2C3D4'), markerIn('see dsh #a1b2c3d4'), markerIn('')]).toEqual([undefined, undefined, undefined, undefined])
    // Another Thread has another marker.
    expect(threadMarker('dingtalk:cid-test==:msg-9')).not.toBe(marker)
  })

  it('ignores a marker in a message quoted from a person', () => {
    const forged = quoted({ content: { text: 'dsh #a1b2c3d4' } })
    const markedThread = vi.fn(() => THREAD)
    const trigger = dingtalkTrigger(replying(forged), { rootOf: () => undefined, markedThread })!
    expect(markedThread).not.toHaveBeenCalled()
    expect(trigger.threads).toEqual([{ source: 'dingtalk', id: 'cid-test==:msg-3' }])
  })

  it('opens a new Thread and carries the quote when neither matches', () => {
    const trigger = dingtalkTrigger(replying(quoted({ content: { text: 'the first request\nin two lines' } })), roots())!
    expect(trigger).toMatchObject({ threads: [{ source: 'dingtalk', id: 'cid-test==:msg-3' }], meta: { repliedId: 'msg-0' },
      text: '> the first request\n> in two lines\n\nand the footer?' })
    // A robot's title says nothing a reader could use, so a quote of an unknown reply adds no words.
    const reply = quoted({ msgId: 'msg-bot', senderId: BOT, content: { text: 'dsh #a1b2c3d4' } })
    expect(dingtalkTrigger(replying(reply, ' thanks'), roots())).toMatchObject({ threads: [{ id: 'cid-test==:msg-3' }], text: 'thanks' })
    // A message with no quote, such as a second mention, opens a Thread of its own as well.
    expect(dingtalkTrigger(event({ msgId: 'msg-4' }), roots())!.threads).toEqual([{ source: 'dingtalk', id: 'cid-test==:msg-4' }])
  })

  it('reads both the text and the richText message shapes', () => {
    const text = dingtalkTrigger(event(), roots())!
    const rich = dingtalkTrigger(richText([{ text: ' fix the' }, { text: ' login page' }]), roots())!
    expect(rich.text).toBe(text.text)
    expect(rich).toEqual(text)
    // A quote reads the same in both shapes, and a picture is a placeholder, as in the panel's other Sources.
    const inRich = richText([{ text: ' and the footer?' }], { msgId: 'msg-3', content: { richText: [{ text: ' and the footer?' }], isReplyMsg: true, repliedMsg: quoted() } })
    expect(dingtalkTrigger(inRich, roots())!.text).toBe(dingtalkTrigger(replying(quoted()), roots())!.text)
    expect(dingtalkTrigger(richText([{ text: 'see ' }, { type: 'picture', downloadCode: 'dl-1' }]), roots())!.text).toBe('see [image]')
    expect(dingtalkTrigger(event({ msgtype: 'picture', text: undefined, content: { downloadCode: 'dl-1' } }), roots())!.text).toBe('[image]')
    expect(dingtalkTrigger(event({ msgtype: 'file', text: undefined, content: { downloadCode: 'dl-2', fileName: 'a.pdf' } }), roots())!.text).toBe('[Media: file]')
    // An event that lacks what a Trigger needs does not parse, so no Trigger comes of it.
    expect(BotMessageSchema.safeParse({ ...event(), msgId: undefined }).success).toBe(false)
    expect(BotMessageSchema.safeParse({ ...event(), createAt: 'later' }).success).toBe(false)
  })
})

/** What the CLI reports when DingTalk refuses a call: the HTTP status as `code`, and DingTalk's own words as the message. */
const refused = (code: number, message: string) => commandError({ stderr: JSON.stringify({ error: { code, message } }), code: 1 }, 'dingtalk-bot')
const address = (overrides: Record<string, string> = {}) => ({ conversationId: 'cid-test==', messageId: 'msg-1', thread: THREAD, staffId: 'staff-1',
  webhook: HOOK, expires: String(Date.now() + 60_000), ...overrides })
const reply = (overrides: Record<string, string> = {}, text = 'Done.'): OutboundMessage =>
  ({ id: 'r1', channel: { source: 'dingtalk', thread: 'dingtalk:cid-test==', address: address(overrides) }, text, kind: 'reply' })
/** The same message with some of its address's keys left out. */
const without = (message: OutboundMessage, ...names: string[]): OutboundMessage => ({ ...message, channel: { ...message.channel,
  address: Object.fromEntries(Object.entries(message.channel.address).filter(([name]) => !names.includes(name))) } })
/** A bot CLI that answers each call with the next of `answers`; an `Error` is thrown. */
function bot(...answers: unknown[]) {
  const dingtalk = vi.fn()
  for (const answer of answers) { if (answer instanceof Error) dingtalk.mockRejectedValueOnce(answer); else dingtalk.mockResolvedValueOnce(answer) }
  return { host: { commands: { dingtalk } as unknown as Commands }, dingtalk }
}
const TITLE = replyTitle(`dingtalk:${THREAD}`)

describe('DingTalk Channel', () => {
  it('prefers a live webhook and mentions the sender', async () => {
    const { host, dingtalk } = bot({ ok: true })
    expect(await sendDingtalk(host, reply())).toBe('sent')
    expect(dingtalk.mock.calls).toEqual([[['message', 'send', '--conversation', 'cid-test==', '--title', TITLE, '--text-stdin', '--webhook', HOOK, '--at', 'staff-1'], 'Done.']])
    // The title names the Thread, so a quote of this reply finds it.
    expect(markerIn(TITLE)).toBe(threadMarker(`dingtalk:${THREAD}`))
    // A direct chat needs no mention, and a sender with no staff ID cannot be named.
    const direct = bot({ ok: true }, { ok: true })
    await sendDingtalk(direct.host, reply({ direct: 'true' }))
    await sendDingtalk(direct.host, without(reply(), 'staffId'))
    expect(direct.dingtalk.mock.calls.map(([args]) => (args as string[]).includes('--at'))).toEqual([false, false])
  })

  it('falls back to the API once the webhook expired', async () => {
    const api = ['message', 'send', '--conversation', 'cid-test==', '--title', TITLE, '--text-stdin']
    const expired = bot({ key: 'k1' })
    expect(await sendDingtalk(expired.host, reply({ expires: String(Date.now() - 1) }))).toBe('sent')
    expect(expired.dingtalk.mock.calls).toEqual([[api, 'Done.']])
    // A webhook DingTalk refuses early, by a code its answer reports, falls back to the API in the same send, whatever the code says.
    const turnedDown = bot(refused(310000, 'DingTalk refused the webhook message: session expired'), { key: 'k2' })
    expect(await sendDingtalk(turnedDown.host, reply())).toBe('sent')
    expect(turnedDown.dingtalk.mock.calls.map(([args]) => (args as string[]).includes('--webhook'))).toEqual([true, false])
    expect(turnedDown.dingtalk.mock.calls[1]).toEqual([api, 'Done.'])
    const unreachable = bot(new CliError('dingtalk-bot exited with code 1'), { key: 'k3' })
    expect(await sendDingtalk(unreachable.host, reply())).toBe('sent')
    // No webhook at all goes straight to the API, and a direct chat is reached by its person.
    const none = without(reply(), 'webhook', 'expires')
    const plain = bot({ key: 'k4' }, { key: 'k5' })
    await sendDingtalk(plain.host, none)
    await sendDingtalk(plain.host, without(reply({ direct: 'true' }), 'webhook', 'expires'))
    expect(plain.dingtalk.mock.calls.map(([args]) => args)).toEqual([api, ['message', 'send', '--user', 'staff-1', '--title', TITLE, '--text-stdin']])
    // A direct chat with a stranger and no live webhook can never be reached again, so the reply is dropped without a call.
    const stranger = bot()
    expect(await sendDingtalk(stranger.host, without(reply({ direct: 'true' }), 'webhook', 'expires', 'staffId'))).toBe('gone')
    expect(stranger.dingtalk).not.toHaveBeenCalled()
  })

  it('answers gone when the bot left the chat and throws otherwise', async () => {
    // The robot API's answers, as the CLI reports them. These shapes are the wordings expected for a robot removed from a group and for a group
    // dissolved, which have not been measured; the one predicate in dingtalk-channel.ts that reads them is where to adjust them.
    const gone = [refused(403, 'Forbidden.AccessDenied: the robot is not in the conversation'), refused(400, 'invalidParameter: openConversationId does not exist'),
      refused(404, 'resourceNotFound: the group has been dissolved'), refused(403, 'robot.notInGroup: send failed')]
    for (const error of gone) expect(await sendDingtalk(bot(error).host, reply({ expires: '0' })), error.message).toBe('gone')
    const retry = [refused(401, 'InvalidAuthentication: invalid access token'), refused(429, 'Throttling.Api: too many requests'),
      refused(500, 'System.Error: please retry'), refused(400, 'invalidParameter: msgParam is invalid'),
      refused(403, 'Forbidden.AccessDenied.AccessTokenPermissionDenied: the app has no permission'),
      // A network error and a CLI that failed without a word carry no status.
      commandError({ stderr: JSON.stringify({ error: { message: 'Could not reach DingTalk: fetch failed (ECONNREFUSED)' } }), code: 1 }, 'dingtalk-bot'),
      new CliError('dingtalk-bot exited with code 1', undefined, 1), new Error('spawn dingtalk-bot ENOENT'),
      // Wording that mentions a conversation without saying the robot is out of it.
      refused(403, 'Forbidden.AccessDenied: no permission to send to the conversation')]
    for (const error of retry) await expect(sendDingtalk(bot(error).host, reply({ expires: '0' })), error.message).rejects.toThrow(error.message)
    // DingTalk not knowing the person of a direct chat is final too, but only for a direct send: in a group the words mean something else.
    const unknown = refused(400, 'DingTalk does not know the person to send to')
    expect(await sendDingtalk(bot(unknown).host, reply({ direct: 'true', expires: '0' }))).toBe('gone')
    await expect(sendDingtalk(bot(unknown).host, reply({ expires: '0' }))).rejects.toThrow('does not know')
    // A throttled person is retried.
    await expect(sendDingtalk(bot(refused(429, 'DingTalk is limiting the messages to this person')).host, reply({ direct: 'true', expires: '0' }))).rejects.toThrow('limiting')
    // Only the robot API's answer counts: a webhook that fails with such words falls back, and the API decides.
    const webhookWords = refused(403, 'Forbidden.AccessDenied: the robot is not in the conversation')
    expect(await sendDingtalk(bot(webhookWords, { key: 'k' }).host, reply())).toBe('sent')
    await expect(sendDingtalk(bot(webhookWords, new CliError('dingtalk-bot exited with code 1')).host, reply())).rejects.toThrow('exited')
    // A stop is not a webhook failure to fall back from.
    const stopped = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const aborted = bot(stopped, { key: 'never' })
    await expect(sendDingtalk(aborted.host, reply())).rejects.toBe(stopped)
    expect(aborted.dingtalk).toHaveBeenCalledTimes(1)
  })

  it('answers gone for an invalid conversation ID, as the robot API worded it when measured', async () => {
    // A send to an openConversationId that names no conversation: HTTP 400, DingTalk's code, then its message. No retry makes it exist.
    const invalid = refused(400, 'invalid.openConversationId: 无效的openConversationId')
    const api = bot(invalid)
    expect(await sendDingtalk(api.host, reply({ expires: '0' }))).toBe('gone')
    expect(api.dingtalk).toHaveBeenCalledTimes(1)
    // A live webhook is tried first; its answer decides nothing, and the robot API is asked next, which words it the same way.
    const viaWebhook = bot(refused(310000, 'DingTalk refused the webhook message: session expired'), invalid)
    expect(await sendDingtalk(viaWebhook.host, reply())).toBe('gone')
    expect(viaWebhook.dingtalk).toHaveBeenCalledTimes(2)
    // The same words without an HTTP status, as a CLI that never got an answer reports them, are no reason to drop the reply.
    const noStatus = commandError({ stderr: JSON.stringify({ error: { message: 'invalid.openConversationId: 无效的openConversationId' } }), code: 1 }, 'dingtalk-bot')
    await expect(sendDingtalk(bot(noStatus).host, reply({ expires: '0' }))).rejects.toThrow('invalid.openConversationId')
  })

  it('applies the chat word limit to a reply before it sends', async () => {
    const { host, dingtalk } = bot({ ok: true })
    await expect(sendDingtalk(host, reply({}, 'word '.repeat(101)))).rejects.toThrow('maximum is 100')
    expect(dingtalk).not.toHaveBeenCalled()
    await expect(sendDingtalk(bot().host, { ...reply(), channel: { source: 'dingtalk', thread: 'dingtalk:x', address: {} } })).rejects.toThrow('Missing DingTalk reply target')
  })

  it('refuses a chat no longer listened to', () => {
    const config = dingtalkKind.schema.parse({ cli: 'dingtalk-bot', chats: [{ chatId: 'cid-test==', name: 'Team chat' }] })
    const allowed = (address: Record<string, string>, settings = config) => dingtalkKind.channel!.allowed!(address, settings)
    expect(allowed({ conversationId: 'cid-test==' })).toBe(true)
    // A chat that is not listed is out unless the Source takes the others' mentions; a direct chat follows its own switch.
    expect(allowed({ conversationId: 'cid-other==' })).toBe(false)
    expect(allowed({ conversationId: 'cid-other==' }, { ...config, otherChats: 'mentions' })).toBe(true)
    expect(allowed({ conversationId: 'cid-dm==', direct: 'true' })).toBe(true)
    expect(allowed({ conversationId: 'cid-dm==', direct: 'true' }, { ...config, directMessages: false })).toBe(false)
    expect(allowed({ conversationId: 'cid-test==' }, { ...config, chats: [] })).toBe(false)
    const scope = (meta: Record<string, unknown>, settings = config) => dingtalkKind.scope!({ meta }, settings)
    expect(scope({ chatId: 'cid-test==', direct: false })).toEqual({ listened: true, observed: false, row: 'cid-test==' })
    expect(scope({ chatId: 'cid-other==', direct: false }, { ...config, otherChats: 'mentions' })).toEqual({ listened: true, observed: false, row: 'other' })
    expect(scope({ chatId: 'cid-dm==', direct: true })).toEqual({ listened: true, observed: false, row: 'direct' })
    expect(scope({ chatId: 'cid-other==', direct: false })).toMatchObject({ listened: false, reason: 'chat_not_allowed' })
    expect(scope({ chatId: 'cid-dm==', direct: true }, { ...config, directMessages: false })).toMatchObject({ listened: false, reason: 'direct_messages_not_allowed' })
    // A reply to a Trigger leads to the Trigger, and a page DingTalk does not offer leaves the link empty.
    expect(dingtalkKind.channel!.link({ conversationId: 'cid-test==', messageId: 'msg-1' }, {})).toEqual({ url: '', label: { zh: '钉钉消息', en: 'DingTalk message' },
      triggerId: dingtalkTriggerId('msg-1') })
  })
})

describe('DingTalk Source settings', () => {
  it('takes the chats it listens to, the others\' mentions and direct messages, and no observed scope', () => {
    expect(dingtalkKind.schema.parse({})).toEqual({ cli: '', chats: [], otherChats: 'none', directMessages: true })
    expect(() => dingtalkKind.schema.parse({ chats: [{ chatId: 'cid-test==' }, { chatId: 'cid-test==' }] })).toThrow('Duplicate chat IDs')
    expect(() => dingtalkKind.schema.parse({ chats: [{ chatId: 'oc_feishu' }] })).toThrow()
    expect(() => dingtalkKind.schema.parse({ chats: [{ chatId: 'cid-test==', listen: 'all' }] })).toThrow()
    expect(dingtalkKind.health).toEqual(['dingtalk'])
    // The robot hears only what mentions it, so no row reaches an unaddressed message, and the roster cannot sync.
    const config = dingtalkKind.schema.parse({ chats: [{ chatId: 'cid-test==', name: 'Team chat' }], otherChats: 'mentions' })
    expect(dingtalkKind.policy!.rows!(config)).toEqual([
      { id: 'cid-test==', label: 'Team chat', note: { zh: '仅 @', en: '@ only' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: { zh: '仅 @', en: '@ only' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: { zh: '接收', en: 'Received' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }])
    expect(dingtalkKind.policy).not.toHaveProperty('sync')
    expect(dingtalkKind).not.toHaveProperty('threadContext')
    // The Trigger answering a quote is the one named after the quoted message.
    expect(dingtalkKind.repliesTo!(dingtalkTrigger(replying(quoted()), roots())!)).toBe(dingtalkTriggerId('msg-0'))
    expect(dingtalkKind.repliesTo!(dingtalkTrigger(event(), roots())!)).toBeUndefined()
  })

  it('declares the variables a worker reads: the robot, and the chat a ticket started in', () => {
    const deployment = testChatDeployment({ feishu: undefined, dingtalk: { cli: '/bin/false', clientId: 'ding123', robotCode: 'ding-robot' } })
    const values = (trigger?: Trigger) => dingtalkKind.environment!.values({ deployment, config: dingtalkKind.schema.parse({}), ...trigger ? { trigger } : {} })
    expect(dingtalkKind.environment!.variables.map(variable => variable.key)).toEqual(['DSH_SUPERAGENT_DINGTALK_BOT', 'DSH_SUPERAGENT_DINGTALK_CONVERSATION'])
    expect(values(dingtalkTrigger(event(), roots())!)).toEqual({ DSH_SUPERAGENT_DINGTALK_BOT: 'ding-robot', DSH_SUPERAGENT_DINGTALK_CONVERSATION: 'cid-test==' })
    // A ticket that did not start on DingTalk, or an installation with no bot, leaves them empty.
    expect(values()).toEqual({ DSH_SUPERAGENT_DINGTALK_BOT: 'ding-robot', DSH_SUPERAGENT_DINGTALK_CONVERSATION: '' })
    const other = { ...dingtalkTrigger(event(), roots())!, source: 'feishu' }
    expect(values(other).DSH_SUPERAGENT_DINGTALK_CONVERSATION).toBe('')
    expect(dingtalkKind.environment!.values({ deployment: testChatDeployment(), config: dingtalkKind.schema.parse({}) }).DSH_SUPERAGENT_DINGTALK_BOT).toBe('')
    expect(dingtalkKind.facts!(deployment)).toEqual({ cli: { zh: '当前机器人 ding-robot', en: 'Current bot ding-robot' } })
    expect(dingtalkKind.facts!(undefined)).toEqual({})
  })

  it('offers the DingTalk skill only to an installation that has a DingTalk bot', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'dingtalk-prompts-')), 'db.sqlite'))
    const config = { ...defaultPrompts(), skills: { release: 'Release it.' } }
    const skills = (feishu: boolean, gitlab: boolean, dingtalk: boolean) =>
      new Prompts(store, () => 100000, () => undefined, () => feishu, () => gitlab, () => dingtalk).skills(config).map(([name]) => name)
    expect(skills(false, false, false)).toEqual(['github', 'release'])
    expect(skills(true, false, false)).toEqual(['feishu', 'github', 'release'])
    expect(skills(false, false, true)).toEqual(['dingtalk', 'github', 'release'])
    expect(skills(true, true, true)).toEqual(['feishu', 'dingtalk', 'gitlab', 'release'])
    // The skill is packaged under its Source's name, and a team cannot take the name for its own skill.
    expect(bundledSkills.dingtalk).toMatchObject({ name: 'dsh-superagent-dingtalk', description: expect.stringContaining('DingTalk') })
    expect(() => new Prompts(store, () => 100000, () => undefined, () => false).save({ ...defaultPrompts(), skills: { dingtalk: 'mine' } }, 0, 'panel')).toThrow('built-in skill')
    store.close()
  })
})

describe('dingtalk-bot through Commands', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dingtalk-commands-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const commands = (cli: string) => new Commands(() => testChatDeployment({ feishu: undefined, dingtalk: { cli, clientId: 'ding123', robotCode: 'ding123' } }), {}, new AbortController().signal)
  const program = (body: string) => { const path = join(dir, 'dingtalk-bot'); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }

  it('hands the text to the CLI on stdin, and reads its JSON output', async () => {
    const cli = program(`cat > '${dir}/stdin'; printf '%s\\n' "$@" > '${dir}/args'; echo '{"key":"k1"}'`)
    expect(await commands(cli).dingtalk(['message', 'send', '--conversation', 'cid-test==', '--text-stdin'], 'Done — see the report.\n')).toEqual({ key: 'k1' })
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe('Done — see the report.\n')
    expect(readFileSync(join(dir, 'args'), 'utf8').split('\n')).toEqual(['message', 'send', '--conversation', 'cid-test==', '--text-stdin', ''])
    // A call with no text leaves the CLI's stdin alone, as every other call does.
    expect(await commands(program(`echo '{"clientId":"ding123"}'`)).dingtalk(['auth', 'status'])).toEqual({ clientId: 'ding123' })
  })

  it('fails with the status the CLI reports, and never with the arguments it was given', async () => {
    const cli = program(`cat > /dev/null; echo '{"error":{"code":403,"message":"Forbidden.AccessDenied: no permission"}}' >&2; exit 1`)
    const error = await commands(cli).dingtalk(['message', 'send', '--webhook', HOOK, '--text-stdin'], 'x').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'Forbidden.AccessDenied: no permission (403)', code: 403, exitCode: 1 })
    expect(String((error as Error).message)).not.toContain('session=')
    // A CLI that dies silently is named by how it ended.
    await expect(commands(program('exit 7')).dingtalk(['auth', 'status'])).rejects.toMatchObject({ message: 'dingtalk-bot exited with code 7', exitCode: 7 })
    await expect(new Commands(() => testChatDeployment({ feishu: undefined }), {}, new AbortController().signal).dingtalk(['auth', 'status']))
      .rejects.toThrow('The DingTalk Source has no working bot CLI')
  })
})

describe('DingTalk plugin and event consumer', () => {
  let dir: string
  let controller: AbortController
  let running: Promise<unknown> | undefined
  // The fake CLI is a real process, which starts slower while the whole suite runs.
  const until = { timeout: 10_000 }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dingtalk-consumer-')); controller = new AbortController() })
  afterEach(async () => {
    controller.abort()
    await running
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })
  /**
   * A bot CLI whose `event consume` behaves as `mode` says: `ready` stays up, `flaky` fails once after it is ready, `events` prints
   * the events file once ready, and `late` prints them a second later. It records each run and the PID of the latest.
   */
  function cli(mode: 'ready' | 'flaky' | 'events' | 'late'): string {
    const path = join(dir, 'dingtalk-bot')
    writeFileSync(path, `#!/bin/sh
[ "$1" = event ] || { echo '{"ok":true}'; exit 0; }
n=$(cat '${dir}/runs' 2>/dev/null || echo 0); n=$((n + 1)); echo $n > '${dir}/runs'; echo $$ > '${dir}/pid'
case ${mode} in
  ready) echo '[event] ready' >&2; exec sleep 60 ;;
  flaky) echo '[event] ready' >&2; [ "$n" -gt 1 ] && exec sleep 60; echo 'boom' >&2; exit 3 ;;
  events) echo '[event] ready' >&2; cat '${dir}/events'; touch '${dir}/printed'; exec sleep 60 ;;
  late) echo '[event] ready' >&2; sleep 1; cat '${dir}/events'; touch '${dir}/printed'; exec sleep 60 ;;
esac
`, { mode: 0o755 })
    return path
  }
  const runs = () => existsSync(join(dir, 'runs')) ? Number(readFileSync(join(dir, 'runs'), 'utf8')) : 0
  /** The DingTalk Source's context, on a fresh Store whose DingTalk Source is on, with `path` as the bot CLI. */
  function consumerSource(path: string | undefined, deploymentOverrides: Partial<SourceContextDeps> = {}) {
    const store = new Store(join(dir, 'db.sqlite'))
    const enabled = (on: boolean) => SettingsSchema.parse({ policy: { sources: { dingtalk: { allowed: [{ id: 'staff-1' }] } } },
      sources: { dingtalk: { enabled: on, config: { chats: [{ chatId: 'cid-test==' }] } } } })
    store.saveSettings(enabled(true))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    sources.register(dingtalkKind)
    const assessor: Assessor = { request: vi.fn(async () => {}) }
    const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
    const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
    const deployment = testChatDeployment({ feishu: undefined, ...path ? { dingtalk: { cli: path, clientId: 'ding123', robotCode: 'ding123' } } : {} })
    const commands = new Commands(() => deployment, {}, controller.signal)
    const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment, ready: Promise.resolve(), configured: () => true,
      receive: (trigger: Trigger) => engine.receive(trigger), ...deploymentOverrides }
    return { ctx: sourceContextOf(deps, dingtalkKind), deps, sources, health: board.all, store, turnOff: () => store.saveSettings(enabled(false)) }
  }
  /** A message line as `event consume` prints it. */
  const line = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...event(), ...overrides })

  it('registers its kind without a bot, and names on its health what setup still needs', async () => {
    const run = async (overrides: Partial<SourceContextDeps>) => {
      const { deps, store } = consumerSource(undefined)
      // The fixture's registry already holds the kind; this one starts empty so the plugin's registration shows.
      const board = new HealthBoard()
      const registry = new SourceRegistry(() => store.settings(), board)
      const parts: SourceContextDeps = { ...deps, sources: registry, ...overrides }
      const orchestrator = { sources: registry, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
      const disposers: (() => unknown)[] = []
      applyDingtalk({ orchestrator, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      await vi.waitFor(() => expect(board.all.dingtalk).toMatchObject({ state: 'paused' }), until)
      const registered = registry.kind('dingtalk')
      // Snapshot health before disposal clears the registered entries.
      const health = { ...board.all }
      for (const dispose of disposers) await dispose()
      store.close()
      return { registered, health }
    }
    const unset = await run({})
    expect(unset.registered).toBe(dingtalkKind)
    expect(unset.health.dingtalk).toMatchObject({ state: 'paused', code: 'dingtalkCliUnset' })
    const problem = new SetupError('dingtalkNoApp').problem
    const refused = await run({ dingtalkProblem: problem })
    // A failed bot check waits for the operator's fix and a check; it does not retry by itself like a polling error.
    expect(refused.health.dingtalk).toEqual({ state: 'paused', detail: problem.detail })
    expect((await run({ configured: () => false })).health.dingtalk).toEqual({ state: 'paused', detail: 'Waiting for the deployment check', code: 'setupPending' })
  })

  it('takes in the event lines it reads, remembers what a quote needs, and reports a malformed line without stopping', async () => {
    const lines = [line(), line({ msgId: 'msg-2', conversationId: 'cid-dm==', conversationType: '1', conversationTitle: undefined, isInAtList: undefined }),
      // The robot's own message, and a line that is not JSON, and a quote of the first message.
      line({ msgId: 'msg-self', senderId: BOT }), 'not json {"sessionWebhook":"https://hooks.example.test/robot/sendBySession?session=abc"',
      line({ msgId: 'msg-3', text: { content: ' and the footer?', isReplyMsg: true, repliedMsg: quoted({ msgId: 'msg-1' }) } })]
    writeFileSync(join(dir, 'events'), lines.join('\n') + '\n')
    const { ctx, health, store } = consumerSource(cli('events'))
    running = runDingtalk(ctx, controller.signal)
    await vi.waitFor(() => expect(store.triggers.get(dingtalkTriggerId('msg-3'))).toBeDefined(), until)
    expect(['msg-1', 'msg-2'].map(id => store.triggers.get(dingtalkTriggerId(id))?.meta.direct)).toEqual([false, true])
    expect(store.triggers.get(dingtalkTriggerId('msg-self'))).toBeUndefined()
    // The quote joined the Thread of the message it quotes, which the first line opened.
    expect(store.triggers.get(dingtalkTriggerId('msg-3'))!.threads).toEqual([{ source: 'dingtalk', id: THREAD }])
    const seen = store.get(KV.dingtalk.root('msg-1'))!
    // What it remembers is dated by when it saw the message, whatever the message says, so its 14 days start then.
    expect([seen.thread, Date.now() - Date.parse(seen.at) < 60_000]).toEqual([THREAD, true])
    expect(store.get(KV.dingtalk.root('msg-3'))).toMatchObject({ thread: THREAD })
    expect(store.get(KV.dingtalk.root('msg-self'))).toBeUndefined()
    // Sent replies carry the Thread's marker in their title, so a quote of one finds the Thread.
    expect(store.get(KV.dingtalk.marker(threadMarker(`dingtalk:${THREAD}`)))).toMatchObject({ thread: THREAD })
    expect(store.get(KV.sources.labels('dingtalk'))).toEqual({ 'cid-test==': 'Team chat' })
    expect(store.threads.get(`dingtalk:${THREAD}`)?.meta).toMatchObject({ facts: { chat: { value: 'Team chat' } } })
    expect(store.threads.get('dingtalk:cid-dm==:msg-2')?.meta).toMatchObject({ facts: { chat: { value: { zh: '私聊', en: 'Direct message' } } } })
    // The report names the problem without repeating the line, which holds a session webhook.
    expect(health.dingtalk).toMatchObject({ state: 'error', detail: expect.stringContaining('not valid JSON') })
    expect(health.dingtalk!.detail).not.toContain('session=')
    controller.abort(); await running; store.close()
  }, 20_000)

  it('records nothing when the Source is off', async () => {
    writeFileSync(join(dir, 'events'), line({ msgId: 'msg-9' }) + '\n')
    const { ctx, health, store, turnOff } = consumerSource(cli('late'))
    running = runDingtalk(ctx, controller.signal)
    await vi.waitFor(() => expect(health.dingtalk).toMatchObject({ state: 'ready' }), until)
    turnOff()
    // The CLI prints the event a second after it is ready, before the consumer stops for the Source being off.
    await vi.waitFor(() => expect(existsSync(join(dir, 'printed'))).toBe(true), until)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(store.triggers.get(dingtalkTriggerId('msg-9'))).toBeUndefined()
    expect([store.get(KV.dingtalk.root('msg-9')), store.get(KV.dingtalk.marker(threadMarker('dingtalk:cid-test==:msg-9'))),
      store.get(KV.sources.labels('dingtalk'))]).toEqual([undefined, undefined, undefined])
    controller.abort(); await running; store.close()
  }, 20_000)

  it('restarts the consumer with backoff and reports its error', async () => {
    const { ctx, health, store } = consumerSource(cli('flaky'))
    running = runDingtalk(ctx, controller.signal)
    await vi.waitFor(() => expect(health.dingtalk).toMatchObject({ state: 'error', detail: expect.stringContaining('exited (3, ready=true): boom') }), until)
    // The CLI is not started again at once: the first restart waits a second.
    expect(runs()).toBe(1)
    await vi.waitFor(() => expect(runs()).toBe(2), until)
    await vi.waitFor(() => expect(health.dingtalk).toMatchObject({ state: 'ready', detail: 'Listening for bot events' }), until)
    // A run that fails again soon waits twice as long, to a minute; one that stayed up starts again from a second.
    expect([consumerRetry(undefined, 0), consumerRetry(1000, 500), consumerRetry(32_000, 500), consumerRetry(60_000, 120_000)]).toEqual([1000, 2000, 60_000, 1000])
    controller.abort(); await running; store.close()
  }, 20_000)

  it('does not start a consumer before setup found a bot', async () => {
    const { ctx, health, store } = consumerSource(undefined)
    running = runDingtalk(ctx, controller.signal)
    await vi.waitFor(() => expect(health.dingtalk).toMatchObject({ state: 'paused', code: 'dingtalkCliUnset' }), until)
    expect(runs()).toBe(0)
    controller.abort(); await running; store.close()
  }, 20_000)

  it('stops the consumer when it is told to stop', async () => {
    const { ctx, health, store } = consumerSource(cli('ready'))
    running = runDingtalk(ctx, controller.signal)
    await vi.waitFor(() => expect(health.dingtalk).toMatchObject({ state: 'ready' }), until)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    controller.abort(); await running
    expect(() => process.kill(pid, 0)).toThrow()
    store.close()
  }, 20_000)

  it('gives the settings panel a card for the Source, with the group names its messages brought', () => {
    const { deps, sources, health, store } = consumerSource(undefined, { deployment: testChatDeployment({ feishu: undefined, dingtalk: { cli: '/bin/false', clientId: 'ding123', robotCode: 'ding-robot' } }) })
    store.set(KV.sources.labels('dingtalk'), { 'cid-test==': 'Team chat' })
    const card = settingsView(store, sources, health, { deployment: deps.deployment }, '/var/lib/agent').sources.find(source => source.id === 'dingtalk')!
    // Saving the CLI restarts dsh-superagent, as setup reads it; the card shows the robot the CLI is signed in to, and a chat to choose by name.
    expect(card).toMatchObject({ kind: 'dingtalk', installed: true, restarts: ['cli'], labels: { 'cid-test==': 'Team chat' },
      facts: { cli: { zh: '当前机器人 ding-robot', en: 'Current bot ding-robot' } } })
    expect(card.fields.map(field => field.key)).toEqual(['cli', 'chats', 'otherChats', 'directMessages'])
    expect(card.fields.find(field => field.key === 'chats')).toMatchObject({ type: 'rows', columns: [{ key: 'chatId', choose: expect.any(Object) }, { key: 'name', optional: true }] })
    expect(card.policy?.fields.map(field => field.key)).toEqual(['allowed'])
    store.close()
  })

  it('forgets what it remembered for a quote after 14 days', () => {
    const { ctx, store } = consumerSource(cli('ready'))
    const day = 86_400_000
    const entry = (days: number) => ({ thread: THREAD, at: new Date(Date.now() - days * day).toISOString() })
    store.set(KV.dingtalk.root('old'), entry(15)); store.set(KV.dingtalk.root('recent'), entry(13))
    store.set(KV.dingtalk.marker('a1b2c3d4'), entry(15)); store.set(KV.dingtalk.marker('e5f6a7b8'), entry(1))
    prune(ctx, Date.now())
    expect([store.get(KV.dingtalk.root('old')), store.get(KV.dingtalk.root('recent'))?.thread]).toEqual([undefined, THREAD])
    expect([store.get(KV.dingtalk.marker('a1b2c3d4')), store.get(KV.dingtalk.marker('e5f6a7b8'))?.thread]).toEqual([undefined, THREAD])
    store.close()
  })
})

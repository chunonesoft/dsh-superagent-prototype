/** Normalizes DingTalk robot messages, as `dingtalk-bot event consume` prints them, into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'dingtalk'
/** A message a reply quotes: a person's holds its words, a robot's holds only the `title` it was sent with, in `content.text`. */
const QuoteSchema = z.looseObject({
  msgId: z.string().optional(), senderId: z.string().optional(), msgType: z.string().optional(), createdAt: z.number().optional(),
  content: z.looseObject({ text: z.string().optional(), richText: z.array(z.looseObject({ text: z.string().optional() })).optional() }).optional(),
})
type Part = { type?: string | undefined; text?: string | undefined }
const TextSchema = z.looseObject({ content: z.string().default(''), isReplyMsg: z.boolean().optional(), repliedMsg: QuoteSchema.optional() })
const RichTextSchema = z.looseObject({
  richText: z.array(z.looseObject({ type: z.string().optional(), text: z.string().optional() })).default([]),
  isReplyMsg: z.boolean().optional(), repliedMsg: QuoteSchema.optional(),
})
/**
 * A message to the robot as the Stream gateway delivers it. A text message holds its words in `text`, a rich text message in
 * `content.richText`, and both may quote another message with `repliedMsg`. Fields the Source does not read are kept.
 */
export const BotMessageSchema = z.looseObject({
  msgId: z.string().min(1), conversationId: z.string().min(1), conversationType: z.union([z.string(), z.number()]).transform(String),
  conversationTitle: z.string().optional(), chatbotUserId: z.string().min(1),
  // The opaque `senderId` always comes; `senderStaffId` only for a member of the robot's organization.
  senderId: z.string().min(1), senderStaffId: z.string().optional(), isInAtList: z.boolean().optional(),
  msgtype: z.string().optional(), text: TextSchema.optional(), content: RichTextSchema.optional(),
  createAt: z.coerce.number().int().positive(),
  // A webhook that answers the conversation for a while, and the time in milliseconds it stops working.
  sessionWebhook: z.string().optional(), sessionWebhookExpiredTime: z.number().optional(),
})
export type BotMessage = z.infer<typeof BotMessageSchema>

/** Deterministic Trigger ID for a DingTalk message; a redelivery of the message is the same Trigger. */
export const dingtalkTriggerId = (messageId: string): string => key('dingtalk', messageId)
/** A Thread is a conversation and the message that opened it. */
export const dingtalkThreadId = (conversationId: string, rootId: string): string => `${conversationId}:${rootId}`
/**
 * The marker of a Thread: 8 hexadecimal digits of its key, which every reply to the Thread carries in its title. DingTalk gives a reply
 * no message ID the Source could keep, but a quote of the reply returns the title, so the marker leads back to the Thread.
 */
export const threadMarker = (threadKey: string): string => key(threadKey).slice(0, 8)
/** The title of a reply sent in the Thread with key `threadKey`. */
export const replyTitle = (threadKey: string): string => `dsh #${threadMarker(threadKey)}`
/** The marker in a reply's title, if `title` is one. */
export const markerIn = (title: string): string | undefined => /^dsh #([0-9a-f]{8})$/.exec(title.trim())?.[1]

/** Where a Trigger's reply goes: the conversation, the message it answers and Thread, the sender, and the session webhook while one came. */
export function dingtalkChannel(message: BotMessage, thread: string): ChannelRef {
  const { conversationId, senderStaffId, sessionWebhook, sessionWebhookExpiredTime } = message
  return { source: SOURCE, thread: `dingtalk:${conversationId}`, address: { conversationId, messageId: message.msgId, thread,
    ...message.conversationType === '1' ? { direct: 'true' } : {}, ...senderStaffId ? { staffId: senderStaffId } : {},
    ...sessionWebhook && sessionWebhookExpiredTime ? { webhook: sessionWebhook, expires: String(sessionWebhookExpiredTime) } : {} } }
}

/** What the Source remembers of earlier messages: the Thread of a message, and the Thread a reply's marker stands for (each a Thread ID). */
export interface Roots { rootOf(msgId: string): string | undefined; markedThread(marker: string): string | undefined }
const wordsOf = (parts: Part[]): string => parts.map(part => part.type === 'picture' ? '[image]' : part.text ?? '').join('')
/** The words of a message in either shape; a picture or a file reads as a placeholder, as the panel words it. */
function bodyOf(message: BotMessage): string {
  if (message.text) return message.text.content.trim()
  const parts = message.content?.richText ?? []
  if (parts.length) return wordsOf(parts).trim()
  return message.msgtype === 'picture' ? '[image]' : `[Media: ${message.msgtype ?? 'message'}]`
}
/**
 * Converts a robot message into a Trigger, returning undefined for the robot's own. A quote of a message the Source knows joins that
 * message's Thread: a quote of a reply of the robot by the marker in its title, a quote of a person's message by its ID. Any other
 * message opens a Thread of its own, and carries the words of a person's message it quotes, which the Thread does not hold.
 */
export function dingtalkTrigger(message: BotMessage, roots: Roots): Trigger | undefined {
  if (message.senderId === message.chatbotUserId) return
  const direct = message.conversationType === '1'
  const mentioned = message.isInAtList === true
  const quote = message.text?.repliedMsg ?? message.content?.repliedMsg
  const fromRobot = quote?.senderId === message.chatbotUserId
  // A person's message can hold any words, so only a robot's title is read for a marker.
  const marker = quote && fromRobot ? markerIn(quote.content?.text ?? '') : undefined
  const known = marker ? roots.markedThread(marker) : quote?.msgId && !fromRobot ? roots.rootOf(quote.msgId) : undefined
  // A Thread belongs to one conversation, so a Thread of another is not joined, whatever was stored.
  const joined = known?.startsWith(`${message.conversationId}:`) ? known : undefined
  const thread = joined ?? dingtalkThreadId(message.conversationId, message.msgId)
  const quoted = quote && !fromRobot && !joined ? (quote.content?.text ?? wordsOf(quote.content?.richText ?? [])).trim() : ''
  const body = bodyOf(message)
  const staffId = message.senderStaffId || undefined
  return { id: dingtalkTriggerId(message.msgId), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: staffId ?? message.senderId }, human: true,
    ...direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {},
    at: new Date(message.createAt).toISOString(), text: quoted ? `${quoted.split('\n').map(line => `> ${line}`).join('\n')}\n\n${body}` : body,
    channel: dingtalkChannel(message, thread),
    meta: { chatId: message.conversationId, messageId: message.msgId, direct, mentioned, ...staffId ? { staffId } : {},
      ...quote?.msgId && !fromRobot ? { repliedId: quote.msgId } : {} } }
}

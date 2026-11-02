/** DingTalk outbound channel: replies through the conversation's session webhook while it lives, and through the robot API after. */
import { threadKey, type OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import { SOURCE, dingtalkTriggerId, replyTitle } from './dingtalk-trigger.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'

/**
 * What the robot API says when a send can never reach its conversation, in the words the CLI reports (DingTalk's error code and
 * message). One wording was measured: a send to an `openConversationId` that names no conversation answers HTTP 400 with
 * `invalid.openConversationId: 无效的openConversationId`. The other two are expected and not measured: the robot removed from a group,
 * and a group dissolved. If DingTalk words either differently, the send is retried like any failure until this expression, the one
 * place that reads the words, is adjusted.
 */
const LEFT = new RegExp([
  // Measured.
  'invalid\\.openConversationId',
  // Expected: the robot removed from a group, and a group dissolved.
  'not (in|a member of) (the |this )?(conversation|group|chat)',
  '(conversation|group|chat)(id)? (does not exist|doesn\'t exist|not found|(is|was|has been) dissolved|no longer exists)',
  'notIn(conversation|group|chat)', '(conversation|group|chat)Not(exist|found)'].join('|'), 'i')
/**
 * True when the robot API refuses a send because the conversation ID is invalid, the robot left the conversation or the conversation is
 * gone, which no retry fixes. Anything else may pass, so it is no reason to drop the reply: a network error, a throttle, a token that
 * expired, or a refusal about something else all carry no such words, and a failure with no HTTP status (the CLI never got an answer) is
 * never one.
 */
const gone = (error: unknown): boolean =>
  error instanceof CliError && error.code !== undefined && [400, 403, 404].includes(error.code) && LEFT.test(error.message)

/** Whether the address names a session webhook that has not yet expired. */
const live = (address: Record<string, string>): boolean => !!address.webhook && Number(address.expires) > Date.now()

/**
 * Replies in the conversation the target message came from, titled with the Thread's marker so that a quote of the reply finds the
 * Thread again. A live session webhook is tried first, as it can mention the sender; if it fails for any reason, or has expired, the robot
 * API sends instead, and only its answer decides `gone`. Neither has an idempotency key: a send whose answer was lost may be sent twice.
 */
export async function sendDingtalk(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { address } = message.channel
  const { conversationId, thread, staffId } = address
  if (!conversationId || !thread) throw new Error('Missing DingTalk reply target')
  const text = checkedImText(message.text)
  const title = replyTitle(threadKey({ source: SOURCE, id: thread }))
  const direct = address.direct === 'true'
  const send = (target: [string, string], ...extra: string[]) => host.commands.dingtalk(['message', 'send', ...target, '--title', title, '--text-stdin', ...extra], text)
  if (live(address)) {
    try {
      // Nobody needs a mention in a direct chat, and a sender with no staff ID cannot be named.
      await send(['--conversation', conversationId], '--webhook', address.webhook!, ...!direct && staffId ? ['--at', staffId] : [])
      return 'sent'
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      /* The webhook expired early or was refused; the robot API still reaches the conversation. */
    }
  }
  // A group is reached by its conversation, a direct chat by the person.
  if (direct && !staffId) throw new Error('DingTalk cannot reach this direct chat: its session webhook is gone and the sender has no staff ID')
  try { await send(direct ? ['--user', staffId!] : ['--conversation', conversationId]) }
  catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** DingTalk offers no address for a conversation or a message, so the link is empty and only names the Trigger of the message. */
export const dingtalkLink = (address: Record<string, string>): ChannelLink => ({
  url: '', label: { zh: '钉钉消息', en: 'DingTalk message' }, ...address.messageId ? { triggerId: dingtalkTriggerId(address.messageId) } : {},
})

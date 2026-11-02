/** DingTalk source kind definition and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { DingtalkBotSchema } from '../deployment.ts'
import { dingtalkLink, sendDingtalk } from './dingtalk-channel.ts'
import { runDingtalk } from './dingtalk-loops.ts'
import { SOURCE, dingtalkTriggerId } from './dingtalk-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'

/** A conversation ID, which DingTalk starts with `cid`; a staff ID is the member's ID in the organization, which holds neither `$` nor `:`, as DingTalk's opaque IDs do. */
const CHAT_ID = /^cid[A-Za-z0-9+/=_-]+$/
const STAFF_ID = /^[A-Za-z0-9_.-]{1,64}$/
const DingtalkConfigSchema = DingtalkBotSchema.extend({
  chats: z.array(z.object({ chatId: z.string().regex(CHAT_ID), name: z.string().trim().max(60).optional() }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type DingtalkConfig = z.infer<typeof DingtalkConfigSchema>
export const dingtalkKind: SourceKind<DingtalkConfig> = {
  kind: SOURCE,
  title: { zh: '钉钉', en: 'DingTalk' },
  description: { zh: '接收下列群和私聊中发给机器人的消息。机器人在群里只收得到 @ 它的消息，读不了群历史，所以服务停机期间的消息不会补收。', en: 'Receives messages to the robot in these chats and direct messages. In a group the robot receives only the messages that mention it and cannot read chat history, so messages sent while dsh-superagent is down are lost.' },
  schema: DingtalkConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: '机器人的 dingtalk-bot', en: 'Bot dingtalk-bot' },
      hint: { zh: '命令名或绝对路径，指向用机器人应用的凭证配置好的 dingtalk-bot（通常是设置了 DINGTALK_BOT_CONFIG_DIR 的包装脚本）；执行器以 dingtalk-bot 调用它。保存时读取应用和机器人，然后重启 dsh-superagent。', en: 'A command name or absolute path of dingtalk-bot configured with the robot app\'s credentials, usually a wrapper script that sets DINGTALK_BOT_CONFIG_DIR; the Executor calls it as dingtalk-bot. Saving reads the app and the robot, then restarts dsh-superagent.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Chats' },
      hint: { zh: '机器人在群里只收得到 @ 它的消息，所以没有“全部消息”。机器人被移出群后无法再回复。', en: 'In a group the robot receives only the messages that mention it, so there is no "All" option. The robot cannot reply once it is removed from a group.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群', en: 'Chat' }, pattern: 'cid[A-Za-z0-9_=+\\/\\-]+', choose: { zh: '选择机器人收到过消息的群', en: 'Choose a chat that has messaged the robot' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other chats' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '机器人已加入、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。', en: 'Chats the robot has joined that are not listed above. "@ only" receives messages there that mention the robot; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
  ],
  health: [SOURCE],
  // The robot hears only what is addressed to it, so nothing here is observed.
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: false, row: chat.chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a chat the Source still receives.
  channel: {
    allowed: (address, config) =>
      dingtalkKind.scope!({ meta: { chatId: address.conversationId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendDingtalk, link: dingtalkLink,
  },
  // A message's Trigger is named after the message, so the one it answers is named after the message it quotes.
  repliesTo: trigger => typeof trigger.meta.repliedId === 'string' ? dingtalkTriggerId(trigger.meta.repliedId) : undefined,
  policy: {
    unnamed: { person: { zh: '钉钉用户', en: 'DingTalk user' }, bot: { zh: '钉钉机器人', en: 'DingTalk bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(STAFF_ID), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate staff IDs').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的钉钉用户', en: 'DingTalk users who may originate work' },
        hint: { zh: '填员工在企业里的 staffId，即钉钉管理后台通讯录成员详情里的 userId，也可以请管理员查。不是企业成员的人没有 staffId，不能加入名单。', en: 'The staffId of a member of the organization, which the member details in the contacts of the DingTalk admin console show as the user ID; an administrator can look it up. Someone outside the organization has no staffId and cannot be listed.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'staffId', en: 'staffId' }, pattern: '[A-Za-z0-9_.\\-]{1,64}' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the robot or messages it directly always makes an explicit request; that needs no setting.' },
    rows(stored) {
      const config = DingtalkConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      // The robot never receives a message that does not address it, so no row admits an unaddressed one.
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: mentions,
          cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_DINGTALK_BOT', description: { zh: '钉钉机器人的 robotCode；dingtalk-bot 以它行事', en: 'The robotCode of the DingTalk robot; dingtalk-bot acts as it' } },
      { key: 'DSH_SUPERAGENT_DINGTALK_CONVERSATION', description: { zh: '接下工单的钉钉会话 ID；工单不是从钉钉来的时为空', en: 'ID of the DingTalk conversation that started the ticket; empty when the ticket did not start on DingTalk' } },
    ],
    values: ({ deployment, trigger }) => ({ DSH_SUPERAGENT_DINGTALK_BOT: deployment.dingtalk?.robotCode ?? '',
      DSH_SUPERAGENT_DINGTALK_CONVERSATION: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.dingtalk
    ? { cli: { zh: `当前机器人 ${deployment.dingtalk.robotCode}`, en: `Current bot ${deployment.dingtalk.robotCode}` } } : {},
}

export const name = 'dsh-superagent-dingtalk'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(dingtalkKind), 'dingtalk: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runDingtalk(sourceContext(ctx.orchestrator, dingtalkKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}

/** Merge request binding, lifecycle observation, and terminal IM notification helpers, and the GitLab `PullHost` that offers them. */
import type { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import { gitlabOf, type Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { ticketBranch } from './github-pull.ts'
import { MergeRequestSchema, SOURCE, threadIdOf } from './gitlab-trigger.ts'
import { pullNumber, pullNumbers, type PullHost } from './pulls.ts'

export type Mr = z.infer<typeof MergeRequestSchema>
/** The Thread of merge request `iid`, as `Follow.thread` and the Source's Thread keys name it. */
const threadOf = (iid: number): string => `${SOURCE}:${threadIdOf({ kind: 'mr', iid })}`
export const readMr = (ctx: SourceContext, iid: number, signal?: AbortSignal): Promise<Mr> =>
  ctx.commands.withSignal(signal).gitlab(MergeRequestSchema, `merge_requests/${iid}`)
/** True when the MR was opened by the agent account from a branch in the configured project (not a fork). */
export const agentMr = (mr: Pick<Mr, 'author' | 'source_project_id' | 'target_project_id'>, deployment: Pick<Deployment, 'gitlab'>): boolean => {
  const { login, projectId } = gitlabOf(deployment)
  return sameName(mr.author.username, login) && mr.source_project_id === projectId && mr.target_project_id === projectId
}
/** Whether `ticket` follows merge request `iid` and it is still open; the number alone does not tell it from a pull request on another code host. */
const followsOpen = (ticket: Pick<Ticket, 'follows'>, iid: number): boolean => !!ticket.follows?.some(item => item.thread === threadOf(iid) && !item.closed)

/**
 * Validates and binds an open MR to a ticket when the MR is either the ticket's origin MR or an agent-authored MR on the ticket's branch, enforcing that one MR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the MR is bound or when the MR is not open (which is not an error).
 */
export function claimMr(ctx: SourceContext, ticketId: string, mr: Mr): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its MR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.isMr === true && source.meta.iid === mr.iid
  const opened = agentMr(mr, ctx.deployment) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const { login } = gitlabOf(ctx.deployment)
    return `MR does not belong to this ticket: use the source MR or an MR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no MR exists`
  }
  const owner = ctx.tickets.open().find(item => followsOpen(item, mr.iid))
  if (owner && owner.id !== ticketId) return 'MR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === threadOf(mr.iid))
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}
/**
 * Reconciles a polled MR's opened/merged/closed state with any bound or branch-matching ticket.
 * An open agent MR auto-binds to the single open ticket on its branch unless that ticket already follows another open MR
 * (which only the Executor's report changes). A draft is an open MR: GitLab 11.7 marks it with `work_in_progress` and sends no `draft`.
 * @returns whether the MR has ended.
 */
export async function observeMr(ctx: SourceContext, mr: Mr): Promise<boolean> {
  const ended = mr.state === 'merged' || mr.state === 'closed'
  if (ended) closeMr(ctx, mr)
  else {
    const candidates = agentMr(mr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // An MR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === threadOf(mr.iid) && item.closed)
    if (ticket && (reopened || pullNumbers(ticket, true).every(number => number === mr.iid))) claimMr(ctx, ticket.id, mr)
  }
  return ended
}
function bind(ctx: SourceContext, ticketId: string, mr: Mr, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: threadIdOf({ kind: 'mr', iid: mr.iid }) }, own)
    ctx.threads.patch(threadOf(mr.iid), { iid: mr.iid, isMr: true, url: mr.web_url, mrAuthor: mr.author.username })
  })
}
/**
 * Reports a merged or closed MR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the MR stays so a later human note there resumes the ticket.
 */
function closeMr(ctx: SourceContext, mr: Mr): void {
  if (!ctx.tickets.open().some(ticket => followsOpen(ticket, mr.iid))) return
  const merged = mr.state === 'merged'
  // GitLab 11.7 can send no `merged_at`; the MR's last change is then its merge.
  const at = (merged ? mr.merged_at : mr.closed_at) ?? mr.updated_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: threadIdOf({ kind: 'mr', iid: mr.iid }) }, merged ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its MR (selecting the last-closed MR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English. `url` gives the page GitLab named for an MR, which is linked when there is one.
 */
export function mrEndNotices(ticket: Ticket, request: string, url: (iid: number) => string | undefined): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && item.thread.startsWith(`${SOURCE}:`) && pullNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const iid = pullNumber(follow.thread)!
  const page = url(iid)
  const name = page ? `[MR !${iid}](${page})` : `MR !${iid}`
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `${name} 已合并。` : `${name} 已关闭，未合并。`
    : outcome === 'merged' ? `${name} has merged.` : `${name} was closed without merging.`
  // GitLab shows the merge or closure on the MR and on the Issues it closes, so GitLab channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
/**
 * The merge requests of a GitLab deployment, read from and noticed with the configured project.
 * @throws when the deployment has no GitLab account.
 */
export function gitlabPullHost(ctx: SourceContext): PullHost {
  const { login } = gitlabOf(ctx.deployment)
  return {
    agent: login,
    prepare: async (iid, signal) => {
      const mr = await readMr(ctx, iid, signal)
      return ticketId => claimMr(ctx, ticketId, mr)
    },
    // The link is the page the Thread recorded from GitLab's `web_url`, never one built from the project's address.
    endNotices: (ticket, request) => mrEndNotices(ticket, request, iid => {
      const url = ctx.threads.get(threadOf(iid))?.meta.url
      return typeof url === 'string' && url ? url : undefined
    }),
  }
}

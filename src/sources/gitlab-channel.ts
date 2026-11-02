/** GitLab outbound channel: posts notes on Issues and merge requests under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { gitlabOf } from '../deployment.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { NoteSchema, type GitlabNote } from './gitlab-trigger.ts'

/** True when an Issue or merge request is permanently deleted (410); 404 is retried because it can indicate temporary permission loss on a private project. */
const gone = (error: unknown): boolean => error instanceof CliError && error.code === 410
/** Posts a note with an embedded HTML marker so retries do not create duplicate notes. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { login } = gitlabOf(commands.deployment)
  const { kind, iid } = message.channel.address
  const number = Number(iid)
  if ((kind !== 'issue' && kind !== 'mr') || !Number.isSafeInteger(number) || number < 1) throw new Error('Missing GitLab reply target')
  const path = `${kind === 'mr' ? 'merge_requests' : 'issues'}/${number}/notes`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  const mine = (note: GitlabNote) => sameName(note.author.username, login) && (note.body ?? '').includes(marker)
  try {
    if ((await commands.gitlabPages(NoteSchema, path)).some(mine)) return 'sent'
    await commands.gitlab(z.unknown(), path, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** Links to the page GitLab named in the address; without one the link is empty rather than built from the instance's address. */
export function gitlabLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const label = `GitLab ${address.kind === 'mr' ? 'MR !' : 'Issue #'}${address.iid ?? ''}`
  return { url: address.url ?? '', label: { zh: label, en: label } }
}

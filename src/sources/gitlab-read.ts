/** Read-only GitLab project, conversation, and pipeline inspection for assessments and workers. */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import { gitlabOf } from '../deployment.ts'
import { validItems, type Commands } from '../infra/commands.ts'
import { IssueSchema, MergeRequestSchema, NoteSchema } from './gitlab-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

const TreeEntrySchema = z.looseObject({ name: z.string() })
const PipelineSchema = z.looseObject({ id: z.number(), status: z.string(), sha: z.string(), ref: z.string().nullish(), web_url: z.string().nullish() })
/** A note with the time it was written, which `NoteSchema` leaves out because a Trigger carries the time of its last edit. */
const ListedNoteSchema = NoteSchema.extend({ created_at: z.string().nullish() })
const LabelsSchema = z.object({ labels: z.array(z.string()).nullish() })
const IssueDescriptionSchema = IssueSchema.extend(LabelsSchema.shape)
const MrDescriptionSchema = MergeRequestSchema.extend(LabelsSchema.shape)

/**
 * Reads a non-hidden file or directory listing from the project's default branch via the GitLab API; hidden entries and `node_modules`
 * are rejected. A file's whole path is one encoded path segment, so nothing in it can leave the project.
 */
export async function readGitlabPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  // An empty project has no default branch to name, and nothing to read.
  const { defaultBranch } = gitlabOf(commands.deployment)
  const ref = defaultBranch ? `ref=${encodeURIComponent(defaultBranch)}` : ''
  const place = encodeURIComponent(parts.join('/'))
  if (kind === 'file') {
    if (!parts.length) throw new Error('Name a file of the repository')
    return commands.gitlabRaw(`repository/files/${place}/raw${ref && `?${ref}`}`)
  }
  const query = [...parts.length ? [`path=${place}`] : [], ...ref ? [ref] : []].join('&')
  const entries = await commands.gitlabPages(TreeEntrySchema, `repository/tree${query && `?${query}`}`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}

/** Formats a GitLab Issue, merge request, or note as a model-facing ContextMessage; GitLab names a page for the first two only. */
function gitlabMessage(item: { author: { username: string } }, at: string, text: string, id: string, url?: string): ContextMessage {
  return { id, from: item.author.username, at, text, ...url ? { url } : {} }
}
const noteMessage = (note: z.infer<typeof ListedNoteSchema>) => gitlabMessage(note, note.created_at ?? note.updated_at, note.body ?? '', String(note.id))

/**
 * Reads an Issue or merge request, a page of its notes, or a merge request's pipelines as model-facing `{ id, from, at, text, url? }`
 * messages rather than raw GitLab API records. GitLab's own notes ("closed", "added 1 commit") are left out.
 */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const match = /^gitlab\/(issues|merge_requests)\/([1-9]\d*)(?:\/(notes|pipelines)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) {
    throw new Error('Use gitlab/issues/<iid> or gitlab/merge_requests/<iid> for the description, and append /notes/<page>, or /pipelines for a merge request')
  }
  const [, kind, iid, section, page = '1'] = match
  if (kind === 'issues' && section === 'pipelines') throw new Error('Pipelines require a merge request')
  const path = `${kind}/${iid}`
  if (section === 'pipelines') {
    if (match[4]) throw new Error('Pipelines do not take a page number')
    const pipelines = validItems(PipelineSchema, await commands.gitlab(z.array(z.unknown()), `${path}/pipelines`))
    return { pipelines: pipelines.slice(0, 20).map(pipeline => ({ id: pipeline.id, status: pipeline.status, ...pipeline.ref ? { ref: pipeline.ref } : {},
      sha: pipeline.sha.slice(0, 7), ...pipeline.web_url ? { url: pipeline.web_url } : {} })) }
  }
  if (!section) {
    const labelled = (labels: string[] | null | undefined) => labels?.length ? { labels } : {}
    if (kind === 'issues') {
      const item = await commands.gitlab(IssueDescriptionSchema, path)
      return { iid: item.iid, title: item.title, state: item.state, ...labelled(item.labels),
        ...gitlabMessage(item, item.created_at, item.description ?? '', String(item.iid), item.web_url) }
    }
    const item = await commands.gitlab(MrDescriptionSchema, path)
    return { iid: item.iid, title: item.title, state: item.state, ...item.draft || item.work_in_progress ? { draft: true } : {},
      source_branch: item.source_branch, target_branch: item.target_branch, ...labelled(item.labels),
      ...gitlabMessage(item, item.created_at, item.description ?? '', String(item.iid), item.web_url) }
  }
  const listed = await commands.gitlab(z.array(z.unknown()), `${path}/notes?sort=asc&order_by=created_at&per_page=20&page=${page}`)
  const tally = { skipped: 0 }
  const notes = validItems(ListedNoteSchema, listed, tally).filter(note => !note.system)
  return { messages: notes.map(noteMessage), ...tally.skipped ? { skipped: tally.skipped } : {},
    ...listed.length === 20 ? { next_resource: `gitlab/${kind}/${iid}/notes/${Number(page) + 1}` } : {} }
}

/** Reads one page of an Issue or merge request conversation (with its description first on page 1), using the description's page and the notes' ids as message IDs. */
async function conversationPage(commands: Commands, trigger: Trigger, page: number) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Not a GitLab page number')
  const iid = Number(trigger.meta.iid)
  if (!Number.isSafeInteger(iid) || iid < 1) throw new Error('Missing GitLab Issue or merge request number')
  const path = `${trigger.meta.isMr === true ? 'merge_requests' : 'issues'}/${iid}`
  const messages: ContextMessage[] = []
  if (page === 1) {
    const item = await commands.gitlab(IssueSchema, path)
    messages.push(gitlabMessage(item, item.created_at, `${item.title}\n\n${item.description ?? ''}`, item.web_url, item.web_url))
  }
  const listed = await commands.gitlab(z.array(z.unknown()), `${path}/notes?sort=asc&order_by=created_at&per_page=100&page=${page}`)
  const tally = { skipped: 0 }
  messages.push(...validItems(ListedNoteSchema, listed, tally).filter(note => !note.system).map(noteMessage))
  return { messages, next_resource: listed.length === 100 ? String(page + 1) : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}
/**
 * Context reader for a GitLab Trigger: the Issue or merge request conversation by page, whose first page is its root and parent, or,
 * for a pipeline, the Trigger itself. A note is its own message by its id, and an opening by its page.
 */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.meta.kind === 'note' ? String(trigger.meta.noteId) : trigger.url ?? '',
  read: async (commands, trigger, _part, cursor) => {
    // A pipeline has no conversation; its Trigger is its context.
    if (trigger.meta.ci === true) {
      const message = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true as const }
      return { messages: [message], body: { status: 'pipeline', messages: [message] }, status: 'pipeline' }
    }
    const body = await conversationPage(commands, trigger, Number(cursor ?? '1'))
    return { messages: body.messages, next: body.next_resource ?? undefined, body }
  },
}

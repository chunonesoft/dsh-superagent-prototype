/** Normalizes GitLab Issues, merge requests, notes, and pipeline transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** An Issue or merge request of the project; `url` is the page GitLab names in its `web_url`, and `mrAuthor` the user name of a merge request's author. */
export interface GitlabRef { kind: 'issue' | 'mr'; iid: number; url?: string; mrAuthor?: string }
/** GitLab numbers Issues and merge requests separately, so the Thread names the kind: `issue:3` or `mr:7`. */
export const threadIdOf = (ref: GitlabRef): string => `${ref.kind}:${ref.iid}`
/** GitLab reply address: the Issue or merge request that receives the note, and its page when known. */
export const gitlabChannel = (ref: GitlabRef, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${threadIdOf(ref)}`, address: { kind: ref.kind, iid: String(ref.iid), ...(url ? { url } : {}) } })
/** The path segment before the number in the web URL of each kind of page. */
const PAGES = new Map<string, GitlabRef['kind']>([['issues', 'issue'], ['merge_requests', 'mr']])
/**
 * Parses the web URL of an Issue or merge request in `project`, with or without the `/-/` that newer GitLab puts before the page and
 * under any URL root (`https://git.example.com/gitlab/acme/widgets/merge_requests/7#note_3`); returns undefined for other URLs or projects.
 * The project path must match whole segments and may differ in case, as GitLab paths do; the host is not checked.
 */
export function gitlabAddress(url: string, project: string): GitlabRef | undefined {
  let address: URL
  try { address = new URL(url) } catch { return undefined /* Not an address. */ }
  if (address.protocol !== 'http:' && address.protocol !== 'https:') return undefined
  const path = address.pathname.split('/').filter(Boolean)
  const digits = path.pop() ?? ''
  const kind = PAGES.get(path.pop() ?? '')
  if (!kind || !/^[1-9]\d*$/.test(digits) || !Number.isSafeInteger(Number(digits))) return undefined
  if (path.at(-1) === '-') path.pop()
  const names = project.split('/')
  const found = path.slice(-names.length)
  return found.length === names.length && names.every((name, index) => sameName(found[index]!, name)) ? { kind, iid: Number(digits) } : undefined
}
/** The account that wrote a note, an Issue or a merge request. */
const UserSchema = z.looseObject({ username: z.string() })
/** A note on an Issue or merge request; `system` marks the ones GitLab writes itself, such as "closed" or "added 1 commit". */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), system: z.boolean(), author: UserSchema, updated_at: z.string(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
/**
 * An Issue as `issues/<iid>` returns it; `iid` is its number in the project, whereas `id` is not. Timestamps carry the instance's offset
 * (`+08:00`) in some fields and `Z` in others, so compare them as instants, never as strings.
 */
export const IssueSchema = z.looseObject({
  iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(), author: UserSchema,
  created_at: z.string(), updated_at: z.string().nullish(), closed_at: z.string().nullish(), web_url: z.string(),
})
type GitlabIssue = z.infer<typeof IssueSchema>
/**
 * A merge request as `merge_requests/<iid>` returns it; `state` is `opened`, `merged`, `closed` or `locked`, and `source_project_id` is
 * null once the fork it came from is deleted. GitLab 11.7 marks a draft with `work_in_progress` and has no `draft`, whereas newer versions
 * send both.
 */
export const MergeRequestSchema = IssueSchema.extend({
  source_branch: z.string(), target_branch: z.string(), source_project_id: z.number().nullish(), target_project_id: z.number(),
  merged_at: z.string().nullish(), work_in_progress: z.boolean().nullish(), draft: z.boolean().nullish(),
})
/** What the Trigger of an opening reads from an Issue or merge request. */
export type GitlabOpened = Pick<GitlabIssue, 'title' | 'description' | 'author' | 'created_at' | 'web_url'>
/**
 * True when `text` mentions `@login`. A user name holds letters, digits, `_`, `-` and `.`, never ends with `.`, and matches without regard
 * to case, so `foo@login` (an email address) and `@logins` or `@login.x` (longer names) are no mention, whereas `@login.` and `@login,`
 * at the end of a sentence are.
 */
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_.@-])@${escapeRegExp(login)}(?![a-zA-Z0-9_-]|\\.[a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: { username: string }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: !sameName(user.username, agent) })
/**
 * Builds a trigger for a note; returns undefined for a note GitLab wrote itself and for the agent's own, which it must never answer.
 * The ID holds the note's text rather than its `updated_at`, which GitLab also moves when a discussion is resolved, so only an edit of
 * the text makes the note a new Trigger.
 */
export function noteTrigger(note: GitlabNote, ref: GitlabRef, agent: string): Trigger | undefined {
  if (note.system || sameName(note.author.username, agent)) return undefined
  const thread = threadIdOf(ref)
  const body = note.body ?? ''
  return { id: key('gitlab-note', thread, String(note.id), body), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    ...author(note.author, agent), at: note.updated_at, text: body,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref, ref.url), ...(ref.url ? { url: ref.url } : {}),
    meta: { iid: ref.iid, isMr: ref.kind === 'mr', ...(ref.mrAuthor ? { mrAuthor: ref.mrAuthor } : {}), noteId: note.id, kind: 'note' } }
}
/**
 * Builds the trigger for a newly opened Issue's or merge request's title and description.
 * The ID holds only the Thread, because GitLab also moves `updated_at` for comments and labels, so an edit of the description cannot be
 * told from them: only the opening is ingested.
 */
export function openedTrigger(item: GitlabOpened, ref: GitlabRef, agent: string): Trigger {
  const thread = threadIdOf(ref)
  const body = item.description ?? ''
  return { id: key('gitlab-opened', thread), source: SOURCE, threads: [{ source: SOURCE, id: thread }], ...author(item.author, agent),
    at: item.created_at, text: `${item.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref, item.web_url), url: item.web_url,
    meta: { iid: ref.iid, isMr: ref.kind === 'mr', ...(ref.kind === 'mr' ? { mrAuthor: item.author.username } : {}), kind: ref.kind } }
}
/** Builds a trigger for a pipeline status change on `ref`; a pipeline has no person to reply to, so it has no `channel`. */
export function pipelineTrigger(ref: string, status: string, revision: number, url: string): Trigger {
  return { id: key('gitlab-pipeline', ref, String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: `pipeline:${ref}` }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text: `Pipeline on ${ref}: ${status}`, url,
    meta: { ci: true, ref, status, revision } }
}

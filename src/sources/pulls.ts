/** The pull request interface of the code host a deployment works on, and which pull requests a Ticket follows on any host. */
import type { OutboundMessage, Ticket } from '../core/index.ts'

/** What Executor tools and Runtime need of a code host's pull requests; a merge request is a pull request here. */
export interface PullHost {
  /** The agent's account name on the code host, for tool descriptions. */
  readonly agent: string
  /** Reads pull request `number`; the returned function binds it inside the caller's transaction and returns why it was refused, or undefined. */
  prepare(number: number, signal?: AbortSignal): Promise<(ticketId: string) => string | undefined>
  /** The chat notices of a Ticket that ended merged or closed with its pull request, worded for the language of its source `request`. */
  endNotices(ticket: Ticket, request: string): OutboundMessage[]
}

/** The number a pull request Thread key names, `github:<number>` or `gitlab:mr:<number>`; an Issue, a pipeline or another Source's Thread names none. */
export function pullNumber(thread: string): number | undefined {
  const digits = /^(?:github|gitlab:mr):(\d+)$/.exec(thread)?.[1]
  return digits === undefined ? undefined : Number(digits)
}
/** The numbers of the pull requests a Ticket follows, in the order it began to follow them; with `open`, only those still open. */
export function pullNumbers(ticket: Pick<Ticket, 'follows'>, open = false): number[] {
  return (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullNumber(item.thread) ?? [])
}
/** The Ticket's pull request: the latest one it follows that is open, else the latest that closed. */
export function pullOf(ticket: Pick<Ticket, 'follows'>): number | undefined {
  return pullNumbers(ticket, true).at(-1) ?? pullNumbers(ticket).at(-1)
}

/** The pull requests a Ticket follows, read from the Thread keys of either code host. */
import { expect, it } from 'vitest'
import type { Follow } from '../src/core/index.ts'
import * as github from '../src/sources/github-pull.ts'
import { pullNumber, pullNumbers, pullOf } from '../src/sources/pulls.ts'

const open = (thread: string): Follow => ({ thread, own: true })
const closed = (thread: string): Follow => ({ thread, own: true, closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'merged' } })

it('reads pull numbers from both thread shapes', () => {
  expect([pullNumber('github:12'), pullNumber('gitlab:mr:7')]).toEqual([12, 7])
  expect(pullNumbers({ follows: [open('github:12')] })).toEqual([12])
  expect(pullNumbers({ follows: [open('gitlab:mr:7')] })).toEqual([7])
  expect(pullNumbers({ follows: [open('github:12'), open('gitlab:mr:7')] })).toEqual([12, 7])
})

it('ignores issues and pipelines', () => {
  const threads = ['gitlab:issue:3', 'gitlab:pipeline:main', 'github:ci:main', 'feishu:oc_1:om_1']
  expect(threads.map(pullNumber)).toEqual([undefined, undefined, undefined, undefined])
  expect(pullNumbers({ follows: threads.map(open) })).toEqual([])
  expect(pullNumbers({})).toEqual([])
})

it('lists the open pull requests only when asked', () => {
  const ticket = { follows: [closed('github:12'), open('gitlab:mr:7')] }
  expect(pullNumbers(ticket)).toEqual([12, 7])
  expect(pullNumbers(ticket, true)).toEqual([7])
})

it('names the latest open pull request of a ticket, else its latest closed one', () => {
  expect(pullOf({ follows: [open('github:12'), closed('github:13')] })).toBe(12)
  expect(pullOf({ follows: [open('gitlab:mr:7'), open('gitlab:mr:8')] })).toBe(8)
  expect(pullOf({ follows: [closed('github:12'), closed('github:13')] })).toBe(13)
  expect(pullOf({ follows: [open('gitlab:issue:3')] })).toBeUndefined()
  expect(pullOf({})).toBeUndefined()
})

it('stays importable from the GitHub module', () => {
  expect(github.pullOf).toBe(pullOf)
})

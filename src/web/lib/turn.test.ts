import { expect, test } from 'vitest'
import { errorView, idleTurn, liveSegments, type Turn, type TurnAction, turnReducer } from './turn'

const run = (...actions: TurnAction[]) => actions.reduce(turnReducer, idleTurn)
const ev = (event: string, data: object = {}, now = 0): TurnAction => ({ type: 'event', event, data, now })

test('text streams into one segment until a status after text opens another', () => {
  const t = run({ type: 'start', now: 1 }, ev('status', { kind: 'thinking' }), ev('text', { delta: 'Hel' }), ev('text', { delta: 'lo.' }))
  expect(liveSegments(t)).toEqual(['Hello.'])
  const next = turnReducer(t, ev('status', { kind: 'searching' }, 5))
  expect(liveSegments(next)).toEqual(['Hello.', ''])
  expect([next.status, next.waitingSince, next.refetch]).toEqual(['searching', 5, t.refetch + 1])
  // A status before any text only changes the label.
  expect(liveSegments(run({ type: 'start', now: 1 }, ev('status', { kind: 'searching' })))).toEqual([''])
})

test('done drops an empty waiting segment', () => {
  const t = run({ type: 'start', now: 1 }, ev('status', { kind: 'thinking' }), ev('done', { awaiting: false }))
  expect(t.running).toBe(false)
  expect(liveSegments(t)).toEqual([])
})

test('card and focus events ask for a refetch, and a sync drops what the thread now holds', () => {
  const t = run({ type: 'start', now: 1 }, ev('text', { delta: 'Pick one.' }), ev('card'))
  expect(t.refetch).toBe(1)
  const synced = turnReducer(t, { type: 'synced', upTo: t.committed })
  expect(liveSegments(synced)).toEqual([])
  const focused = run({ type: 'start', now: 1 }, ev('text', { delta: 'Opening it.' }), ev('focus', { nodeId: 'n1' }), ev('text', { delta: 'Lesson' }))
  expect(focused.refetch).toBe(1)
  expect(liveSegments(turnReducer(focused, { type: 'synced', upTo: focused.committed }))).toEqual(['Lesson'])
})

test('a stored answer asks for a refetch and keeps the waiting segment', () => {
  const t = run({ type: 'start', now: 1 }, ev('answered'))
  expect(t.refetch).toBe(1)
  expect(liveSegments(turnReducer(t, { type: 'synced', upTo: t.committed }))).toEqual([''])
})

test('start is ignored while a turn runs, and errors end it', () => {
  const t = run({ type: 'start', now: 1 }, ev('text', { delta: 'x' }))
  expect(turnReducer(t, { type: 'start', now: 9 })).toBe(t)
  const failed: Turn = turnReducer(t, { type: 'fail', message: 'The tutor is still replying.' })
  expect([failed.running, failed.error]).toEqual([false, 'The tutor is still replying.'])
  expect(run({ type: 'start', now: 1 }, ev('error', { message: 'boom' }), ev('done')).error).toBe('boom')
})

test('every error reads as one plain line', () => {
  const signedOut = "Claude isn't signed in. Run `claude setup-token`, set CLAUDE_CODE_OAUTH_TOKEN, and restart the server."
  expect(errorView(signedOut)).toEqual({ text: `⚠ ${signedOut}` })
  expect(errorView('The reply was too long and got cut off.')).toEqual({ text: '⚠ The reply was too long and got cut off.' })
})

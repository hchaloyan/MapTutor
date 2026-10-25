export type Status = 'thinking' | 'searching'

/**
 * The live part of one turn: tutor text not yet in the fetched thread. Segment indexes are absolute
 * (`dropped` counts segments already removed), so overlapping refetches each drop exactly what they saw stored.
 */
export type Turn = {
  running: boolean
  segments: string[]
  dropped: number
  /** Segments before this absolute index are stored on the server; the next refetch shows them. */
  committed: number
  status: Status
  waitingSince: number
  error: string | null
  /** Bumped whenever the stored thread changed; the page refetches and then dispatches `synced`. */
  refetch: number
}

export type TurnAction =
  | { type: 'start'; now: number }
  | { type: 'event'; event: string; data: any; now: number }
  | { type: 'fail'; message: string }
  | { type: 'synced'; upTo: number }

export const idleTurn: Turn = { running: false, segments: [], dropped: 0, committed: 0, status: 'thinking', waitingSince: 0, error: null, refetch: 0 }

const end = (t: Turn) => t.dropped + t.segments.length
const finish = (t: Turn): Turn => ({ ...t, running: false, committed: end(t), refetch: t.refetch + 1 })
const boundary = (t: Turn, now: number): Turn => ({ ...t, segments: [...t.segments, ''], committed: end(t), refetch: t.refetch + 1, waitingSince: now })

export function turnReducer(t: Turn, a: TurnAction): Turn {
  switch (a.type) {
    case 'start':
      return t.running ? t : { ...t, running: true, segments: [...t.segments, ''], status: 'thinking', waitingSince: a.now, error: null }
    case 'fail':
      return finish({ ...t, error: a.message })
    case 'synced': {
      const k = a.upTo - t.dropped
      return k > 0 ? { ...t, segments: t.segments.slice(k), dropped: a.upTo } : t
    }
    case 'event':
      switch (a.event) {
        case 'text':
          return { ...t, segments: [...t.segments.slice(0, -1), (t.segments.at(-1) ?? '') + a.data.delta] }
        case 'status':
          // A new step after streamed text: the earlier text is stored now, and this step gets its own card.
          return { ...(t.segments.at(-1) ? boundary(t, a.now) : t), status: a.data.kind }
        case 'card':
          return { ...t, committed: end(t), refetch: t.refetch + 1 }
        case 'focus':
          return boundary(t, a.now)
        case 'error':
          return { ...t, error: a.data.message }
        case 'done':
          return finish(t)
      }
  }
  return t
}

/** What to draw after the thread: streamed texts, and an empty last one as the waiting card while running. */
export const liveSegments = (t: Turn) => t.segments.filter((s, i) => s || (t.running && i === t.segments.length - 1))

export function errorView(message: string) {
  return message === 'Your Anthropic API key was rejected.'
    ? { text: '⚠ Your Anthropic API key was rejected. Check it under', keyLink: true }
    : { text: `⚠ ${message}`, keyLink: false }
}

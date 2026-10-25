import { ApiError } from './api'
import { getKey } from './key'

export type SseEvent = { event: string; data: any }

/** Splits complete `event:`/`data:` frames off the buffer; a partial frame stays in `rest`. */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const frames = buffer.split('\n\n')
  const rest = frames.pop()!
  return {
    events: frames.filter(Boolean).map(f => ({
      event: /^event: (.*)$/m.exec(f)?.[1] ?? 'message',
      data: JSON.parse(/^data: (.*)$/m.exec(f)?.[1] ?? 'null'),
    })),
    rest,
  }
}

/** Posts to a turn route and feeds its events to `onEvent` until `done`. A 204 (nothing to run) resolves at once. */
export async function postStream(path: string, json: unknown, onEvent: (e: SseEvent) => void): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const key = getKey()
  if (key) headers['x-anthropic-key'] = key
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(json) })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body.message ?? 'Something went wrong.')
  }
  if (res.status === 204 || !res.body) return
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    const parsed = parseSse(buffer + value)
    buffer = parsed.rest
    for (const e of parsed.events) {
      onEvent(e)
      // The server keeps the response open briefly after `done` while it writes summaries.
      if (e.event === 'done') return void reader.cancel()
    }
  }
}

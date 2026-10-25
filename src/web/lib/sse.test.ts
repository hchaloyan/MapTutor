import { expect, test } from 'vitest'
import { parseSse } from './sse'

test('parseSse handles frames split across chunks', () => {
  const first = parseSse('event: text\ndata: {"delta":"Hi"}\n\nevent: do')
  expect(first).toEqual({ events: [{ event: 'text', data: { delta: 'Hi' } }], rest: 'event: do' })
  const second = parseSse(first.rest + 'ne\ndata: {"awaiting":false}\n\n')
  expect(second).toEqual({ events: [{ event: 'done', data: { awaiting: false } }], rest: '' })
})

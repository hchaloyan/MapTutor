import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { expect, test } from 'vitest'
import { statusOf } from './anthropic'

const start = (content_block: object) => ({ type: 'content_block_start', index: 0, content_block }) as BetaRawMessageStreamEvent

test('statusOf maps thinking and web search block starts', () => {
  expect(statusOf(start({ type: 'thinking', thinking: '', signature: '' }))).toBe('thinking')
  expect(statusOf(start({ type: 'server_tool_use', id: 'st_1', name: 'web_search', input: {} }))).toBe('searching')
  expect(statusOf(start({ type: 'server_tool_use', id: 'st_2', name: 'web_fetch', input: {} }))).toBeNull()
  expect(statusOf(start({ type: 'text', text: '' }))).toBeNull()
  expect(statusOf({ type: 'content_block_stop', index: 0 } as BetaRawMessageStreamEvent)).toBeNull()
})

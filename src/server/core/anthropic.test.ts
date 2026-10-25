import Anthropic from '@anthropic-ai/sdk'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { expect, test } from 'vitest'
import { anthropicError, statusOf } from './anthropic'

const start = (content_block: object) => ({ type: 'content_block_start', index: 0, content_block }) as BetaRawMessageStreamEvent

test('statusOf maps thinking and web search block starts', () => {
  expect(statusOf(start({ type: 'thinking', thinking: '', signature: '' }))).toBe('thinking')
  expect(statusOf(start({ type: 'server_tool_use', id: 'st_1', name: 'web_search', input: {} }))).toBe('searching')
  expect(statusOf(start({ type: 'server_tool_use', id: 'st_2', name: 'web_fetch', input: {} }))).toBeNull()
  expect(statusOf(start({ type: 'text', text: '' }))).toBeNull()
  expect(statusOf({ type: 'content_block_stop', index: 0 } as BetaRawMessageStreamEvent)).toBeNull()
})

test('API errors read as plain words', () => {
  const err = (status: number, type: string, message: string) =>
    Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, message, new Headers())
  expect(anthropicError(err(529, 'overloaded_error', 'Overloaded'))?.message).toBe('Anthropic is overloaded right now. Try again in a moment.')
  expect(anthropicError(err(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit'))?.message).toBe(
    'Anthropic is rate-limiting your key. Wait a minute and try again.',
  )
  expect(anthropicError(err(400, 'invalid_request_error', 'prompt is too long: 1200000 tokens > 1000000 maximum'))?.message).toBe(
    'Anthropic API error: prompt is too long: 1200000 tokens > 1000000 maximum',
  )
  expect(anthropicError(err(401, 'authentication_error', 'invalid x-api-key'))?.message).toBe('Your Anthropic API key was rejected.')
})

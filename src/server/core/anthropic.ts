import Anthropic from '@anthropic-ai/sdk'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { FastifyRequest } from 'fastify'
import { SIDE_MODEL } from './config'
import { httpError } from './http'
import type { Status, StreamMessage } from '../tutor/loop'
import type { OnUsage } from './usage'

/** The user's key from `x-anthropic-key` (BYOK). Never stored, never logged. */
export function apiKey(req: FastifyRequest): string {
  const key = req.headers['x-anthropic-key']
  const value = (Array.isArray(key) ? key[0] : key)?.trim()
  if (!value) throw httpError(401, 'Add your Anthropic API key in settings.')
  return value
}

/** Only the user's key, never a key or profile from the server's environment. */
export const clientFor = (key: string) => new Anthropic({ apiKey: key, authToken: null })

/** Resolves when Anthropic accepts the key; listing models is free. */
export type CheckKey = (key: string) => Promise<void>
export const checkKey: CheckKey = async key => {
  await clientFor(key).models.list({ limit: 1 })
}

const CONVERT_SYSTEM =
  "Convert the HTML the user sends into clean Markdown of the page's main content. Keep headings, lists, tables, code, and math (as LaTeX). Drop navigation, ads, and footers. Reply with the Markdown only."

export async function htmlToMarkdown(html: string, key: string, onUsage?: OnUsage): Promise<string> {
  const message = await clientFor(key)
    .messages.stream({
      model: SIDE_MODEL,
      max_tokens: 64000,
      output_config: { effort: 'low' },
      system: CONVERT_SYSTEM,
      messages: [{ role: 'user', content: html }],
    })
    .finalMessage()
  onUsage?.(message)
  if (message.stop_reason !== 'end_turn') throw httpError(502, `Converting the page failed (${message.stop_reason}).`)
  return message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
}

const SUMMARY_SYSTEM =
  'You summarize one node of a tutoring session. The user sends the node and its lesson transcript. In 2–3 sentences, say what was established in this node and how it connects to what it builds on. Write math in LaTeX ($…$). Reply with the summary only.'

export async function summarize(transcript: string, key: string, onUsage?: OnUsage): Promise<string> {
  const message = await clientFor(key).messages.create({
    model: SIDE_MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low' },
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: transcript }],
  })
  onUsage?.(message)
  if (message.stop_reason !== 'end_turn') throw new Error(`Summarizing a node stopped early (${message.stop_reason}).`)
  return message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
}

/** What the user should see while the tutor works without text: thinking, or searching the web. */
export function statusOf(event: BetaRawMessageStreamEvent): Status | null {
  if (event.type !== 'content_block_start') return null
  const block = event.content_block
  if (block.type === 'thinking') return 'thinking'
  if (block.type === 'server_tool_use' && block.name === 'web_search') return 'searching'
  return null
}

export const streamMessage: StreamMessage = async (params, key, onText, opts = {}) => {
  const stream = clientFor(key).beta.messages.stream(params, { signal: opts.signal }).on('text', onText)
  stream.on('streamEvent', event => {
    const status = statusOf(event)
    if (status) opts.onStatus?.(status)
  })
  try {
    return await stream.finalMessage()
  } catch (err) {
    // A stop after message_start keeps what streamed (and its usage); before it there is nothing to keep.
    if (opts.signal?.aborted && stream.currentMessage) return stream.currentMessage
    throw err
  }
}

/** Maps an Anthropic SDK error to the HTTP error the user should see, or null for anything else. */
export function anthropicError(err: unknown) {
  if (err instanceof Anthropic.AuthenticationError) return httpError(401, 'Your Anthropic API key was rejected.')
  if (err instanceof Anthropic.APIError) return httpError(502, `Anthropic API error: ${err.message}`)
  return null
}

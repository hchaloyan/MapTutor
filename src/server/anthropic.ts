import Anthropic from '@anthropic-ai/sdk'
import type { FastifyRequest } from 'fastify'
import { SIDE_MODEL } from './config'
import { httpError } from './http'

/** The user's key from `x-anthropic-key` (BYOK). Never stored, never logged. */
export function apiKey(req: FastifyRequest): string {
  const key = req.headers['x-anthropic-key']
  const value = (Array.isArray(key) ? key[0] : key)?.trim()
  if (!value) throw httpError(401, 'Add your Anthropic API key in settings.')
  return value
}

/** Only the user's key, never a key or profile from the server's environment. */
export const clientFor = (key: string) => new Anthropic({ apiKey: key, authToken: null })

const CONVERT_SYSTEM =
  "Convert the HTML the user sends into clean Markdown of the page's main content. Keep headings, lists, tables, code, and math (as LaTeX). Drop navigation, ads, and footers. Reply with the Markdown only."

export async function htmlToMarkdown(html: string, key: string): Promise<string> {
  const message = await clientFor(key)
    .messages.stream({
      model: SIDE_MODEL,
      max_tokens: 64000,
      output_config: { effort: 'low' },
      system: CONVERT_SYSTEM,
      messages: [{ role: 'user', content: html }],
    })
    .finalMessage()
  if (message.stop_reason !== 'end_turn') throw httpError(502, `Converting the page failed (${message.stop_reason}).`)
  return message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
}

// Test helper: a scripted model for the simulated engine. Not used by the app.
import type Anthropic from '@anthropic-ai/sdk'
import { type SimModel, simEngine } from './sim'

export type Reply = { content: unknown[]; stop_reason?: string; model?: string; usage?: object }
type Messages = Anthropic.Beta.BetaMessageParam[]
type Step = Reply | ((messages: Messages, opts: Parameters<SimModel>[2] & { onText(d: string): void }) => Reply | Promise<Reply>)

export const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
export const text = (t: string): Reply => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' })
export const toolCall = (name: string, input: unknown, id = 'tu_1'): Reply => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' })

/** Replies come from `script` in order (or from a function of the session's messages); `calls` holds what the model saw. */
export function scripted(script: Step[] | ((messages: Messages) => Reply)) {
  const calls: Messages[] = []
  const model: SimModel = async (messages, onText, opts) => {
    calls.push(structuredClone(messages))
    const next = typeof script === 'function' ? script(messages) : script.shift()
    if (!next) throw new Error('scripted: no reply left')
    const reply = typeof next === 'function' ? await next(messages, { ...opts, onText }) : next
    for (const b of reply.content as { type: string; text?: string }[]) if (b.type === 'text') onText(b.text!)
    return { id: 'msg_s', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: ZERO, ...reply } as Anthropic.Beta.BetaMessage
  }
  return { model, calls, runHop: simEngine(model) }
}

/** The text blocks of a message's content, or of a tool_result's content. */
export const texts = (content: unknown): string[] =>
  typeof content === 'string' ? [content] : (content as { type: string; text?: string }[]).flatMap(b => (b.type === 'text' ? [b.text!] : []))

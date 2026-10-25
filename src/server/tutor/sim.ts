import type Anthropic from '@anthropic-ai/sdk'
import type { Decision, Hop, HopResult, RunHop, Status, Stop, ToolOutcome, UsageRow } from './engine'

/** One model call over the session's messages, as the Messages API would answer it. */
export type SimModel = (
  messages: Anthropic.Beta.BetaMessageParam[],
  onText: (d: string) => void,
  opts: { onStatus(kind: Status): void; signal?: AbortSignal },
) => Promise<Anthropic.Beta.BetaMessage>

type Call = Anthropic.Beta.BetaToolUseBlock

/** The Agent SDK's hop semantics (Spike findings) over a scripted model, for tests and dev:fake. Sessions live in memory. */
export function simEngine(model: SimModel, opts: { maxTurns?: number } = {}): RunHop & { sessions: Map<string, Anthropic.Beta.BetaMessageParam[]> } {
  const maxTurns = opts.maxTurns ?? 20
  const sessions = new Map<string, Anthropic.Beta.BetaMessageParam[]>()
  const deferred = new Map<string, Call>() // per session: the call a resume runs first

  const runHop = async (hop: Hop): Promise<HopResult> => {
    const id = hop.sessionId ?? `sim_${crypto.randomUUID()}`
    const messages = sessions.get(id) ?? []
    sessions.set(id, messages)
    hop.onSession(id)
    const usage: UsageRow[] = []
    const end = (stop: Stop, extra: Partial<HopResult> = {}): HopResult => ({ stop, usage: stop === 'stopped' ? [] : usage, ...extra })
    const settle = (d: Decision, call: Call): ToolOutcome =>
      d.kind === 'deny' ? { content: [d.reason], isError: true } : d.kind === 'answer' ? d.outcome : hop.run(call.name, call.input)
    /** Results go back in one user message; an outcome with `stop` ends the hop (focus_node). */
    const deliver = (results: [Call, ToolOutcome][]) => {
      const content = results.map(([call, o]) => ({
        type: 'tool_result' as const, tool_use_id: call.id, content: o.content.map(text => ({ type: 'text' as const, text })), ...(o.isError && { is_error: true }),
      }))
      messages.push({ role: 'user', content })
      hop.onMessage('user', content)
      return results.some(([, o]) => o.stop)
    }

    const pending = deferred.get(id)
    if (hop.prompt) {
      if (pending) throw new Error('sim: a prompt was sent while a deferred call is unresolved')
      messages.push({ role: 'user', content: hop.prompt })
    } else {
      if (!pending) return end('nothing_deferred')
      deferred.delete(id)
      const d = hop.decide(pending.name, pending.input, pending.id)
      if (d.kind === 'defer') {
        deferred.set(id, pending)
        return end('deferred', { deferred: { id: pending.id, name: pending.name, input: pending.input } })
      }
      if (deliver([[pending, settle(d, pending)]])) return end('switched')
    }

    for (let turn = 0; ; turn++) {
      if (turn >= maxTurns) return end('max_turns')
      if (hop.signal?.aborted) return end('stopped')
      let message: Anthropic.Beta.BetaMessage
      try {
        message = await model(messages, hop.onText, { onStatus: hop.onStatus, signal: hop.signal })
      } catch (err) {
        if (hop.signal?.aborted) return end('stopped')
        throw err
      }
      const u = message.usage
      usage.push({
        model: message.model, inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0, webSearches: u.server_tool_use?.web_search_requests ?? 0,
      })
      messages.push({ role: 'assistant', content: message.content })
      hop.onMessage('assistant', message.content as Anthropic.Beta.BetaContentBlockParam[])
      if (message.stop_reason === 'pause_turn') continue
      if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') return end(message.stop_reason)
      if (message.stop_reason !== 'tool_use') return end('end_turn')
      const calls = message.content.filter((b): b is Call => b.type === 'tool_use')
      if (calls.length === 1) {
        const d = hop.decide(calls[0].name, calls[0].input, calls[0].id)
        if (d.kind === 'defer') {
          deferred.set(id, calls[0])
          return end('deferred', { deferred: { id: calls[0].id, name: calls[0].name, input: calls[0].input } })
        }
        if (deliver([[calls[0], settle(d, calls[0])]])) return end('switched')
      } else {
        // The SDK ignores defer when one message holds several calls: the handler runs.
        const results = calls.map((c): [Call, ToolOutcome] => {
          const d = hop.decide(c.name, c.input, c.id)
          return [c, settle(d.kind === 'defer' ? { kind: 'run' } : d, c)]
        })
        if (deliver(results)) return end('switched')
      }
    }
  }
  return Object.assign(runHop, { sessions })
}

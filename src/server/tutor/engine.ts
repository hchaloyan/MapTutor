import type Anthropic from '@anthropic-ai/sdk'

// The seam between the turn loop and whatever runs the model: the Agent SDK (core/agent.ts) or the simulator (sim.ts).
// A hop is one run of one thread's session, until the model ends its turn, a card defers, or focus_node switches threads.

export type Block = Anthropic.Beta.BetaContentBlockParam
export type Status = 'thinking' | 'searching'
export type ToolOutcome = { content: string[]; isError?: boolean; stop?: boolean }
export type Decision = { kind: 'run' } | { kind: 'deny'; reason: string } | { kind: 'defer' } | { kind: 'answer'; outcome: ToolOutcome }
/** `nothing_deferred`: a resume without a prompt found no deferred call left, so nothing ran. */
export type Stop = 'end_turn' | 'deferred' | 'switched' | 'refusal' | 'max_tokens' | 'max_turns' | 'stopped' | 'nothing_deferred'
export type UsageRow = { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; webSearches: number }

export type Hop = {
  sessionId: string | null // null: start a new session
  prompt: Block[] | null // null: resume to run the deferred call
  decide(name: string, input: unknown, toolUseId: string): Decision
  run(name: string, input: unknown): ToolOutcome
  onSession(id: string): void // before any model output
  onMessage(role: 'user' | 'assistant', content: Block[]): void // bare tool names
  onText(delta: string): void
  onStatus(kind: Status): void
  signal?: AbortSignal
}

export type HopResult = { stop: Stop; deferred?: { id: string; name: string; input: unknown }; usage: UsageRow[] }
export type RunHop = (hop: Hop) => Promise<HopResult>

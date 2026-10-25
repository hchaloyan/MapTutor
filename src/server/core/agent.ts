import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import {
  type ModelUsage,
  type Options,
  type PreToolUseHookInput,
  query,
  type SDKResultMessage,
  type SDKUserMessage,
  type SyncHookJSONOutput,
  USAGE_LIMIT_ERROR_PREFIXES,
} from '@anthropic-ai/claude-agent-sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { Block, Decision, Hop, HopResult, RunHop, Status, ToolOutcome, UsageRow } from '../tutor/engine'
import { systemPrompt } from '../tutor/prompt'
import { TOOLS } from '../tutor/tools'
import { AGENT_DIR, CLAUDE_HOME, MAX_TURNS, SIDE_MODEL, TUTOR_MODEL } from './config'
import { hasDeferredCall, sessionUsage, sqliteSessionStore } from './sessions'

/** Its message is shown to the user as is. */
export class AgentError extends Error {}

/**
 * The subscription token only: an API key or auth token in the environment outranks it and bills per token.
 * Inherited CLAUDE* variables (a server started from a Claude Code terminal) would carry that session's settings.
 */
export function agentEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out = Object.fromEntries(
    Object.entries(env).filter(([k]) => !k.startsWith('ANTHROPIC_') && (!k.startsWith('CLAUDE') || k === 'CLAUDE_CODE_OAUTH_TOKEN')),
  )
  // MCP_CONNECTION_NONBLOCKING: a resumed deferred call runs at startup, so the tutor server must be connected by then.
  return { ...out, CLAUDE_CONFIG_DIR: CLAUDE_HOME, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', MCP_CONNECTION_NONBLOCKING: 'false' }
}

export const bareName = (name: string) => name.replace(/^mcp__tutor__/, '')

/** What the user should see while the tutor works without text: thinking, or searching the web. */
export function statusOf(event: BetaRawMessageStreamEvent): Status | null {
  if (event.type !== 'content_block_start') return null
  const block = event.content_block
  if (block.type === 'thinking') return 'thinking'
  if ((block.type === 'tool_use' && block.name === 'WebSearch') || (block.type === 'server_tool_use' && block.name === 'web_search')) return 'searching'
  return null
}

export function hookOutput(d: Decision): SyncHookJSONOutput {
  const permissionDecision = d.kind === 'run' || d.kind === 'answer' ? 'allow' : d.kind
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...(d.kind === 'deny' && { permissionDecisionReason: d.reason }) },
  }
}

type Totals = Record<string, Partial<ModelUsage>>

/** modelUsage is cumulative per session (Spike S6), so a hop's usage is what it added to the totals before it. */
export function usageRows(modelUsage: Totals, before: Totals = {}): UsageRow[] {
  return Object.entries(modelUsage).flatMap(([model, now]) => {
    const was = before[model] ?? {}
    const d = (k: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens' | 'webSearchRequests') =>
      Math.max(0, (now[k] ?? 0) - (was[k] ?? 0))
    const row = {
      model, inputTokens: d('inputTokens'), outputTokens: d('outputTokens'), cacheReadTokens: d('cacheReadInputTokens'),
      cacheWriteTokens: d('cacheCreationInputTokens'), webSearches: d('webSearchRequests'),
    }
    return row.inputTokens || row.outputTokens || row.cacheReadTokens || row.cacheWriteTokens || row.webSearches ? [row] : []
  })
}

/** Throws the error result as plain words. */
export function hopResult(result: SDKResultMessage, switched: boolean, before: Totals = {}): HopResult {
  const usage = usageRows(result.modelUsage, before)
  if (result.subtype === 'error_max_turns') return { stop: 'max_turns', usage }
  if (result.is_error) throw agentError(result)
  if (switched) return { stop: 'switched', usage }
  const deferred = result.subtype === 'success' && result.stop_reason === 'tool_deferred' ? result.deferred_tool_use : undefined
  if (deferred) return { stop: 'deferred', deferred: { id: deferred.id, name: bareName(deferred.name), input: deferred.input }, usage }
  if (result.stop_reason === 'refusal' || result.stop_reason === 'max_tokens') return { stop: result.stop_reason, usage }
  return { stop: 'end_turn', usage }
}

const SIGNED_OUT = "Claude isn't signed in. Run `claude setup-token`, set CLAUDE_CODE_OAUTH_TOKEN, and restart the server."

export function agentError(source: unknown): AgentError {
  if (source instanceof AgentError) return source
  let text: string
  let status: number | null | undefined
  if (source && typeof source === 'object' && (source as { type?: unknown }).type === 'result') {
    const r = source as SDKResultMessage
    text = (r.subtype === 'success' ? r.result : r.errors[0]) || (r.terminal_reason ?? 'no details')
    status = r.subtype === 'success' ? r.api_error_status : undefined
  } else {
    text = (source instanceof Error ? source.message : String(source)).replace(/^Claude Code returned an error result: /, '')
  }
  if (status === 401 || /not logged in|\/login|authenticat|oauth/i.test(text)) return new AgentError(SIGNED_OUT)
  if (status === 429 || USAGE_LIMIT_ERROR_PREFIXES.some(p => text.startsWith(p))) {
    return new AgentError("You've hit your Claude plan's usage limit. Try again when it resets.")
  }
  if (status === 529 || /overloaded/i.test(text)) return new AgentError('Claude is overloaded right now. Try again in a moment.')
  return new AgentError(`Claude error: ${text}`)
}

/** Isolation from ~/.claude and from the user's typing (`@file`, `/command`); `title` skips the hidden title call. */
const isolated = (): Options => ({
  settingSources: [], cwd: AGENT_DIR, env: agentEnv(), permissionMode: 'dontAsk', strictMcpConfig: true, verbatimPrompts: true, title: 'MapTutor',
})

// The tutor's tools reach Claude Code over HTTP from this server: an in-process SDK server isn't connected yet
// when a deferred call resumes (Spike S4). Each running hop has a random id; its tool calls land here.
const live = new Map<string, (name: string, input: unknown) => ToolOutcome>()

export function mcpRoutes(app: FastifyInstance) {
  app.post('/mcp/:hop', async (req, reply) => {
    const call = live.get((req.params as { hop: string }).hop)
    if (!call) return reply.code(404).send({ error: 'No such hop.' })
    const server = new McpServer({ name: 'tutor', version: '1.0.0' })
    for (const t of TOOLS) {
      server.registerTool(t.def.name, { description: t.def.description, inputSchema: t.def.shape }, async args => {
        const outcome = call(t.def.name, args)
        return { content: outcome.content.map(text => ({ type: 'text' as const, text })), ...(outcome.isError && { isError: true }) }
      })
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    reply.hijack()
    reply.raw.on('close', () => void transport.close().then(() => server.close()))
    await server.connect(transport)
    await transport.handleRequest(req.raw, reply.raw, req.body)
  })
  app.route({ method: ['GET', 'DELETE'], url: '/mcp/:hop', handler: (_req, reply) => reply.code(405).send() })
}

/** Runs each hop as one query() on the thread's session. `mcpBase` is this server's own URL. */
export function agentEngine(db: DatabaseSync, mcpBase: () => string): RunHop {
  const sessionStore = sqliteSessionStore(db)
  return async (hop: Hop) => {
    if (hop.signal?.aborted) return { stop: 'stopped', usage: [] }
    // A resume with no prompt and no deferred call would give Claude Code nothing to do.
    if (!hop.prompt && !(hop.sessionId && hasDeferredCall(db, hop.sessionId))) return { stop: 'nothing_deferred', usage: [] }
    const hopId = crypto.randomUUID()
    const answers = new Map<string, ToolOutcome[]>() // stored card answers, handed to the next call of that tool
    let switched = false
    live.set(hopId, (name, input) => {
      const outcome = answers.get(name)?.shift() ?? hop.run(name, input)
      if (outcome.stop) switched = true
      return outcome
    })

    // The prompt stream stays open until the result: a resumed call's hook answer and interrupt() both need it.
    let release = () => {}
    const held = new Promise<void>(r => (release = r))
    async function* input(): AsyncIterable<SDKUserMessage> {
      if (hop.prompt) yield { type: 'user', message: { role: 'user', content: hop.prompt as never }, parent_tool_use_id: null }
      await held
    }

    const before = hop.sessionId ? sessionUsage(db, hop.sessionId) : {}
    if (hop.sessionId) hop.onSession(hop.sessionId)
    const q = query({
      prompt: input(),
      options: {
        ...isolated(),
        model: TUTOR_MODEL,
        effort: 'high',
        systemPrompt: systemPrompt(),
        tools: ['WebSearch'],
        allowedTools: ['WebSearch', 'mcp__tutor__*'],
        mcpServers: { tutor: { type: 'http', url: `${mcpBase()}/mcp/${hopId}` } },
        maxTurns: MAX_TURNS,
        includePartialMessages: true,
        sessionStore,
        ...(hop.sessionId && { resume: hop.sessionId }),
        hooks: {
          PreToolUse: [{
            matcher: '^mcp__tutor__',
            hooks: [async raw => {
              const { tool_name, tool_input, tool_use_id } = raw as PreToolUseHookInput
              const name = bareName(tool_name)
              const d = hop.decide(name, tool_input, tool_use_id)
              if (d.kind === 'answer') answers.set(name, [...(answers.get(name) ?? []), d.outcome])
              return hookOutput(d)
            }],
          }],
          // focus_node ends the hop after its tool_result; the loop continues in the other thread (Spike S5).
          PostToolUse: [{ matcher: '^mcp__tutor__', hooks: [async () => (switched ? { continue: false } : {})] }],
        },
      },
    })
    const interrupt = () => void q.interrupt().catch(() => {})
    hop.signal?.addEventListener('abort', interrupt, { once: true })

    // One API response arrives as one assistant message per content block (Spike S6); the mirror wants it whole.
    let pending: { id: string; content: Block[] } | null = null
    const flush = () => {
      if (pending) hop.onMessage('assistant', pending.content)
      pending = null
    }
    let result: SDKResultMessage | undefined
    try {
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') {
          if (!hop.sessionId) hop.onSession(m.session_id)
        } else if (m.type === 'stream_event' && !m.parent_tool_use_id) {
          if (m.event.type === 'content_block_delta' && m.event.delta.type === 'text_delta') hop.onText(m.event.delta.text)
          const status = statusOf(m.event)
          if (status) hop.onStatus(status)
        } else if (m.type === 'assistant' && !m.parent_tool_use_id && !m.error) {
          if (pending && pending.id !== m.message.id) flush()
          pending ??= { id: m.message.id, content: [] }
          pending.content.push(...(m.message.content.map(b => (b.type === 'tool_use' ? { ...b, name: bareName(b.name) } : b)) as Block[]))
        } else if (m.type === 'user' && !m.parent_tool_use_id && Array.isArray(m.message.content) && m.message.content.some(b => b.type === 'tool_result')) {
          flush()
          hop.onMessage('user', m.message.content as Block[])
        } else if (m.type === 'result') {
          flush()
          result = m
          release()
        }
      }
    } catch (err) {
      // An error result is followed by a throw (Spike S8); the result says more.
      if (!result && !hop.signal?.aborted) throw agentError(err)
    } finally {
      release()
      live.delete(hopId)
      hop.signal?.removeEventListener('abort', interrupt)
    }
    // ponytail: an interrupted hop records no usage; its tokens fold into the session totals the next hop subtracts
    if (hop.signal?.aborted) return { stop: 'stopped', usage: [] }
    if (!result) throw agentError('Claude Code ended without a result.')
    return hopResult(result, switched, before)
  }
}

/** One model call with no tools and no session, for summaries and page conversion. */
export async function sideCall(opts: { system: string; prompt: string }): Promise<{ text: string; usage: UsageRow[] }> {
  let result: SDKResultMessage | undefined
  try {
    for await (const m of query({
      prompt: opts.prompt,
      options: { ...isolated(), model: SIDE_MODEL, effort: 'low', systemPrompt: opts.system, tools: [], maxTurns: 1, persistSession: false },
    })) {
      if (m.type === 'result') result = m
    }
  } catch (err) {
    if (!result) throw agentError(err)
  }
  if (!result) throw agentError('Claude Code ended without a result.')
  if (result.is_error) throw agentError(result)
  if (result.subtype !== 'success' || result.stop_reason !== 'end_turn') throw new AgentError(`Claude stopped early (${result.stop_reason ?? result.subtype}).`)
  return { text: result.result, usage: usageRows(result.modelUsage) }
}

export const CONVERT_SYSTEM =
  "Convert the HTML the user sends into clean Markdown of the page's main content. Keep headings, lists, tables, code, and math (as LaTeX). Drop navigation, ads, and footers. Reply with the Markdown only."

export const SUMMARY_SYSTEM =
  'You summarize one node of a tutoring session. The user sends the node and its lesson transcript. In 2–3 sentences, say what was established in this node and how it connects to what it builds on. Write math in LaTeX ($…$). Reply with the summary only.'

const side = (system: string) => async (prompt: string, onUsage?: (u: UsageRow) => void) => {
  const { text, usage } = await sideCall({ system, prompt })
  for (const u of usage) onUsage?.(u)
  return text
}
export const summarize = side(SUMMARY_SYSTEM)
export const htmlToMarkdown = side(CONVERT_SYSTEM)

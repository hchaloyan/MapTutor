import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import Fastify from 'fastify'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import type { Hop } from '../tutor/engine'
import { systemPrompt } from '../tutor/prompt'
import { agentEngine, AgentError, agentEnv, agentError, bareName, hookOutput, hopResult, htmlToMarkdown, mcpRoutes, statusOf, summarize, SUMMARY_SYSTEM, usageRows } from './agent'
import { AGENT_DIR, CLAUDE_HOME, MAX_TURNS, SIDE_MODEL, TUTOR_MODEL } from './config'
import { openDb } from './db'

// query() is replaced by a script that plays the CLI: it yields SDK messages and calls the hooks and the MCP route itself.
const sdk = vi.hoisted(() => ({ script: null as null | ((options: any, prompt: AsyncIterable<any>) => AsyncGenerator<any>), options: null as any, interrupt: null as any }))
vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...(await importOriginal<object>()),
  query: ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    sdk.options = options
    sdk.interrupt = vi.fn(async () => undefined)
    return Object.assign(sdk.script!(options, prompt), { interrupt: sdk.interrupt })
  },
}))

const app = Fastify()
let base = ''
beforeAll(async () => {
  mcpRoutes(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterAll(() => app.close())
beforeEach(() => {
  sdk.script = null
})

async function callTool(url: string, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  try {
    return await client.callTool({ name, arguments: args })
  } finally {
    await client.close()
  }
}

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens, outputTokens, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, webSearchRequests: 1, costUSD: 0, contextWindow: 0, maxOutputTokens: 0,
})
const assistant = (id: string, block: object, extra = {}) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, role: 'assistant', content: [block] }, ...extra })
const hookInput = (event: string, toolUseId: string, name: string, input: object) =>
  ({ hook_event_name: event, tool_name: `mcp__tutor__${name}`, tool_input: input, tool_use_id: toolUseId, tool_response: [] }) as any
const signal = new AbortController().signal

function recorder(over: Partial<Hop> = {}) {
  const seen: string[] = []
  const hop: Hop = {
    sessionId: null,
    prompt: [{ type: 'text', text: 'hi' }],
    decide: (name, _input, id) => (seen.push(`decide ${name} ${id}`), { kind: 'run' }),
    run: (name, input) => (seen.push(`run ${name} ${JSON.stringify(input)}`), { content: ['Goal title set.', '<study_state>s</study_state>'], stop: true }),
    onSession: id => seen.push(`session ${id}`),
    onMessage: (role, content) => seen.push(`${role} ${JSON.stringify(content)}`),
    onText: d => seen.push(`text ${d}`),
    onStatus: k => seen.push(`status ${k}`),
    ...over,
  }
  return { hop, seen }
}

test('agentEnv drops API keys so the subscription token is used', () => {
  const env = agentEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDE_EFFORT: 'max', CLAUDECODE: '1', PATH: 'p' })
  expect(Object.keys(env).filter(k => k.startsWith('ANTHROPIC_'))).toEqual([])
  expect(env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'o', PATH: 'p', CLAUDE_CONFIG_DIR: CLAUDE_HOME, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', MCP_CONNECTION_NONBLOCKING: 'false' })
  expect(env.CLAUDE_EFFORT).toBeUndefined()
  expect(env.CLAUDECODE).toBeUndefined()
})

const start = (content_block: object) => ({ type: 'content_block_start', index: 0, content_block }) as BetaRawMessageStreamEvent

test('statusOf maps thinking, WebSearch and web_search block starts', () => {
  expect(statusOf(start({ type: 'thinking', thinking: '', signature: '' }))).toBe('thinking')
  expect(statusOf(start({ type: 'tool_use', id: 't', name: 'WebSearch', input: {} }))).toBe('searching')
  expect(statusOf(start({ type: 'server_tool_use', id: 's', name: 'web_search', input: {} }))).toBe('searching')
  expect(statusOf(start({ type: 'tool_use', id: 't', name: 'mcp__tutor__quiz', input: {} }))).toBeNull()
  expect(statusOf(start({ type: 'text', text: '' }))).toBeNull()
})

test('bareName strips the tutor prefix only', () => {
  expect(bareName('mcp__tutor__quiz')).toBe('quiz')
  expect(bareName('WebSearch')).toBe('WebSearch')
})

test('hook output maps each decision', () => {
  const pre = (permissionDecision: string, reason?: string) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...(reason && { permissionDecisionReason: reason }) },
  })
  expect(hookOutput({ kind: 'run' })).toEqual(pre('allow'))
  expect(hookOutput({ kind: 'answer', outcome: { content: ['x'] } })).toEqual(pre('allow'))
  expect(hookOutput({ kind: 'deny', reason: 'no' })).toEqual(pre('deny', 'no'))
  expect(hookOutput({ kind: 'defer' })).toEqual(pre('defer'))
})

test('usage rows map modelUsage per model, minus what the session had before', () => {
  const now = { 'claude-opus-5-5': { inputTokens: 11, outputTokens: 22, cacheReadInputTokens: 33, cacheCreationInputTokens: 44, webSearchRequests: 5 } } as any
  expect(usageRows(now)).toEqual([{ model: 'claude-opus-5-5', inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, webSearches: 5 }])
  const before = { 'claude-opus-5-5': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, webSearchRequests: 5 } } as any
  expect(usageRows(now, before)).toEqual([{ model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, webSearches: 0 }])
  expect(usageRows(before, before)).toEqual([])
})

const result = (over: object) => ({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', modelUsage: {}, session_id: 's', ...over }) as any

test('hopResult maps each ending', () => {
  expect(hopResult(result({ stop_reason: 'tool_deferred', deferred_tool_use: { id: 't1', name: 'mcp__tutor__quiz', input: { a: 1 } } }), false)).toEqual({
    stop: 'deferred', deferred: { id: 't1', name: 'quiz', input: { a: 1 } }, usage: [],
  })
  expect(hopResult(result({ stop_reason: 'tool_use', terminal_reason: 'hook_stopped' }), true).stop).toBe('switched')
  expect(hopResult(result({ subtype: 'error_max_turns', is_error: true, stop_reason: null, errors: [] }), false).stop).toBe('max_turns')
  for (const stop of ['refusal', 'max_tokens', 'end_turn'] as const) expect(hopResult(result({ stop_reason: stop }), false).stop).toBe(stop)
  expect(() => hopResult(result({ is_error: true, api_error_status: 529, result: 'Overloaded' }), false)).toThrow(AgentError)
})

test('error results read as plain words', () => {
  const signedOut = "Claude isn't signed in. Run `claude setup-token`, set CLAUDE_CODE_OAUTH_TOKEN, and restart the server."
  expect(agentError(result({ is_error: true, api_error_status: 401, result: 'Invalid API key · Please run /login' })).message).toBe(signedOut)
  expect(agentError(result({ is_error: true, api_error_status: null, result: 'Not logged in · Please run /login' })).message).toBe(signedOut)
  const limit = "You've hit your Claude plan's usage limit. Try again when it resets."
  expect(agentError(result({ is_error: true, api_error_status: 429, result: 'Rate limited' })).message).toBe(limit)
  expect(agentError(result({ is_error: true, api_error_status: null, result: "You've hit your limit · resets 5pm" })).message).toBe(limit)
  const busy = 'Claude is overloaded right now. Try again in a moment.'
  expect(agentError(result({ is_error: true, api_error_status: 529, result: 'x' })).message).toBe(busy)
  expect(agentError(new Error('Claude Code returned an error result: API Error: Overloaded')).message).toBe(busy)
  expect(agentError(result({ subtype: 'error_during_execution', is_error: true, stop_reason: null, errors: ['prompt is too long', 'more'] })).message).toBe(
    'Claude error: prompt is too long',
  )
  expect(agentError(new Error('Claude Code process exited with code 1')).message).toBe('Claude error: Claude Code process exited with code 1')
})

test('agentEngine maps a scripted SDK stream onto hop callbacks', async () => {
  const db = openDb(':memory:')
  const { hop, seen } = recorder()
  let url = ''
  let promptDone: boolean | undefined
  sdk.script = async function* (options, prompt) {
    url = options.mcpServers.tutor.url
    const input = prompt[Symbol.asyncIterator]()
    seen.push(`prompt ${JSON.stringify((await input.next()).value.message.content)}`)
    yield { type: 'system', subtype: 'init', session_id: 'sess-1' }
    yield { type: 'stream_event', event: start({ type: 'thinking', thinking: '', signature: '' }) }
    yield { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } } }
    yield assistant('m1', { type: 'text', text: 'Hello' })
    yield assistant('m1', { type: 'tool_use', id: 't1', name: 'mcp__tutor__set_goal_title', input: { title: 'Limits' } })
    const args = { title: 'Limits' }
    seen.push(`pre ${JSON.stringify(await options.hooks.PreToolUse[0].hooks[0](hookInput('PreToolUse', 't1', 'set_goal_title', args), 't1', { signal }))}`)
    const res = await callTool(url, 'set_goal_title', args)
    seen.push(`tool ${JSON.stringify(res.content)}`)
    seen.push(`post ${JSON.stringify(await options.hooks.PostToolUse[0].hooks[0](hookInput('PostToolUse', 't1', 'set_goal_title', args), 't1', { signal }))}`)
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: res.content }] } }
    yield result({ stop_reason: 'tool_use', terminal_reason: 'hook_stopped', modelUsage: { 'claude-opus-5-5': usage(5, 6) } })
    promptDone = (await input.next()).done
  }
  const out = await agentEngine(db, () => base)(hop)

  expect(out).toEqual({ stop: 'switched', usage: [{ model: 'claude-opus-5-5', inputTokens: 5, outputTokens: 6, cacheReadTokens: 3, cacheWriteTokens: 4, webSearches: 1 }] })
  expect(seen).toEqual([
    'prompt [{"type":"text","text":"hi"}]',
    'session sess-1',
    'status thinking',
    'text Hello',
    'decide set_goal_title t1',
    `pre ${JSON.stringify(hookOutput({ kind: 'run' }))}`,
    'run set_goal_title {"title":"Limits"}',
    'tool [{"type":"text","text":"Goal title set."},{"type":"text","text":"<study_state>s</study_state>"}]',
    'post {"continue":false}',
    'assistant [{"type":"text","text":"Hello"},{"type":"tool_use","id":"t1","name":"set_goal_title","input":{"title":"Limits"}}]',
    'user [{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"Goal title set."},{"type":"text","text":"<study_state>s</study_state>"}]}]',
  ])
  expect(promptDone).toBe(true) // the prompt stream stayed open until the result, then ended
  const o = sdk.options
  expect(o.resume).toBeUndefined()
  expect(o).toMatchObject({
    model: TUTOR_MODEL, systemPrompt: systemPrompt(), settingSources: [], cwd: AGENT_DIR, tools: ['WebSearch', 'Read'],
    allowedTools: ['WebSearch', 'Read', 'mcp__tutor__*'], permissionMode: 'dontAsk', strictMcpConfig: true, verbatimPrompts: true,
    effort: 'high', maxTurns: MAX_TURNS, includePartialMessages: true,
  })
  expect(o.sessionStore).toBeDefined()
  expect(o.env.MCP_CONNECTION_NONBLOCKING).toBe('false')
  expect(o.hooks.PreToolUse[0].matcher).toBe('^mcp__tutor__')
  // Read goes through the loop's decide too, which limits it to the project's files.
  expect(o.hooks.PreToolUse[1].matcher).toBe('^Read$')
  const read = await o.hooks.PreToolUse[1].hooks[0]({ tool_name: 'Read', tool_input: { file_path: 'x' }, tool_use_id: 'r1' })
  expect(read.hookSpecificOutput.permissionDecision).toBe('allow')
  expect(seen.at(-1)).toBe('decide Read r1')
  expect(o.mcpServers.tutor.type).toBe('http')
  expect(url.startsWith(`${base}/mcp/`)).toBe(true)
  expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404) // the hop is gone
})

test('a resumed hop answers the deferred call with no prompt and records only its own usage', async () => {
  const db = openDb(':memory:')
  const entry = db.prepare("INSERT INTO agent_entries (session_id, entry) VALUES ('sess-1', ?)")
  entry.run(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__tutor__ask_user_question', input: {} }] } }))
  entry.run(JSON.stringify({ type: 'cost-state', modelUsage: { 'claude-opus-5-5': usage(10, 5) } }))
  const { hop, seen } = recorder({
    sessionId: 'sess-1',
    prompt: null,
    decide: () => ({ kind: 'answer', outcome: { content: ['{"answers":["A"]}', '<study_state>s</study_state>'] } }),
    run: () => {
      throw new Error('a stored answer must not run the tool')
    },
  })
  let first: IteratorResult<any> | undefined
  sdk.script = async function* (options, prompt) {
    const input = prompt[Symbol.asyncIterator]()
    const next = input.next().then(r => (first = r))
    const args = { question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }
    seen.push(`pre ${JSON.stringify(await options.hooks.PreToolUse[0].hooks[0](hookInput('PreToolUse', 't1', 'ask_user_question', args), 't1', { signal }))}`)
    const res = await callTool(options.mcpServers.tutor.url, 'ask_user_question', args)
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: res.content }] } }
    yield { type: 'system', subtype: 'init', session_id: 'sess-1' }
    yield assistant('m2', { type: 'text', text: 'Thanks.' })
    yield result({ modelUsage: { 'claude-opus-5-5': usage(25, 9) } })
    await next
  }
  const out = await agentEngine(db, () => base)(hop)

  expect(sdk.options.resume).toBe('sess-1')
  expect(first?.done).toBe(true) // no prompt was sent
  expect(seen[0]).toBe('session sess-1')
  expect(seen).toContain('user [{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"{\\"answers\\":[\\"A\\"]}"},{"type":"text","text":"<study_state>s</study_state>"}]}]')
  expect(out).toEqual({ stop: 'end_turn', usage: [{ model: 'claude-opus-5-5', inputTokens: 15, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 }] })
})

test('Stop interrupts the hop, which ends stopped with no usage', async () => {
  const ac = new AbortController()
  const { hop } = recorder({ signal: ac.signal })
  sdk.script = async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sess-1' }
    ac.abort()
    yield assistant('m1', { type: 'text', text: 'Partial' })
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }
    yield result({ subtype: 'error_during_execution', is_error: true, stop_reason: null, terminal_reason: 'aborted_streaming', errors: [], modelUsage: { m: usage(1, 1) } })
  }
  expect(await agentEngine(openDb(':memory:'), () => base)(hop)).toEqual({ stop: 'stopped', usage: [] })
  expect(sdk.interrupt).toHaveBeenCalled()
})

test('an error result fails the hop with plain words and is not mirrored', async () => {
  const { hop, seen } = recorder()
  sdk.script = async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sess-1' }
    yield assistant('e1', { type: 'text', text: "You've hit your limit · resets 5pm" }, { error: 'rate_limit' })
    yield result({ is_error: true, api_error_status: 429, result: "You've hit your limit · resets 5pm" })
    throw new Error("Claude Code returned an error result: You've hit your limit · resets 5pm")
  }
  await expect(agentEngine(openDb(':memory:'), () => base)(hop)).rejects.toThrow("You've hit your Claude plan's usage limit. Try again when it resets.")
  expect(seen.some(s => s.startsWith('assistant'))).toBe(false)
})

test('side calls run the side model with no tools and no session', async () => {
  sdk.script = async function* () {
    yield result({ result: 'A summary.', modelUsage: { 'claude-haiku-5-5': usage(7, 8) } })
  }
  const rows: unknown[] = []
  expect(await summarize('transcript', u => rows.push(u))).toBe('A summary.')
  expect(rows).toEqual([{ model: 'claude-haiku-5-5', inputTokens: 7, outputTokens: 8, cacheReadTokens: 3, cacheWriteTokens: 4, webSearches: 1 }])
  expect(sdk.options).toMatchObject({ model: SIDE_MODEL, effort: 'low', tools: [], maxTurns: 1, persistSession: false, systemPrompt: SUMMARY_SYSTEM, settingSources: [] })
  expect(sdk.options.sessionStore).toBeUndefined()
  sdk.script = async function* () {
    yield result({ stop_reason: 'max_tokens', result: 'cut' })
  }
  await expect(htmlToMarkdown('<p>x</p>')).rejects.toThrow('Claude stopped early (max_tokens).')
})

test('a resume with nothing deferred starts no query', async () => {
  // e.g. Retry after the answer reached the session and the model call then failed
  const db = openDb(':memory:')
  db.prepare("INSERT INTO agent_entries (session_id, entry) VALUES ('sess-1', ?)").run(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }))
  sdk.options = null
  const { hop } = recorder({ sessionId: 'sess-1', prompt: null })
  expect(await agentEngine(db, () => base)(hop)).toEqual({ stop: 'nothing_deferred', usage: [] })
  expect(sdk.options).toBeNull()
})

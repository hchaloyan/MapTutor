import type Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'vitest'
import { LOCAL_USER_ID, openDb } from '../core/db'
import type { Block } from './engine'
import { appendUserMessage, clearPending, MAX_STEPS, pendingCard, retryPrompt, runTurn } from './loop'
import { scripted, text, texts, toolCall, ZERO } from './scripted'

const QUESTION = { question: 'What is the goal?', options: [{ label: 'Pass the midterm' }, { label: 'Understand it deeply' }] }
type Content = { type: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]

function setup(script: Parameters<typeof scripted>[0], phase = 'probe') {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', ?, 'Calc', 0)").run(LOCAL_USER_ID)
  db.prepare("INSERT INTO studies (id, project_id, goal, phase, created_at) VALUES ('s1', 'p1', 'midterm', ?, 0)").run(phase)
  for (const id of ['n1', 'n2']) {
    db.prepare("INSERT INTO nodes (id, study_id, label, kind, description, state, updated_at) VALUES (?, 's1', ?, 'root', 'd', 'untested', 0)").run(id, id.toUpperCase())
  }
  const s = scripted(script)
  const events: [string, Record<string, unknown>][] = []
  const run = (prompt: Block[] | null = [{ type: 'text', text: 'hello' }], opts: { nodeId?: string; signal?: AbortSignal } = {}) =>
    runTurn({ db, studyId: 's1', nodeId: opts.nodeId ?? null, prompt, runHop: s.runHop, signal: opts.signal, emit: (e, d) => events.push([e, d as Record<string, unknown>]) })
  const rows = (nodeId: string | null = null) =>
    (db.prepare('SELECT role, content, pending FROM messages WHERE node_id IS ? ORDER BY created_at, rowid').all(nodeId) as { role: string; content: string; pending: number }[]).map(r => ({
      ...r,
      content: JSON.parse(r.content) as Content,
    }))
  const session = (nodeId: string | null = null) =>
    (nodeId
      ? db.prepare("SELECT session_id AS id FROM nodes WHERE study_id = 's1' AND id = ?").get(nodeId)
      : db.prepare("SELECT session_id AS id FROM studies WHERE id = 's1'").get()) as { id: string | null }
  const history = (nodeId: string | null = null) => s.runHop.sessions.get(session(nodeId).id!)!
  return { db, calls: s.calls, events, run, rows, session, history }
}

const resultOf = (m: Anthropic.Beta.BetaMessageParam | undefined) => (m?.content as Content).find(b => b.type === 'tool_result')!

test('streams text and stores the assistant reply', async () => {
  const t = setup([text('Hi')])
  await t.run()
  expect(t.events).toEqual([['text', { delta: 'Hi' }], ['done', { awaiting: false }]])
  expect(t.rows().map(r => r.role)).toEqual(['user', 'assistant'])
})

test('history is append-only across turns', async () => {
  const t = setup([text('first'), text('second')])
  await t.run([{ type: 'text', text: 'one' }])
  await t.run([{ type: 'text', text: 'two' }])
  const [a, b] = t.calls
  expect(b.slice(0, a.length)).toEqual(a)
  expect(b).toHaveLength(a.length + 2)
})

test("a new thread's first prompt carries the files, the text and study_state; later prompts carry no files", async () => {
  const t = setup([text('first'), text('second')])
  t.db.prepare("INSERT INTO files (id, project_id, kind, name, data, created_at) VALUES ('f1', 'p1', 'pdf', 'slides.pdf', ?, 0)").run(Buffer.from('%PDF'))
  await t.run([{ type: 'text', text: 'one' }])
  await t.run([{ type: 'text', text: 'two' }])
  const types = (m: Anthropic.Beta.BetaMessageParam) => (m.content as Content).map(b => b.type)
  expect(types(t.calls[0][0])).toEqual(['document', 'text', 'text'])
  expect(types(t.calls[1].at(-1)!)).toEqual(['text', 'text'])
  expect(t.session().id).toMatch(/^sim_/)
  // The mirror keeps the prompt without the file blocks.
  expect(t.rows()[0].content.map(b => b.type)).toEqual(['text', 'text'])
})

test('a valid ask_user_question defers into a pending card', async () => {
  const t = setup([toolCall('ask_user_question', QUESTION)])
  await t.run()
  expect(t.calls).toHaveLength(1)
  expect(t.events).toEqual([
    ['card', { toolUseId: 'tu_1', name: 'ask_user_question', input: QUESTION }],
    ['done', { awaiting: true }],
  ])
  expect(t.rows().at(-1)?.pending).toBe(1)
  expect(pendingCard(t.db, 's1', null)?.toolUse.id).toBe('tu_1')
})

test('a malformed card call is denied with the check error', async () => {
  const t = setup([toolCall('ask_user_question', { question: 'Goal?', options: [{ label: 'Only one' }] }), text('ok')])
  await t.run()
  const result = resultOf(t.calls[1].at(-1))
  expect(result).toMatchObject({ is_error: true })
  expect(texts(result.content)).toEqual(['ask_user_question needs a question and 2–4 options, each with a non-empty, distinct label.'])
  expect(t.events.some(([e]) => e === 'card')).toBe(false)
  expect(pendingCard(t.db, 's1', null)).toBeNull()
})

test('a tool outside the phase is denied', async () => {
  const t = setup([toolCall('focus_node', { nodeId: 'n1' }), text('ok')])
  await t.run()
  expect(texts(resultOf(t.calls[1].at(-1)).content)).toEqual(["`focus_node` isn't available in the probe phase."])
  expect(t.events.some(([e]) => e === 'focus')).toBe(false)
})

test('an unknown tool becomes an error tool_result', async () => {
  const t = setup([toolCall('teleport', {}), text('ok')])
  await t.run()
  expect(resultOf(t.calls[1].at(-1))).toMatchObject({ is_error: true, content: [{ type: 'text', text: 'Unknown tool `teleport`.' }] })
  expect(t.events.at(-1)).toEqual(['done', { awaiting: false }])
})

test('server tool results end with study_state', async () => {
  const t = setup([toolCall('set_goal_title', { title: 'Ace the midterm' }), text('ok')])
  await t.run()
  const [first, last] = [texts(resultOf(t.calls[1].at(-1)).content)[0], texts(resultOf(t.calls[1].at(-1)).content).at(-1)!]
  expect(first).toBe('Goal title set to "Ace the midterm".')
  expect(last.startsWith('<study_state>')).toBe(true)
  // The mirror holds the tool_result row the engine reported.
  expect(t.rows().map(r => r.content[0].type)).toEqual(['text', 'tool_use', 'tool_result', 'text'])
})

test('answering resumes with no prompt and the stored answer', async () => {
  const t = setup([toolCall('ask_user_question', QUESTION), text('Great.')])
  await t.run()
  const card = pendingCard(t.db, 's1', null)!
  clearPending(t.db, card.messageId)
  appendUserMessage(t.db, 's1', null, [{ type: 'tool_result', tool_use_id: 'tu_1', content: JSON.stringify({ answers: ['Pass the midterm'] }) }])
  await t.run(null)
  expect(texts(resultOf(t.calls[1].at(-1)).content)[0]).toBe('{"answers":["Pass the midterm"]}')
  expect(t.rows().filter(r => r.content.some(b => b.type === 'tool_result'))).toHaveLength(1)
  expect(t.events.at(-1)).toEqual(['done', { awaiting: false }])
})

test('a stored answer reaches the session even when the answer changed the phase', async () => {
  // Approving the plan moves the study to teach, where propose_graph is no longer allowed.
  const graph = {
    approach: 'A then G.',
    nodes: [
      { id: 'a', label: 'A', kind: 'root', description: 'd', strands: ['limits'] },
      { id: 'g', label: 'G', kind: 'goal', description: 'd', strands: [] },
    ],
    edges: [{ from: 'a', to: 'g' }],
  }
  const t = setup([toolCall('propose_graph', graph), text('Great.')])
  t.db.prepare(
    "INSERT INTO quiz_items (id, study_id, quiz_call_id, phase, strand, prompt, options, correct_option_id, explanation, chosen_option_id, answered_at) VALUES ('q', 's1', 'c', 'probe', 'limits', 'p', '[]', 'a', 'e', 'a', 0)",
  ).run()
  await t.run()
  expect(t.events.at(-1)).toEqual(['done', { awaiting: true }])
  clearPending(t.db, pendingCard(t.db, 's1', null)!.messageId)
  t.db.prepare("UPDATE studies SET phase = 'teach' WHERE id = 's1'").run()
  appendUserMessage(t.db, 's1', null, [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"decision":"approved"}' }])
  await t.run(null)
  expect(resultOf(t.calls[1].at(-1))).not.toHaveProperty('is_error')
  expect(texts(resultOf(t.calls[1].at(-1)).content)[0]).toBe('{"decision":"approved"}')
})

test('a card call batched with another tool is refused, not run', async () => {
  const t = setup([
    { content: [{ type: 'tool_use', id: 'tu_a', name: 'ask_user_question', input: QUESTION }, { type: 'tool_use', id: 'tu_t', name: 'set_goal_title', input: { title: 'T' } }], stop_reason: 'tool_use' },
    text('ok'),
  ])
  await t.run()
  const results = (t.calls[1].at(-1)!.content as Content).filter(b => b.type === 'tool_result')
  expect(results[0]).toMatchObject({ tool_use_id: 'tu_a', is_error: true })
  expect(texts(results[0].content)[0]).toBe('Call `ask_user_question` on its own, with no other tool call in the same message.')
  expect(texts(results[1].content)[0]).toBe('Goal title set to "T".')
  expect(t.rows().some(r => r.pending)).toBe(false)
  expect(t.events.some(([e]) => e === 'card')).toBe(false)
})

test("focus_node ends the hop and continues in the node's thread", async () => {
  const t = setup([toolCall('focus_node', { nodeId: 'n1' }), text('Lesson.')], 'teach')
  await t.run()
  expect(t.events).toEqual([['focus', { nodeId: 'n1' }], ['text', { delta: 'Lesson.' }], ['done', { awaiting: false }]])
  expect(t.history().at(-1)!.content).toEqual([expect.objectContaining({ type: 'tool_result', tool_use_id: 'tu_1' })])
  expect(texts(t.history('n1')[0].content)[0]).toBe('[App: focus_node opened this thread. Continue the lesson for "N1" here.]')
  expect(t.session('n1').id).toMatch(/^sim_/)
  expect(t.rows('n1').map(r => r.role)).toEqual(['user', 'assistant'])
})

test('max_tokens and max_turns end the turn with an error', async () => {
  const cut = setup([{ content: [{ type: 'text', text: 'Long' }], stop_reason: 'max_tokens' }])
  await cut.run()
  expect(cut.events.slice(-2)).toEqual([['error', { message: 'The reply was too long and got cut off.' }], ['done', { awaiting: false }]])
  let n = 0
  const busy = setup(() => toolCall('set_goal_title', { title: 'T' }, `tu_${n++}`))
  await busy.run()
  expect(busy.calls).toHaveLength(20)
  expect(busy.events.slice(-2)).toEqual([['error', { message: 'The tutor took too many steps. Send a message to continue.' }], ['done', { awaiting: false }]])
})

test('hops stop after MAX_STEPS', async () => {
  let n = 0
  const t = setup(() => toolCall('focus_node', { nodeId: n % 2 ? 'n1' : 'n2' }, `tu_${n++}`), 'teach')
  await t.run()
  expect(t.events.filter(([e]) => e === 'focus')).toHaveLength(MAX_STEPS)
  expect(t.events.slice(-2)).toEqual([['error', { message: 'The tutor took too many steps. Send a message to continue.' }], ['done', { awaiting: false }]])
})

test("each hop's usage is recorded", async () => {
  const usage = (input: number) => ({ ...ZERO, input_tokens: input, output_tokens: 1, server_tool_use: { web_search_requests: 1 } })
  const t = setup([{ ...toolCall('focus_node', { nodeId: 'n1' }), usage: usage(10) }, { ...text('Lesson.'), usage: usage(20) }], 'teach')
  await t.run()
  expect(t.db.prepare('SELECT study_id, model, input_tokens, output_tokens, web_searches FROM usage ORDER BY id').all()).toEqual([
    { study_id: 's1', model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 1, web_searches: 1 },
    { study_id: 's1', model: 'claude-opus-5-5', input_tokens: 20, output_tokens: 1, web_searches: 1 },
  ])
})

test('retryPrompt resumes a stored answer and otherwise sends the app note', async () => {
  const t = setup([toolCall('ask_user_question', QUESTION), text('ok')])
  const note = [{ type: 'text', text: '[App: Your last reply did not arrive. Reply to the thread as it stands.]' }]
  await t.run()
  clearPending(t.db, pendingCard(t.db, 's1', null)!.messageId)
  appendUserMessage(t.db, 's1', null, [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"answers":["A"]}' }])
  expect(retryPrompt(t.db, 's1', null)).toBeNull()
  appendUserMessage(t.db, 's1', null, [{ type: 'text', text: 'hello?' }])
  expect(retryPrompt(t.db, 's1', null)).toEqual(note)
})

test('a resume with nothing deferred sends the app note instead', async () => {
  // The answer reached the session, then the model call failed: Retry finds no deferred call left.
  let fail = true
  const t = setup([toolCall('ask_user_question', QUESTION), () => {
    if (fail) throw new Error('usage limit')
    return text('unused')
  }, text('Back.')])
  await t.run()
  clearPending(t.db, pendingCard(t.db, 's1', null)!.messageId)
  appendUserMessage(t.db, 's1', null, [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"answers":["A"]}' }])
  await expect(t.run(null)).rejects.toThrow('usage limit')
  fail = false
  t.calls.length = 0
  await t.run(retryPrompt(t.db, 's1', null))
  const last = t.calls[0].at(-1)!
  expect(texts(last.content)[0]).toBe('[App: Your last reply did not arrive. Reply to the thread as it stands.]')
  expect(t.events.at(-1)).toEqual(['done', { awaiting: false }])
})

test('pause_turn continues the turn', async () => {
  const t = setup([{ content: [{ type: 'text', text: 'searching' }], stop_reason: 'pause_turn' }, text('found it')])
  await t.run()
  expect(t.calls).toHaveLength(2)
  expect(t.events.filter(([e]) => e === 'done')).toEqual([['done', { awaiting: false }]])
})

test('refusal ends the turn with an error', async () => {
  const t = setup([{ content: [], stop_reason: 'refusal' }])
  await t.run()
  expect(t.events).toEqual([['error', { message: 'The tutor declined to answer that. Try rephrasing.' }], ['done', { awaiting: false }]])
})

test('every user message the server sends ends with study_state', async () => {
  const t = setup([toolCall('teleport', {}), text('ok')])
  await t.run()
  for (const m of t.history().filter(m => m.role === 'user')) {
    const blocks = m.content as Content
    const last = blocks[0].type === 'tool_result' ? texts(blocks[0].content).at(-1) : blocks.at(-1)?.text
    if (blocks[0].type === 'tool_result' && blocks[0].is_error) continue // the CLI words a denied call itself
    expect(String(last)).toMatch(/^<study_state>\n[\s\S]*Tools allowed now: ask_user_question, quiz, propose_graph, set_goal_title, WebSearch\n[\s\S]*<\/study_state>$/)
  }
})

test('status events from the stream reach the client', async () => {
  const t = setup([
    async (_m, opts) => {
      opts.onStatus('thinking')
      opts.onStatus('searching')
      return text('Hi')
    },
  ])
  await t.run()
  expect(t.events).toEqual([
    ['status', { kind: 'thinking' }],
    ['status', { kind: 'searching' }],
    ['text', { delta: 'Hi' }],
    ['done', { awaiting: false }],
  ])
})

const controller = () => new AbortController()

test('a stop mid-stream keeps the streamed text and ends with one done', async () => {
  const c = controller()
  const t = setup([
    async (_m, opts) => {
      opts.onText('Partial ')
      opts.onText('answer')
      c.abort()
      expect(opts.signal?.aborted).toBe(true)
      throw new Error('Request was aborted.')
    },
  ])
  await t.run(undefined, { signal: c.signal })
  expect(t.events).toEqual([['text', { delta: 'Partial ' }], ['text', { delta: 'answer' }], ['done', { awaiting: false }]])
  expect(t.rows().map(r => [r.role, r.content.map(b => b.text ?? b.type), r.pending])).toEqual([
    ['user', ['hello', expect.stringMatching(/^<study_state>/)], 0],
    ['assistant', ['Partial answer'], 0],
  ])
  expect(t.db.prepare('SELECT count(*) AS n FROM usage').get()).toEqual({ n: 0 }) // an aborted hop records no usage
})

test('a stop before any text stores nothing and the next message still works', async () => {
  const c = controller()
  const t = setup([
    async () => {
      c.abort()
      throw new Error('Request was aborted.')
    },
    text('Back.'),
  ])
  await t.run([{ type: 'text', text: 'one' }], { signal: c.signal })
  expect(t.events).toEqual([['done', { awaiting: false }]])
  expect(t.rows().map(r => r.role)).toEqual(['user'])
  await t.run([{ type: 'text', text: 'two' }])
  expect(t.rows().map(r => r.role)).toEqual(['user', 'user', 'assistant'])
  expect(t.calls[1].map(m => m.role)).toEqual(['user', 'user'])
})

test('a stop between steps makes no further model call', async () => {
  const c = controller()
  const t = setup([
    async () => {
      // The stream finished just as the user pressed Stop: the tool runs, nothing after it does.
      c.abort()
      return toolCall('set_goal_title', { title: 'Ace the midterm' })
    },
    text('never'),
  ])
  await t.run(undefined, { signal: c.signal })
  expect(t.calls).toHaveLength(1)
  expect(t.events.filter(([e]) => e === 'done')).toEqual([['done', { awaiting: false }]])
  expect(t.db.prepare('SELECT title FROM studies').get()).toEqual({ title: 'Ace the midterm' })
  expect(t.rows().at(-1)!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' })
})


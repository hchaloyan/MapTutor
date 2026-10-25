import type Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'vitest'
import type { MessageStreamParams } from './context'
import { LOCAL_USER_ID, openDb } from './db'
import { appendUserMessage, MAX_STEPS, pendingCard, runTurn, type StreamMessage } from './tutor'

type Reply = Omit<Partial<Anthropic.Beta.BetaMessage>, 'content'> & { content: unknown[] }

const text = (t: string): Reply => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' })
const toolCall = (name: string, input: unknown, id = 'tu_1'): Reply => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' })
const QUESTION = { question: 'What is the goal?', options: [{ label: 'Pass the midterm' }, { label: 'Understand it deeply' }] }

function setup(script: Reply[] | (() => Reply)) {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', ?, 'Calc', 0)").run(LOCAL_USER_ID)
  db.prepare("INSERT INTO studies (id, project_id, goal, phase, created_at) VALUES ('s1', 'p1', 'midterm', 'probe', 0)").run()
  const calls: MessageStreamParams[] = []
  const events: [string, Record<string, unknown>][] = []
  const streamMessage: StreamMessage = async (params, _key, onText) => {
    calls.push(structuredClone(params))
    const reply = typeof script === 'function' ? script() : script.shift()!
    for (const b of reply.content as { type: string; text?: string }[]) if (b.type === 'text') onText(b.text!)
    return { stop_reason: 'end_turn', ...reply } as Anthropic.Beta.BetaMessage
  }
  const run = () => runTurn({ db, studyId: 's1', nodeId: null, apiKey: 'sk-test', streamMessage, emit: (e, d) => events.push([e, d as Record<string, unknown>]) })
  const say = (t: string) => appendUserMessage(db, 's1', null, [{ type: 'text', text: t }])
  const rows = () =>
    (db.prepare('SELECT role, content, pending FROM messages ORDER BY created_at, rowid').all() as { role: string; content: string; pending: number }[]).map(r => ({
      ...r,
      content: JSON.parse(r.content) as Record<string, unknown>[],
    }))
  return { db, calls, events, run, say, rows }
}

const noCache = <T>(value: T): T => JSON.parse(JSON.stringify(value, (k, v) => (k === 'cache_control' ? undefined : v)))

test('streams text and stores the assistant reply', async () => {
  const t = setup([text('Hi')])
  t.say('hello')
  await t.run()
  expect(t.events).toEqual([['text', { delta: 'Hi' }], ['done', { awaiting: false }]])
  expect(t.rows().map(r => r.role)).toEqual(['user', 'assistant'])
})

test('history is append-only across turns', async () => {
  const t = setup([text('first'), text('second')])
  t.say('one')
  await t.run()
  t.say('two')
  await t.run()
  const [a, b] = t.calls.map(noCache)
  expect(b.system).toEqual(a.system)
  expect(b.tools).toEqual(a.tools)
  expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages)
  expect(b.messages).toHaveLength(a.messages.length + 2)
})

test('a valid ask_user_question pauses with a card', async () => {
  const t = setup([toolCall('ask_user_question', QUESTION)])
  t.say('help me study')
  await t.run()
  expect(t.calls).toHaveLength(1)
  expect(t.events).toEqual([
    ['card', { toolUseId: 'tu_1', name: 'ask_user_question', input: QUESTION }],
    ['done', { awaiting: true }],
  ])
  expect(t.rows().at(-1)?.pending).toBe(1)
  expect(pendingCard(t.db, 's1', null)?.toolUse.id).toBe('tu_1')
})

test('a malformed ask_user_question is returned as an error', async () => {
  const t = setup([toolCall('ask_user_question', { question: 'Goal?', options: [{ label: 'Only one' }] }), text('ok')])
  t.say('help')
  await t.run()
  expect(t.calls).toHaveLength(2)
  const result = t.rows()[2].content[0]
  expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1', is_error: true })
  expect(result.content).toBe('ask_user_question needs a question and 2–4 options, each with a non-empty, distinct label.')
  expect(pendingCard(t.db, 's1', null)).toBeNull()
})

test('an unknown tool becomes an error tool_result', async () => {
  const t = setup([toolCall('teleport', {}), text('ok')])
  t.say('help')
  await t.run()
  expect(t.rows()[2].content[0]).toMatchObject({ type: 'tool_result', is_error: true, content: 'Unknown tool `teleport`.' })
  expect(t.events.at(-1)).toEqual(['done', { awaiting: false }])
})

test('pause_turn continues the turn', async () => {
  const t = setup([{ content: [{ type: 'text', text: 'searching' }], stop_reason: 'pause_turn' }, text('found it')])
  t.say('check this')
  await t.run()
  expect(t.calls).toHaveLength(2)
  expect(t.events.filter(([e]) => e === 'done')).toEqual([['done', { awaiting: false }]])
})

test('refusal ends the turn with an error', async () => {
  const t = setup([{ content: [], stop_reason: 'refusal' }])
  t.say('help')
  await t.run()
  expect(t.events).toEqual([['error', { message: 'The tutor declined to answer that. Try rephrasing.' }], ['done', { awaiting: false }]])
})

test('stops after MAX_STEPS model calls', async () => {
  let n = 0
  const t = setup(() => toolCall('teleport', {}, `tu_${n++}`))
  t.say('help')
  await t.run()
  expect(t.calls).toHaveLength(MAX_STEPS)
  expect(t.events.slice(-2)).toEqual([
    ['error', { message: 'The tutor took too many steps. Send a message to continue.' }],
    ['done', { awaiting: false }],
  ])
})

test('every user message the server sends ends with study_state', async () => {
  const t = setup([toolCall('teleport', {}), text('ok')])
  t.say('help')
  await t.run()
  for (const row of t.rows().filter(r => r.role === 'user')) {
    expect(String(row.content.at(-1)?.text)).toMatch(/^<study_state>\n[\s\S]*Tools allowed now: ask_user_question, web_search\n<\/study_state>$/)
  }
})

import type Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'vitest'
import { buildApp } from '../app'
import type { MessageStreamParams } from '../tutor/context'
import type { StreamMessage } from '../tutor/loop'
import { summarizeNew } from '../tutor/teach'
import { LOCAL_USER_ID, openDb } from './db'

const KEY = { 'x-anthropic-key': 'sk-test' }
const usage = (input: number, output: number, extra: object = {}) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: null,
  cache_creation_input_tokens: null,
  server_tool_use: null,
  ...extra,
})

async function setup(replies: object[]) {
  const db = openDb(':memory:')
  const calls: MessageStreamParams[] = []
  const streamMessage: StreamMessage = async params => {
    calls.push(params)
    return replies.shift() as Anthropic.Beta.BetaMessage
  }
  const app = buildApp({ db, streamMessage })
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Calc' } })).json()
  const createStudy = (payload: object) => app.inject({ method: 'POST', url: `/api/projects/${project.id}/studies`, payload })
  return { app, db, calls, projectId: project.id as string, createStudy }
}

test('each tutor call is recorded and totaled per model on the study', async () => {
  const t = await setup([
    {
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'searching' }],
      stop_reason: 'pause_turn',
      usage: usage(100, 10, { cache_read_input_tokens: 50, cache_creation_input_tokens: 20, server_tool_use: { web_search_requests: 1 } }),
    },
    { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'found' }], stop_reason: 'end_turn', usage: usage(5, 7) },
  ])
  const study = (await t.createStudy({ goal: 'midterm' })).json()
  const other = (await t.createStudy({ goal: 'final' })).json()
  expect(study.usage).toEqual([])
  await t.app.inject({ method: 'POST', url: `/api/studies/${study.id}/messages`, headers: KEY, payload: { text: 'go' } })
  const totals = [{ model: 'claude-opus-5-5', inputTokens: 105, outputTokens: 17, cacheReadTokens: 50, cacheWriteTokens: 20, webSearches: 1 }]
  expect((await t.app.inject(`/api/studies/${study.id}`)).json().usage).toEqual(totals)
  const project = (await t.app.inject(`/api/projects/${t.projectId}`)).json()
  expect(project.usage).toEqual(totals)
  expect(Object.fromEntries(project.studies.map((s: { id: string; usage: unknown }) => [s.id, s.usage]))).toEqual({ [study.id]: totals, [other.id]: [] })
})

test('summaries are recorded on their study', async () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', ?, 'Calc', 0)").run(LOCAL_USER_ID)
  db.prepare("INSERT INTO studies (id, project_id, goal, phase, search_cap, created_at) VALUES ('s1', 'p1', 'midterm', 'teach', 3, 0)").run()
  db.prepare("INSERT INTO nodes (id, study_id, label, kind, description, state, ever_known, updated_at) VALUES ('n1', 's1', 'N', 'root', 'd', 'known', 1, 0)").run()
  db.prepare("INSERT INTO messages (id, study_id, node_id, role, content, created_at) VALUES ('m1', 's1', 'n1', 'assistant', ?, 0)").run(
    JSON.stringify([{ type: 'text', text: 'Lesson.' }]),
  )
  await summarizeNew(db, 's1', 'sk-test', async (_transcript, _key, onUsage) => {
    onUsage?.({ model: 'claude-haiku-5-5', usage: usage(30, 4) as Anthropic.Usage })
    return 'Summary.'
  })
  expect(db.prepare('SELECT project_id, study_id, model, input_tokens, output_tokens, web_searches FROM usage').all()).toEqual([
    { project_id: 'p1', study_id: 's1', model: 'claude-haiku-5-5', input_tokens: 30, output_tokens: 4, web_searches: 0 },
  ])
})

test('the search cap is set per study at creation and sent as max_uses', async () => {
  const t = await setup([
    { content: [{ type: 'text', text: 'a' }], stop_reason: 'end_turn' },
    { content: [{ type: 'text', text: 'b' }], stop_reason: 'end_turn' },
  ])
  const capped = (await t.createStudy({ goal: 'midterm', searchCap: 5 })).json()
  const plain = (await t.createStudy({ goal: 'final' })).json()
  expect([capped.searchCap, plain.searchCap]).toEqual([5, 3])
  for (const bad of [0, 11, 2.5, 'lots']) expect((await t.createStudy({ goal: 'x', searchCap: bad })).statusCode).toBe(400)
  for (const s of [capped, plain]) {
    await t.app.inject({ method: 'POST', url: `/api/studies/${s.id}/messages`, headers: KEY, payload: { text: 'go' } })
  }
  expect(t.calls.map(c => c.tools?.at(-1))).toEqual([
    { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
    { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
  ])
  expect((await t.app.inject(`/api/studies/${capped.id}`)).json().searchCap).toBe(5)
})

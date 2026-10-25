import { expect, test } from 'vitest'
import { buildApp } from '../app'
import { scripted, ZERO } from '../tutor/scripted'
import { summarizeNew } from '../tutor/teach'
import { LOCAL_USER_ID, openDb } from './db'

async function setup(replies: object[]) {
  const db = openDb(':memory:')
  const { runHop } = scripted(replies as never)
  const app = buildApp({ db, runHop })
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Calc' } })).json()
  const createStudy = (payload: object) => app.inject({ method: 'POST', url: `/api/projects/${project.id}/studies`, payload })
  return { app, db, projectId: project.id as string, createStudy }
}

test('each tutor call is recorded and totaled per model on the study', async () => {
  const t = await setup([
    {
      content: [{ type: 'text', text: 'searching' }],
      stop_reason: 'pause_turn',
      usage: { ...ZERO, input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 20, server_tool_use: { web_search_requests: 1 } },
    },
    { content: [{ type: 'text', text: 'found' }], stop_reason: 'end_turn', usage: { ...ZERO, input_tokens: 5, output_tokens: 7 } },
  ])
  const study = (await t.createStudy({ goal: 'midterm' })).json()
  const other = (await t.createStudy({ goal: 'final' })).json()
  expect(study.usage).toEqual([])
  await t.app.inject({ method: 'POST', url: `/api/studies/${study.id}/messages`, payload: { text: 'go' } })
  const totals = [{ model: 'claude-opus-5-5', inputTokens: 105, outputTokens: 17, cacheReadTokens: 50, cacheWriteTokens: 20, webSearches: 1 }]
  expect((await t.app.inject(`/api/studies/${study.id}`)).json().usage).toEqual(totals)
  const project = (await t.app.inject(`/api/projects/${t.projectId}`)).json()
  expect(project.usage).toEqual(totals)
  expect(Object.fromEntries(project.studies.map((s: { id: string; usage: unknown }) => [s.id, s.usage]))).toEqual({ [study.id]: totals, [other.id]: [] })
})

test('summaries are recorded on their study', async () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', ?, 'Calc', 0)").run(LOCAL_USER_ID)
  db.prepare("INSERT INTO studies (id, project_id, goal, phase, created_at) VALUES ('s1', 'p1', 'midterm', 'teach', 0)").run()
  db.prepare("INSERT INTO nodes (id, study_id, label, kind, description, state, ever_known, updated_at) VALUES ('n1', 's1', 'N', 'root', 'd', 'known', 1, 0)").run()
  db.prepare("INSERT INTO messages (id, study_id, node_id, role, content, created_at) VALUES ('m1', 's1', 'n1', 'assistant', ?, 0)").run(
    JSON.stringify([{ type: 'text', text: 'Lesson.' }]),
  )
  await summarizeNew(db, 's1', async (_transcript, onUsage) => {
    onUsage?.({ model: 'claude-haiku-5-5', inputTokens: 30, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 })
    return 'Summary.'
  })
  expect(db.prepare('SELECT project_id, study_id, model, input_tokens, output_tokens, web_searches FROM usage').all()).toEqual([
    { project_id: 'p1', study_id: 's1', model: 'claude-haiku-5-5', input_tokens: 30, output_tokens: 4, web_searches: 0 },
  ])
})

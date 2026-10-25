import { expect, test } from 'vitest'
import { buildApp } from './app'
import { openDb } from './db'

function setup() {
  const db = openDb(':memory:')
  return { db, app: buildApp({ db }) }
}

async function createProject(app: ReturnType<typeof buildApp>, name: string) {
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name } })
  expect(res.statusCode).toBe(201)
  return res.json()
}

test('creates a project and lists it newest first', async () => {
  const { app } = setup()
  const first = await createProject(app, 'Calculus')
  const second = await createProject(app, 'Networks')
  expect(first).toMatchObject({ name: 'Calculus', id: expect.any(String), createdAt: expect.any(Number) })
  const list = (await app.inject('/api/projects')).json()
  expect(list.map((p: { id: string }) => p.id)).toEqual([second.id, first.id])
})

test('rejects a blank project name', async () => {
  const { app } = setup()
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '   ' } })
  expect(res.statusCode).toBe(400)
})

test('returns 404 for an unknown project', async () => {
  const { app } = setup()
  const res = await app.inject('/api/projects/nope')
  expect(res.statusCode).toBe(404)
  expect(res.json().message).toBe('Project not found.')
})

test('deleting a project removes it', async () => {
  const { app } = setup()
  const p = await createProject(app, 'Calculus')
  expect((await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` })).statusCode).toBe(204)
  expect((await app.inject(`/api/projects/${p.id}`)).statusCode).toBe(404)
})

test('creates a study in probe phase with zero counts', async () => {
  const { app } = setup()
  const p = await createProject(app, 'Calculus')
  const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/studies`, payload: { goal: 'midterm' } })
  expect(res.statusCode).toBe(201)
  expect(res.json()).toMatchObject({ goal: 'midterm', phase: 'probe', counts: { untested: 0, missed: 0, frontier: 0, known: 0 } })
})

test('project page counts nodes per state for each study', async () => {
  const { app, db } = setup()
  const p = await createProject(app, 'Calculus')
  const s = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/studies`, payload: { goal: 'midterm' } })).json()
  const insert = db.prepare("INSERT INTO nodes (id, study_id, label, kind, description, state, updated_at) VALUES (?, ?, 'n', 'derived', 'd', ?, 0)")
  insert.run('n1', s.id, 'known')
  insert.run('n2', s.id, 'known')
  insert.run('n3', s.id, 'missed')
  const page = (await app.inject(`/api/projects/${p.id}`)).json()
  expect(page.files).toEqual([])
  expect(page.studies[0].counts).toEqual({ untested: 0, missed: 1, frontier: 0, known: 2 })
})

test('creating a study in an unknown project is a 404', async () => {
  const { app } = setup()
  const res = await app.inject({ method: 'POST', url: '/api/projects/nope/studies', payload: { goal: 'midterm' } })
  expect(res.statusCode).toBe(404)
})

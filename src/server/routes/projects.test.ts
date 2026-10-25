import { expect, test } from 'vitest'
import { buildApp } from '../app'
import { openDb } from '../core/db'

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

test('deleting a project removes its goals\' transcripts', async () => {
  const { app, db } = setup()
  const p = await createProject(app, 'Calculus')
  const s = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/studies`, payload: { goal: 'midterm' } })).json()
  db.prepare("UPDATE studies SET session_id = 'main-session' WHERE id = ?").run(s.id)
  db.prepare("INSERT INTO nodes (id, study_id, label, kind, description, state, session_id, updated_at) VALUES ('n1', ?, 'n', 'derived', 'd', 'known', 'node-session', 0)").run(s.id)
  const entry = db.prepare('INSERT INTO agent_entries (session_id, entry) VALUES (?, ?)')
  for (const id of ['main-session', 'node-session', 'other-session']) entry.run(id, '{"type":"user"}')
  expect((await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` })).statusCode).toBe(204)
  expect(db.prepare('SELECT session_id FROM agent_entries').all()).toEqual([{ session_id: 'other-session' }])
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

test('lists projects with goal and file counts', async () => {
  const { app } = setup()
  const p = await createProject(app, 'Calculus')
  const empty = await createProject(app, 'Networks')
  for (const goal of ['midterm', 'final']) await app.inject({ method: 'POST', url: `/api/projects/${p.id}/studies`, payload: { goal } })
  await app.inject({
    method: 'POST',
    url: `/api/projects/${p.id}/files?name=notes.md`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('# Notes'),
  })
  const list = (await app.inject('/api/projects')).json()
  expect(list).toEqual([
    { ...empty, goalCount: 0, fileCount: 0 },
    { ...p, goalCount: 2, fileCount: 1 },
  ])
})

test('renames a project; a blank name is a 400 and an unknown project a 404', async () => {
  const { app } = setup()
  const p = await createProject(app, 'Calculus')
  const rename = (id: string, name: string) => app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { name } })
  const res = await rename(p.id, '  Calculus 101 ')
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ id: p.id, name: 'Calculus 101', createdAt: p.createdAt })
  expect((await app.inject(`/api/projects/${p.id}`)).json().name).toBe('Calculus 101')
  const blank = await rename(p.id, '   ')
  expect(blank.statusCode).toBe(400)
  expect(blank.json().message).toBe("Name can't be blank.")
  expect((await rename('nope', 'X')).statusCode).toBe(404)
})

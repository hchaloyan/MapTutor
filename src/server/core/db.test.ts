import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { LOCAL_USER_ID, openDb } from './db'

function seedProject(db: ReturnType<typeof openDb>) {
  const now = Date.now()
  db.prepare('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run('p1', LOCAL_USER_ID, 'Calc', now)
  return now
}

test('creates every table, including quiz_items.hint', () => {
  const db = openDb(':memory:')
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name)
  expect(tables).toEqual(['edges', 'files', 'messages', 'nodes', 'projects', 'quiz_items', 'studies', 'users'])
  expect(db.prepare('PRAGMA table_info(quiz_items)').all().map(c => c.name)).toContain('hint')
})

test('reopening an existing file is safe and keeps one user', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'maptutor-')), 'test.db')
  openDb(path).close()
  const db = openDb(path)
  expect(db.prepare('SELECT id FROM users').all()).toEqual([{ id: LOCAL_USER_ID }])
})

test('deleting a project cascades to its files and studies', () => {
  const db = openDb(':memory:')
  const now = seedProject(db)
  db.prepare("INSERT INTO files (id, project_id, kind, name, created_at) VALUES ('f1', 'p1', 'text', 'notes.md', ?)").run(now)
  db.prepare("INSERT INTO studies (id, project_id, goal, phase, created_at) VALUES ('s1', 'p1', 'midterm', 'probe', ?)").run(now)
  db.prepare("DELETE FROM projects WHERE id = 'p1'").run()
  expect(db.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 0 })
  expect(db.prepare('SELECT count(*) AS n FROM studies').get()).toEqual({ n: 0 })
})

test('rejects an unknown study phase', () => {
  const db = openDb(':memory:')
  const now = seedProject(db)
  expect(() =>
    db.prepare("INSERT INTO studies (id, project_id, goal, phase, created_at) VALUES ('s1', 'p1', 'midterm', 'teaching', ?)").run(now),
  ).toThrow(/CHECK constraint failed/)
})

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

test('creates every table without quiz_items.hint or studies.search_cap', () => {
  const db = openDb(':memory:')
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name)
  expect(tables).toEqual(['agent_entries', 'edges', 'files', 'messages', 'nodes', 'projects', 'quiz_items', 'studies', 'usage', 'users'])
  expect(db.prepare('PRAGMA table_info(quiz_items)').all().map(c => c.name)).not.toContain('hint')
  expect(db.prepare('PRAGMA table_info(studies)').all().map(c => c.name)).not.toContain('search_cap')
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

function seedNodes(db: ReturnType<typeof openDb>) {
  const now = seedProject(db)
  for (const s of ['s1', 's2']) {
    db.prepare("INSERT INTO studies (id, project_id, goal, phase, created_at) VALUES (?, 'p1', 'midterm', 'teach', ?)").run(s, now)
    for (const n of ['a', 'b']) {
      db.prepare("INSERT INTO nodes (id, study_id, label, kind, description, state, updated_at) VALUES (?, ?, 'n', 'derived', 'd', 'untested', 0)").run(n, s)
    }
  }
  return now
}

test('node ids are per study, and deleting a node cascades to its edges and threads', () => {
  const db = openDb(':memory:')
  const now = seedNodes(db)
  db.prepare("INSERT INTO edges (study_id, from_node, to_node) VALUES ('s1', 'a', 'b'), ('s2', 'a', 'b')").run()
  db.prepare("INSERT INTO messages (id, study_id, node_id, role, content, created_at) VALUES ('m1', 's1', 'a', 'user', '[]', ?)").run(now)
  db.prepare("DELETE FROM nodes WHERE study_id = 's1' AND id = 'a'").run()
  expect(db.prepare('SELECT study_id FROM edges').all()).toEqual([{ study_id: 's2' }])
  expect(db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 })
  expect(db.prepare("SELECT count(*) AS n FROM nodes WHERE id = 'a'").get()).toEqual({ n: 1 })
})

test("a message or quiz item cannot point at another study's node", () => {
  const db = openDb(':memory:')
  const now = seedNodes(db)
  db.prepare("DELETE FROM nodes WHERE study_id = 's2' AND id = 'b'").run()
  expect(() =>
    db.prepare("INSERT INTO messages (id, study_id, node_id, role, content, created_at) VALUES ('m1', 's2', 'b', 'user', '[]', ?)").run(now),
  ).toThrow(/FOREIGN KEY/)
  expect(() =>
    db.prepare(
      `INSERT INTO quiz_items (id, study_id, quiz_call_id, phase, node_id, prompt, options, correct_option_id, explanation)
       VALUES ('q1', 's2', 't', 'check', 'b', 'p', '[]', 'a', 'e')`,
    ).run(),
  ).toThrow(/FOREIGN KEY/)
  expect(() => db.prepare("INSERT INTO edges (study_id, from_node, to_node) VALUES ('s2', 'a', 'b')").run()).toThrow(/FOREIGN KEY/)
})

test('rejects an unknown study phase', () => {
  const db = openDb(':memory:')
  const now = seedProject(db)
  expect(() =>
    db.prepare("INSERT INTO studies (id, project_id, goal, phase, created_at) VALUES ('s1', 'p1', 'midterm', 'teaching', ?)").run(now),
  ).toThrow(/CHECK constraint failed/)
})

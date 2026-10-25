import { expect, test } from 'vitest'
import { openDb } from './db'
import { deleteSessions, hasDeferredCall, sqliteSessionStore } from './sessions'

const key = (sessionId: string, projectKey = 'p', subpath?: string) => ({ projectKey, sessionId, ...(subpath && { subpath }) })

test('load returns entries in append order and null for an unknown session', async () => {
  const store = sqliteSessionStore(openDb(':memory:'))
  await store.append(key('s1'), [{ type: 'user', uuid: 'a' }, { type: 'assistant', uuid: 'b' }])
  await store.append(key('s1'), [{ type: 'cost-state', n: 1 }])
  expect(await store.load(key('s1'))).toEqual([{ type: 'user', uuid: 'a' }, { type: 'assistant', uuid: 'b' }, { type: 'cost-state', n: 1 }])
  expect(await store.load(key('s2'))).toBeNull()
})

test('a re-sent entry with the same uuid is stored once', async () => {
  const store = sqliteSessionStore(openDb(':memory:'))
  await store.append(key('s1'), [{ type: 'x', uuid: 'u1' }])
  await store.append(key('s1'), [{ type: 'x', uuid: 'u1' }])
  expect(await store.load(key('s1'))).toHaveLength(1)
})

test('subpaths are separate transcripts and delete removes all of a session', async () => {
  const store = sqliteSessionStore(openDb(':memory:'))
  await store.append(key('s1'), [{ type: 'user', uuid: 'a' }])
  await store.append(key('s1', 'p', 'subagents/agent-1'), [{ type: 'user', uuid: 'b' }])
  expect(await store.load(key('s1'))).toEqual([{ type: 'user', uuid: 'a' }])
  expect(await store.load(key('s1', 'p', 'subagents/agent-1'))).toEqual([{ type: 'user', uuid: 'b' }])
  await store.delete!(key('s1'))
  expect(await store.load(key('s1'))).toBeNull()
  expect(await store.load(key('s1', 'p', 'subagents/agent-1'))).toBeNull()
})

test('projectKey is ignored, so a moved repo still resumes', async () => {
  const store = sqliteSessionStore(openDb(':memory:'))
  await store.append(key('s1', 'a'), [{ type: 'user', uuid: 'a' }])
  expect(await store.load(key('s1', 'b'))).toEqual([{ type: 'user', uuid: 'a' }])
})

test('deleteSessions removes every listed session and keeps the rest', async () => {
  const db = openDb(':memory:')
  const store = sqliteSessionStore(db)
  for (const s of ['s1', 's2', 's3']) await store.append(key(s), [{ type: 'user', uuid: s }])
  deleteSessions(db, ['s1', 's3'])
  expect(await store.load(key('s1'))).toBeNull()
  expect(await store.load(key('s2'))).toEqual([{ type: 'user', uuid: 's2' }])
  expect(await store.load(key('s3'))).toBeNull()
})

test('hasDeferredCall is true while the last tool_use has no tool_result', async () => {
  const db = openDb(':memory:')
  const store = sqliteSessionStore(db)
  const assistant = (id: string) => ({ type: 'assistant', uuid: `a-${id}`, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id, name: 'mcp__tutor__quiz', input: {} }] } })
  const result = (id: string) => ({ type: 'user', uuid: `r-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
  expect(hasDeferredCall(db, 's1')).toBe(false)
  await store.append(key('s1'), [{ type: 'user', uuid: 'u', message: { role: 'user', content: 'a string prompt' } }, assistant('t1')])
  expect(hasDeferredCall(db, 's1')).toBe(true)
  await store.append(key('s1'), [result('t1'), { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }])
  expect(hasDeferredCall(db, 's1')).toBe(false)
  await store.append(key('s1'), [assistant('t2')])
  expect(hasDeferredCall(db, 's1')).toBe(true)
})

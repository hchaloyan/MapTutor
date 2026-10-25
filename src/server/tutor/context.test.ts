import { expect, test } from 'vitest'
import { buildRequest, fileBlocks, studyStateText, threadMessages } from './context'
import { LOCAL_USER_ID, openDb } from '../core/db'
import { systemPrompt } from './prompt'

const HOUR = { type: 'ephemeral', ttl: '1h' }

function setup() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', ?, 'Calc', 0)").run(LOCAL_USER_ID)
  db.prepare("INSERT INTO studies (id, project_id, goal, phase, created_at) VALUES ('s1', 'p1', 'midterm', 'probe', 0)").run()
  const addFile = (id: string, kind: string, name: string, data: Buffer | null, text: string | null) =>
    db.prepare('INSERT INTO files (id, project_id, kind, name, data, text_cache, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, 'p1', kind, name, data, text, Number(id.slice(1)),
    )
  const addMessage = (id: string, role: string, content: unknown) =>
    db.prepare('INSERT INTO messages (id, study_id, node_id, role, content, created_at) VALUES (?, ?, NULL, ?, ?, ?)').run(
      id, 's1', role, JSON.stringify(content), Number(id.slice(1)),
    )
  return { db, addFile, addMessage }
}

test('system prompt drops the frontmatter and keeps the skill and appendix', () => {
  const prompt = systemPrompt()
  expect(prompt).not.toContain('name: teach')
  expect(prompt.startsWith('# Teaching')).toBe(true)
  expect(prompt).toContain('<study_state>')
})

test('system prompt is identical on every call', () => {
  expect(systemPrompt()).toBe(systemPrompt())
})

test('file blocks: pdf as document, image with media type, text wrapped with its name', () => {
  const { db, addFile } = setup()
  addFile('f1', 'pdf', 'slides.pdf', Buffer.from('%PDF'), null)
  addFile('f2', 'image', 'board.PNG', Buffer.from([1, 2]), null)
  addFile('f3', 'text', 'notes.md', null, 'hello')
  expect(fileBlocks(db, 'p1')).toEqual([
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF').toString('base64') }, title: 'slides.pdf' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from([1, 2]).toString('base64') } },
    { type: 'text', text: '<file name="notes.md">\nhello\n</file>' },
  ])
})

test('study state lists goal, phase, thread, and allowed tools', () => {
  const { db } = setup()
  const text = studyStateText(db, 's1', null, ['ask_user_question', 'web_search'])
  expect(text.startsWith('<study_state>\n')).toBe(true)
  expect(text.endsWith('\n</study_state>')).toBe(true)
  for (const line of ['Goal: midterm', 'Phase: probe', 'Thread: main', 'Tools allowed now: ask_user_question, web_search']) {
    expect(text).toContain(line)
  }
  expect(studyStateText(db, 's1', 'n1', [])).toContain('Thread: node n1')
})

test('request pins model, effort, thinking binding, fallbacks, tool choice, and web search cap', () => {
  const { db, addMessage } = setup()
  addMessage('m1', 'user', [{ type: 'text', text: 'hi' }])
  const req = buildRequest(db, 's1', null, [])
  expect(req).toMatchObject({
    model: 'claude-opus-5-5',
    max_tokens: 64000,
    output_config: { effort: 'high' },
    thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    fallbacks: 'default',
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
  })
  expect(req.betas).toEqual(expect.arrayContaining(['thinking-binding-controls-2026-08-01', 'server-side-fallback-2026-07-01']))
  expect(req.tools?.at(-1)).toEqual({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 })
})

test('breakpoints sit on system, the last file block, and the last message, all 1h', () => {
  const { db, addFile, addMessage } = setup()
  addFile('f1', 'text', 'a.md', null, 'a')
  addFile('f2', 'text', 'b.md', null, 'b')
  addMessage('m1', 'user', [{ type: 'text', text: 'hi' }])
  addMessage('m2', 'assistant', [{ type: 'text', text: 'hello' }])
  addMessage('m3', 'user', [{ type: 'text', text: 'more' }, { type: 'text', text: '<study_state>\n</study_state>' }])
  const req = buildRequest(db, 's1', null, [])
  const system = req.system as { cache_control?: unknown }[]
  expect(system.at(-1)?.cache_control).toEqual(HOUR)
  const blocks = (i: number) => req.messages[i].content as { cache_control?: unknown }[]
  expect(blocks(0).map(b => b.cache_control)).toEqual([undefined, HOUR])
  expect(blocks(1)[0].cache_control).toBeUndefined()
  expect(blocks(3).map(b => b.cache_control)).toEqual([undefined, HOUR])
  expect(threadMessages(db, 's1', null)[2].content).toEqual([{ type: 'text', text: 'more' }, { type: 'text', text: '<study_state>\n</study_state>' }])
})

test('no files means no leading file message', () => {
  const { db, addMessage } = setup()
  addMessage('m1', 'user', [{ type: 'text', text: 'hi' }])
  const req = buildRequest(db, 's1', null, [])
  expect(req.messages).toHaveLength(1)
  expect(req.messages[0].content).toEqual([{ type: 'text', text: 'hi', cache_control: HOUR }])
})

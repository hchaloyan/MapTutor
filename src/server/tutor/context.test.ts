import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { FILES_DIR } from '../core/config'
import { canRead, fileBlocks, studyStateText } from './context'

const MB = 1024 * 1024
import { LOCAL_USER_ID, openDb } from '../core/db'
import { systemPrompt } from './prompt'

function setup() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', ?, 'Calc', 0)").run(LOCAL_USER_ID)
  db.prepare("INSERT INTO studies (id, project_id, goal, phase, created_at) VALUES ('s1', 'p1', 'midterm', 'probe', 0)").run()
  const addFile = (id: string, kind: string, name: string, data: Buffer | null, text: string | null) =>
    db.prepare('INSERT INTO files (id, project_id, kind, name, data, text_cache, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, 'p1', kind, name, data, text, Number(id.slice(1)),
    )
  return { db, addFile }
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

test('a file over 5 MB, or past the 20 MB attached budget, is copied to disk and listed for Read', () => {
  const { db, addFile } = setup()
  const dir = join(FILES_DIR, 'p1')
  try {
    addFile('f1', 'pdf', 'textbook.pdf', Buffer.alloc(6 * MB), null)
    for (const i of [2, 3, 4, 5, 6]) addFile(`f${i}`, 'text', `notes${i}.md`, null, 'x'.repeat(4.5 * MB))
    const blocks = fileBlocks(db, 'p1') as { type: string; text?: string }[]
    expect(blocks[0].text).toBe(
      `<file name="textbook.pdf" size="6.0 MB" path="${join(dir, 'f1.pdf')}">Too large to attach. Open it with the Read tool when you need it; for a PDF, pass \`pages\`, at most 20 pages per call.</file>`,
    )
    // notes2–5 fill 18 MB of the budget; notes6 would pass 20 MB.
    expect(blocks.slice(1, 5).every(b => b.text?.startsWith('<file name="notes'))).toBe(true)
    expect(blocks[5].text).toContain(`path="${join(dir, 'f6.md')}"`)
    expect(readFileSync(join(dir, 'f1.pdf')).length).toBe(6 * MB)

    expect(canRead('p1', { file_path: join(dir, 'f1.pdf'), pages: '1-20' })).toBe(true)
    for (const path of [join(FILES_DIR, 'p2', 'f1.pdf'), join(dir, '..', '..', 'maptutor.db'), dir, 'C:\\Windows\\win.ini']) {
      expect(canRead('p1', { file_path: path })).toBe(false)
    }
    expect(canRead('p1', {})).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('study state lists goal, phase, thread, and allowed tools', () => {
  const { db } = setup()
  const text = studyStateText(db, 's1', null, ['ask_user_question', 'WebSearch'])
  expect(text.startsWith('<study_state>\n')).toBe(true)
  expect(text.endsWith('\n</study_state>')).toBe(true)
  for (const line of ['Goal: midterm', 'Phase: probe', 'Thread: main', 'Tools allowed now: ask_user_question, WebSearch']) {
    expect(text).toContain(line)
  }
  expect(studyStateText(db, 's1', 'n1', [])).toContain('Thread: node n1')
})

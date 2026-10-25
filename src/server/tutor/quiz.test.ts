import type Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'vitest'
import { buildApp } from '../app'
import { studyStateText } from './context'
import { LOCAL_USER_ID, openDb } from '../core/db'
import { probeStrands, quizTool } from './quiz'
import type { StreamMessage } from './loop'

const item = (id: string, correct: string, extra: object = {}) => ({
  id,
  prompt: `Question ${id}`,
  options: [{ id: `${id}a`, text: 'first' }, { id: `${id}b`, text: 'second' }],
  correctOptionId: correct,
  explanation: `Because ${id}.`,
  ...extra,
})
const QUIZ = { items: [item('q1', 'q1a', { hint: 'Think.', strand: 'arithmetic' }), item('q2', 'q2b', { strand: 'arithmetic' })] }

function setup(phase = 'probe') {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', ?, 'Calc', 0)").run(LOCAL_USER_ID)
  for (const s of ['s1', 's2']) {
    db.prepare("INSERT INTO studies (id, project_id, goal, phase, created_at) VALUES (?, 'p1', 'midterm', ?, 0)").run(s, phase)
  }
  for (const [n, s] of [['n1', 's1'], ['n9', 's2']]) {
    db.prepare("INSERT INTO nodes (id, study_id, label, kind, description, state, updated_at) VALUES (?, ?, 'n', 'derived', 'd', 'untested', 0)").run(n, s)
  }
  return { db, ctx: { db, studyId: 's1', nodeId: null } }
}

test('the card hides answers until the user answers', () => {
  const { ctx } = setup()
  expect(quizTool.card(QUIZ, ctx, false)).toEqual({
    items: [
      { id: 'q1', prompt: 'Question q1', options: QUIZ.items[0].options, hint: 'Think.' },
      { id: 'q2', prompt: 'Question q2', options: QUIZ.items[1].options },
    ],
  })
  expect(quizTool.card(QUIZ, ctx, true)).toMatchObject({
    items: [{ correctOptionId: 'q1a', explanation: 'Because q1.' }, { correctOptionId: 'q2b', explanation: 'Because q2.' }],
  })
  expect(JSON.stringify(quizTool.card(QUIZ, ctx, true))).not.toContain('arithmetic')
})

test('answering grades on the server and stores quiz items', () => {
  const { db, ctx } = setup()
  const result = quizTool.answer(QUIZ, { choices: { q1: 'q1a', q2: 'q2a' } }, ctx, 'tu_1')
  expect(result).toEqual({
    content: JSON.stringify({
      results: [
        { itemId: 'q1', chosenOptionId: 'q1a', correct: true },
        { itemId: 'q2', chosenOptionId: 'q2a', correct: false },
      ],
    }),
  })
  expect(
    db.prepare('SELECT id, quiz_call_id, phase, strand, node_id, chosen_option_id, correct_option_id, hint FROM quiz_items ORDER BY id').all(),
  ).toEqual([
    { id: 'tu_1:q1', quiz_call_id: 'tu_1', phase: 'probe', strand: 'arithmetic', node_id: null, chosen_option_id: 'q1a', correct_option_id: 'q1a', hint: 'Think.' },
    { id: 'tu_1:q2', quiz_call_id: 'tu_1', phase: 'probe', strand: 'arithmetic', node_id: null, chosen_option_id: 'q2a', correct_option_id: 'q2b', hint: null },
  ])
})

test('an incomplete or invalid answer is rejected and stores nothing', () => {
  const { db, ctx } = setup()
  expect(quizTool.answer(QUIZ, { choices: { q1: 'q1a' } }, ctx, 'tu_1')).toEqual({ error: 'Answer every question.' })
  expect(quizTool.answer(QUIZ, { choices: { q1: 'q1a', q2: 'nope' } }, ctx, 'tu_1')).toEqual({ error: "That isn't one of the options." })
  expect(quizTool.answer(QUIZ, 'garbage', ctx, 'tu_1')).toEqual({ error: 'Answer every question.' })
  expect(db.prepare('SELECT count(*) AS n FROM quiz_items').get()).toEqual({ n: 0 })
})

test('every problem in a malformed quiz is reported at once', () => {
  const { ctx } = setup()
  const bad = { items: [item('q1', 'z', { strand: 'a' }), item('q2', 'q2a')] }
  expect(quizTool.check(bad, ctx)).toBe(
    'Quiz item "q1": correctOptionId "z" is not one of its option ids.\nQuiz item "q2" needs a strand during the probe.',
  )
  expect(quizTool.check({ items: [] }, ctx)).toBe('A quiz needs 1–10 items.')
  expect(quizTool.check(QUIZ, ctx)).toBeNull()
})

test('probe items need a strand; teach items need a node in this study', () => {
  const { ctx } = setup('teach')
  expect(quizTool.check({ items: [item('q1', 'q1a', { strand: 's' })] }, ctx)).toBe('Quiz item "q1" needs a nodeId during teaching.')
  expect(quizTool.check({ items: [item('q1', 'q1a', { nodeId: 'n9' })] }, ctx)).toBe('Quiz item "q1": node "n9" is not in this study.')
  expect(quizTool.check({ items: [item('q1', 'q1a', { nodeId: 'n1' })] }, ctx)).toBeNull()
})

test('strand summary keeps exact names in first-use order', () => {
  const { db, ctx } = setup()
  quizTool.answer({ items: [item('q1', 'q1a', { strand: 'closures' })] }, { choices: { q1: 'q1a' } }, ctx, 'tu_1')
  quizTool.answer({ items: [item('q1', 'q1a', { strand: 'Closures' }), item('q2', 'q2a', { strand: 'closures' })] }, { choices: { q1: 'q1b', q2: 'q2a' } }, ctx, 'tu_2')
  expect(probeStrands(db, 's1')).toEqual([
    { strand: 'closures', correct: 2, total: 2 },
    { strand: 'Closures', correct: 0, total: 1 },
  ])
})

test('study state lists the strands used so far during the probe', () => {
  const { db, ctx } = setup()
  expect(studyStateText(db, 's1', null, [])).not.toContain('Strands used')
  quizTool.answer(QUIZ, { choices: { q1: 'q1a', q2: 'q2b' } }, ctx, 'tu_1')
  expect(studyStateText(db, 's1', null, [])).toContain('Strands used so far (reuse these exact names): arithmetic')
})

test('end to end: SSE card and thread view never carry the answer before it is given', async () => {
  const replies = [
    { content: [{ type: 'tool_use', id: 'tu_1', name: 'quiz', input: QUIZ }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Nice.' }], stop_reason: 'end_turn' },
  ]
  const streamMessage: StreamMessage = async () => replies.shift() as unknown as Anthropic.Beta.BetaMessage
  const app = buildApp({ db: openDb(':memory:'), streamMessage })
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Calc' } })).json()
  const study = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/studies`, payload: { goal: 'midterm' } })).json()
  const headers = { 'x-anthropic-key': 'sk-test' }
  const sse = await app.inject({ method: 'POST', url: `/api/studies/${study.id}/messages`, headers, payload: { text: 'quiz me' } })
  const thread = async () => (await app.inject(`/api/studies/${study.id}/thread`)).json()
  for (const leaked of ['correctOptionId', 'explanation', 'Because q1.', 'arithmetic']) {
    expect(sse.payload).not.toContain(leaked)
    expect(JSON.stringify(await thread())).not.toContain(leaked)
  }
  await app.inject({ method: 'POST', url: `/api/studies/${study.id}/tool-results`, headers, payload: { toolUseId: 'tu_1', answer: { choices: { q1: 'q1a', q2: 'q2b' } } } })
  const card = (await thread()).find((i: { type: string }) => i.type === 'card')
  expect(card.input.items[0]).toMatchObject({ correctOptionId: 'q1a', explanation: 'Because q1.' })
  expect(card.answer.results.map((r: { correct: boolean }) => r.correct)).toEqual([true, true])
  expect((await app.inject(`/api/studies/${study.id}`)).json().strands).toEqual([{ strand: 'arithmetic', correct: 2, total: 2 }])
})

import { expect, test } from 'vitest'
import type { Card } from './api'
import { questionAnswer, quizKey, quizSummary } from './cards'

const body = { tagName: 'BODY' }

test('quiz keys pick, advance and go back, but not from text fields', () => {
  expect(quizKey({ key: 'b', target: body }, 4)).toBe(1)
  expect(quizKey({ key: 'C', target: body }, 4)).toBe(2)
  expect(quizKey({ key: '1', target: body }, 4)).toBe(0)
  expect(quizKey({ key: 'd', target: body }, 3)).toBeNull()
  expect(quizKey({ key: 'Enter', target: body }, 4)).toBe('next')
  expect(quizKey({ key: 'Backspace', target: body }, 4)).toBe('back')
  expect(quizKey({ key: 'x', target: body }, 4)).toBeNull()
  expect(quizKey({ key: 'a', target: { tagName: 'TEXTAREA' } }, 4)).toBeNull()
  expect(quizKey({ key: 'Enter', target: { tagName: 'INPUT' } }, 4)).toBeNull()
  expect(quizKey({ key: 'a', target: { tagName: 'DIV', isContentEditable: true } }, 4)).toBeNull()
})

test('quiz summary counts results and pairs each item with its pick', () => {
  const card: Card = {
    type: 'card',
    toolUseId: 'tu_1',
    name: 'quiz',
    pending: false,
    createdAt: 0,
    input: {
      items: [
        { id: 'q1', prompt: 'One', options: [], correctOptionId: 'a', explanation: 'Because.' },
        { id: 'q2', prompt: 'Two', options: [], correctOptionId: 'b', explanation: 'So.' },
      ],
    },
    answer: {
      results: [
        { itemId: 'q1', chosenOptionId: 'a', correct: true },
        { itemId: 'q2', chosenOptionId: 'c', correct: false },
      ],
    },
  }
  const s = quizSummary(card)
  expect([s.correct, s.total]).toEqual([1, 2])
  expect(s.rows.map(r => [r.item.id, r.chosen, r.right])).toEqual([
    ['q1', 'a', true],
    ['q2', 'c', false],
  ])
})

test('question answers keep labels and typed text', () => {
  expect(questionAnswer(['Pass the midterm'], '')).toEqual({ answers: ['Pass the midterm'] })
  expect(questionAnswer(['A', 'B'], '  my own  ')).toEqual({ answers: ['A', 'B', 'my own'] })
  expect(questionAnswer([], '   ')).toEqual({ answers: [] })
})

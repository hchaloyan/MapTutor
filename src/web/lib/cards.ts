import type { Card } from './api'

export type QuizOption = { id: string; text: string }
export type QuizItem = { id: string; prompt: string; options: QuizOption[]; correctOptionId?: string; explanation?: string }

export const LETTERS = 'ABCDEF'

/** A–F or 1–6 pick an option, Enter goes on, Backspace goes back; never while typing in a field. */
export function quizKey(e: { key: string; target: { tagName?: string; isContentEditable?: boolean } }, optionCount: number): number | 'next' | 'back' | null {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return null
  if (e.key === 'Enter') return 'next'
  if (e.key === 'Backspace') return 'back'
  const letter = LETTERS.indexOf(e.key.toUpperCase())
  const index = e.key.length === 1 && letter >= 0 ? letter : /^[1-6]$/.test(e.key) ? Number(e.key) - 1 : -1
  return index >= 0 && index < optionCount ? index : null
}

export function quizSummary(card: Card) {
  const items = card.input.items as QuizItem[]
  const results = (card.answer?.results ?? []) as { itemId: string; chosenOptionId: string; correct: boolean }[]
  const rows = items.map(item => {
    const result = results.find(r => r.itemId === item.id)
    return { item, chosen: result?.chosenOptionId ?? '', right: !!result?.correct }
  })
  return { correct: rows.filter(r => r.right).length, total: rows.length, rows }
}

export const questionAnswer = (labels: string[], other: string) => ({ answers: [...labels, other].map(a => a.trim()).filter(Boolean) })

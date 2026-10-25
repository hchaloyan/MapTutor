import { expect, test } from 'vitest'
import { countLabel, fileBadge, formatBytes, goalName, masterySegments, phaseLabel, usedLabel } from './format'

test('count labels', () => {
  expect([countLabel(0, 'file'), countLabel(1, 'goal'), countLabel(3, 'goal'), countLabel(0, 'goal')]).toEqual(['no files', '1 goal', '3 goals', 'no goals'])
})

test('goal names fall back to the typed goal', () => {
  expect(goalName({ title: 'Ace the midterm', goal: 'help me study' })).toBe('Ace the midterm')
  expect(goalName({ title: null, goal: 'help me study' })).toBe('help me study')
})

test('phase labels mark done', () => {
  expect(phaseLabel('probe')).toEqual({ text: 'Probe', done: false })
  expect(phaseLabel('teach')).toEqual({ text: 'Teach', done: false })
  expect(phaseLabel('done')).toEqual({ text: 'Done ✓', done: true })
})

test('mastery segments are ordered and skip empty states', () => {
  expect(masterySegments({ untested: 3, missed: 1, frontier: 1, known: 2 })).toEqual([
    { state: 'known', count: 2 },
    { state: 'frontier', count: 1 },
    { state: 'missed', count: 1 },
    { state: 'untested', count: 3 },
  ])
  expect(masterySegments({ untested: 0, missed: 0, frontier: 0, known: 4 })).toEqual([{ state: 'known', count: 4 }])
  expect(masterySegments({ untested: 0, missed: 0, frontier: 0, known: 0 })).toEqual([])
})

test('bytes format as KB or MB', () => {
  expect([formatBytes(900), formatBytes(12_000), formatBytes(4_400_000)]).toEqual(['1 KB', '12 KB', '4.2 MB'])
})

test('file badges by kind and extension', () => {
  expect(fileBadge({ kind: 'text', name: 'notes.txt' })).toEqual({ label: 'TXT', color: 'var(--badge-text)' })
  expect(fileBadge({ kind: 'text', name: 'Midterm review.md' }).label).toBe('MD')
  expect(fileBadge({ kind: 'pdf', name: 'x.pdf' })).toEqual({ label: 'PDF', color: 'var(--badge-pdf)' })
  expect(fileBadge({ kind: 'image', name: 'board.jpg' }).label).toBe('IMG')
  expect(fileBadge({ kind: 'url', name: 'Derivatives' }).label).toBe('URL')
})

test('used label', () => {
  expect(usedLabel(5_662_310)).toBe('5.4 of 20 MB used')
  expect(usedLabel(0)).toBe('0 of 20 MB used')
})

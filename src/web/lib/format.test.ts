import { expect, test } from 'vitest'
import { clampSplit, countLabel, fileBadge, formatBytes, formatTokens, goalName, masterySegments, modelName, phaseLabel, usageTotals, usedLabel } from './format'

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
  expect(phaseLabel('done')).toEqual({ text: 'Done', done: true })
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
  expect(usedLabel(5_662_310)).toBe('5.4 of 100 MB used')
  expect(usedLabel(0)).toBe('0 of 100 MB used')
})

test('split clamps to 25–75', () => {
  expect([clampSplit(10), clampSplit(50), clampSplit(90)]).toEqual([25, 50, 75])
})

test('model names come from the model ID', () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
  expect(modelName('gpt-x')).toBe('gpt-x')
  expect(modelName('claude-opus')).toBe('claude-opus')
})

test('token figures round to k and M', () => {
  expect([0, 611, 999, 1000, 9412, 48210, 999_949, 999_950, 1_204_388].map(formatTokens)).toEqual([
    '0', '611', '999', '1.0k', '9.4k', '48.2k', '999.9k', '1.00M', '1.20M',
  ])
})

test('usage totals add every token kind and searches, and are zero when empty', () => {
  const row = { model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, webSearches: 2 }
  expect(usageTotals([row, { ...row, model: 'claude-haiku-5-5', webSearches: 0 }])).toEqual({ tokens: 200, searches: 2 })
  expect(usageTotals([])).toEqual({ tokens: 0, searches: 0 })
})

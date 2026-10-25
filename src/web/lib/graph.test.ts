import { expect, test } from 'vitest'
import { labelSize, layout, layoutKey, lightTimings, lineLength, prereqText } from './graph'

const nodes = [
  { id: 'functions', kind: 'root' as const },
  { id: 'limits', kind: 'root' as const },
  { id: 'slope', kind: 'derived' as const },
  { id: 'derivative', kind: 'derived' as const },
  { id: 'chain', kind: 'goal' as const },
]
const edges = [
  { from: 'functions', to: 'slope' },
  { from: 'limits', to: 'slope' },
  { from: 'slope', to: 'derivative' },
  { from: 'derivative', to: 'chain' },
]

test('layout puts prerequisites above dependents and the goal at the bottom', () => {
  const pos = layout(nodes, edges)
  for (const e of edges) expect(pos.get(e.from)!.y).toBeLessThan(pos.get(e.to)!.y)
  expect(pos.get('functions')!.y).toBe(pos.get('limits')!.y)
  expect(Math.max(...[...pos.values()].map(p => p.y))).toBe(pos.get('chain')!.y)
})

test('layoutKey ignores states and order but not structure', () => {
  const key = layoutKey(nodes, edges)
  expect(layoutKey([...nodes].reverse().map(n => ({ ...n, state: 'known' })), [...edges].reverse())).toBe(key)
  expect(layoutKey(nodes, edges.slice(1))).not.toBe(key)
  expect(layoutKey([...nodes, { id: 'extra', kind: 'derived' as const }], edges)).not.toBe(key)
})

test('light relays toward the open node and branches arrive together', () => {
  const diamond = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'd', to: 'c' },
    { from: 'c', to: 'z' }, // downstream of the open node: no light
  ]
  // Same speed on every line (100 px/s, a 20px light): a line's run lasts (length + light) / speed.
  const lengths = new Map([['a→b', 100], ['b→c', 50], ['d→c', 80], ['c→z', 60]])
  const t = lightTimings(diamond, 'c', lengths, 100, 20)
  expect(Object.fromEntries(t)).toEqual({
    'a→b': { delay: 0, duration: 1.2, cycle: 1.7, light: 20 }, // reaches b at 1.0, when b→c starts
    'b→c': { delay: 1, duration: 0.7, cycle: 1.7, light: 20 }, // reaches c at 1.5
    'd→c': { delay: 0.7, duration: 1, cycle: 1.7, light: 20 }, // the shorter branch starts later, reaches c at 1.5 too
  })
  // Every line into a node waits for the longest branch above it.
  const deep = lightTimings([...diamond, { from: 'e', to: 'd' }, { from: 'f', to: 'e' }], 'c', new Map([...lengths, ['e→d', 40], ['f→e', 30]]), 100, 20)
  expect([deep.get('f→e')!.delay, deep.get('e→d')!.delay, deep.get('d→c')!.delay]).toEqual([0, 0.3, 0.7])
})

test('a root has no light', () => {
  expect(lightTimings(edges, 'functions', new Map(), 600, 20).size).toBe(0)
})

test('labels shrink when long', () => {
  expect(labelSize('Slope', 'derived')).toBe(15)
  expect(labelSize('Fundamental theorem', 'derived')).toBe(13)
  expect(labelSize('Chain rule', 'goal')).toBe(17)
  expect(labelSize('Integration by parts', 'goal')).toBe(15)
})

test('prerequisite text names each weak node with its state', () => {
  const labels = [
    { id: 'cont', label: 'Continuity' },
    { id: 'slope', label: 'Slope' },
  ]
  expect(prereqText([{ id: 'cont', state: 'missed' }, { id: 'slope', state: 'frontier' }], labels)).toBe('Continuity (missed), Slope (frontier)')
})

test('line lengths follow the drawn curve', () => {
  expect(lineLength(100, 0, 100, 80)).toBeCloseTo(80, 5) // straight down
  const curve = lineLength(0, 0, 120, 80) // the S-curve between offset nodes
  expect(curve).toBeGreaterThan(Math.hypot(120, 80))
  expect(curve).toBeLessThan(120 + 80)
})

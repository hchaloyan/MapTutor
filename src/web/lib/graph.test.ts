import { expect, test } from 'vitest'
import { labelSize, layout, layoutKey, lightTimings, prereqText } from './graph'

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

test('light relays toward the hovered node and branches arrive together', () => {
  const diamond = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'd', to: 'c' },
    { from: 'c', to: 'z' }, // downstream of the hovered node: no light
  ]
  const t = lightTimings(diamond, 'c')
  expect(Object.fromEntries(t)).toEqual({
    'a→b': { delay: 0, cycle: 0.9 },
    'b→c': { delay: 0.45, cycle: 0.9 },
    'd→c': { delay: 0.45, cycle: 0.9 },
  })
  // Every line into a node waits for the longest branch above it.
  const deep = lightTimings([...diamond, { from: 'e', to: 'd' }, { from: 'f', to: 'e' }], 'c')
  expect(deep.get('d→c')).toEqual({ delay: 0.9, cycle: 1.35 })
  expect(deep.get('f→e')).toEqual({ delay: 0, cycle: 1.35 })
})

test('a root has no light', () => {
  expect(lightTimings(edges, 'functions').size).toBe(0)
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

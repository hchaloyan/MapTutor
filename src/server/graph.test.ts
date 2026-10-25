import { expect, test } from 'vitest'
import {
  afterQuizCheck, checkSetState, depths, type Edge, type GraphNode, initialState, nextNode, type NodeKind, type NodeState,
  validateGraph, weakAncestors,
} from './graph'

const node = (id: string, kind: GraphNode['kind'], strands: string[] = []): GraphNode => ({
  id, label: id, kind, description: `about ${id}`, strands,
})
const edge = (from: string, to: string): Edge => ({ from, to })

const PROBE = ['closures', 'scope']
const base = () => ({
  nodes: [node('r1', 'root', ['scope']), node('r2', 'root'), node('d1', 'derived', ['closures']), node('g', 'goal')],
  edges: [edge('r1', 'd1'), edge('r2', 'd1'), edge('d1', 'g'), edge('r2', 'g')],
})

test('accepts a valid graph', () => {
  const { nodes, edges } = base()
  expect(validateGraph(nodes, edges, PROBE)).toEqual([])
})

test('reports a cycle and stops', () => {
  const { nodes, edges } = base()
  nodes.push(node('d2', 'derived'))
  edges.push(edge('d1', 'd2'), edge('d2', 'd1'))
  expect(validateGraph(nodes, edges, PROBE)).toEqual(['The edges form a cycle through: d1, d2.'])
})

test('requires exactly one goal', () => {
  const { nodes, edges } = base()
  nodes.push(node('g2', 'goal'))
  edges.push(edge('d1', 'g2'))
  expect(validateGraph(nodes, edges, PROBE)).toContain('There must be exactly one goal node; found 2.')
  expect(validateGraph(nodes.filter(n => n.kind !== 'goal'), [], PROBE)).toContain('There must be exactly one goal node; found 0.')
})

test('rejects a root with a prerequisite', () => {
  const { nodes, edges } = base()
  edges.push(edge('r1', 'r2'))
  expect(validateGraph(nodes, edges, PROBE)).toContain('Root "r2" has a prerequisite; roots can\'t depend on anything.')
})

test('rejects an unreachable node', () => {
  const { nodes, edges } = base()
  nodes.push(node('x', 'derived'))
  edges.push(edge('x', 'g'))
  expect(validateGraph(nodes, edges, PROBE)).toEqual(['Node "x" is unreachable from every root.'])
})

test('rejects a dead end and an outgoing goal edge', () => {
  const { nodes, edges } = base()
  nodes.push(node('y', 'derived'))
  edges.push(edge('r1', 'y'), edge('g', 'y'))
  const errors = validateGraph(nodes, edges, PROBE)
  expect(errors).toContain('Node "y" leads nowhere; every node except the goal needs an outgoing edge.')
  expect(errors).toContain('The goal "g" can\'t be a prerequisite of anything.')
})

test('rejects unknown nodes and duplicate ids', () => {
  const { nodes, edges } = base()
  nodes.push(node('r1', 'root'))
  edges.push(edge('d1', 'nope'))
  const errors = validateGraph(nodes, edges, PROBE)
  expect(errors).toContain('Duplicate node id "r1".')
  expect(errors).toContain('Edge d1 → nope refers to an unknown node.')
})

test('matches strands exactly and lists the valid ones', () => {
  const { nodes, edges } = base()
  nodes[2] = node('d1', 'derived', ['Closures'])
  expect(validateGraph(nodes, edges, PROBE)).toEqual([
    'Node "d1" uses strand "Closures", which no probe question used. Valid strands: closures, scope.',
  ])
})

test('depth is the longest path from a root', () => {
  const d = depths([{ id: 'r1' }, { id: 'a' }, { id: 'b' }], [edge('r1', 'a'), edge('a', 'b'), edge('r1', 'b')])
  expect(Object.fromEntries(d)).toEqual({ r1: 0, a: 1, b: 2 })
})

const probe = (strand: string, ...results: boolean[]) => results.map(correct => ({ strand, correct }))

test.each([
  [[], 'untested'], [[true, true], 'known'], [[true, false], 'frontier'], [[false, false], 'missed'],
] as [boolean[], NodeState][])('initial state from probe evidence %j → %s', (results, expected) => {
  expect(initialState({ kind: 'derived', strands: ['a'] }, probe('a', ...results))).toBe(expected)
})

test('the goal starts untested unless fully correct', () => {
  expect(initialState({ kind: 'goal', strands: ['a'] }, probe('a', true, false))).toBe('untested')
  expect(initialState({ kind: 'goal', strands: ['a'] }, probe('a', false))).toBe('untested')
  expect(initialState({ kind: 'goal', strands: ['a'] }, probe('a', true))).toBe('known')
})

test('ignores probe items for other strands', () => {
  expect(initialState({ kind: 'derived', strands: ['a'] }, probe('b', false, false))).toBe('untested')
  expect(initialState({ kind: 'derived', strands: ['a', 'b'] }, [...probe('a', true), ...probe('b', false)])).toBe('frontier')
})

test.each([
  ['untested', false, true, 'known'], ['missed', false, true, 'known'], ['frontier', true, true, 'known'],
  ['untested', false, false, 'missed'], ['frontier', false, false, 'missed'], ['missed', false, false, 'missed'],
  ['known', true, false, 'frontier'], ['frontier', true, false, 'frontier'],
] as [NodeState, boolean, boolean, NodeState][])('%s (everKnown %s) after a check that passed=%s → %s', (state, everKnown, passed, expected) => {
  expect(afterQuizCheck(state, everKnown, passed)).toBe(expected)
})

const KNOWN_ERROR = 'A node can only become known after a passed quiz-check that is newer than its last failure.'

test('known needs a pass newer than the last failure', () => {
  const n = { state: 'frontier' as const, everKnown: false }
  expect(checkSetState(n, 'known', [])).toBe(KNOWN_ERROR)
  expect(checkSetState(n, 'known', [{ passed: true, at: 1 }, { passed: false, at: 2 }])).toBe(KNOWN_ERROR)
  expect(checkSetState(n, 'known', [{ passed: false, at: 1 }, { passed: true, at: 2 }])).toBeNull()
})

test('a node that was known can never be set to missed', () => {
  const n = { state: 'known' as const, everKnown: true }
  expect(checkSetState(n, 'missed', [])).toBe("This node was known before, so it can't go back to missed; use frontier.")
  expect(checkSetState(n, 'frontier', [])).toBeNull()
  expect(checkSetState({ state: 'frontier', everKnown: false }, 'missed', [])).toBeNull()
})

test('untested cannot be set', () => {
  expect(checkSetState({ state: 'missed', everKnown: false }, 'untested', [])).toBe("Untested means no evidence, so it can't be set.")
})

const states = (map: Record<string, NodeState>) => Object.entries(map).map(([id, state]) => ({ id, state }))

test('weak ancestors are deduplicated and most foundational first', () => {
  const nodes = states({ r: 'known', a: 'missed', b: 'untested', c: 'frontier', n: 'untested' })
  const edges = [edge('r', 'a'), edge('a', 'c'), edge('r', 'b'), edge('b', 'c'), edge('a', 'b'), edge('c', 'n')]
  expect(weakAncestors('n', nodes, edges)).toEqual([
    { id: 'a', state: 'missed' }, { id: 'b', state: 'untested' }, { id: 'c', state: 'frontier' },
  ])
})

test('no weak ancestors when every prerequisite is known', () => {
  const nodes = states({ r: 'known', a: 'known', n: 'missed' })
  expect(weakAncestors('n', nodes, [edge('r', 'a'), edge('a', 'n')])).toEqual([])
})

const graphNodes = (map: Record<string, [NodeKind, NodeState]>) =>
  Object.entries(map).map(([id, [kind, state]]) => ({ id, kind, state }))

test('next node prefers missed, then frontier, then untested', () => {
  const nodes = graphNodes({ r: ['root', 'known'], x: ['derived', 'untested'], y: ['derived', 'frontier'], z: ['derived', 'missed'], g: ['goal', 'untested'] })
  const edges = [edge('r', 'x'), edge('r', 'y'), edge('r', 'z'), edge('x', 'g'), edge('y', 'g'), edge('z', 'g')]
  expect(nextNode(nodes, edges)).toBe('z')
  expect(nextNode(nodes.filter(n => n.id !== 'z'), edges)).toBe('y')
})

test('next node prefers shallower nodes within a state', () => {
  const nodes = graphNodes({ r: ['root', 'known'], k: ['derived', 'known'], deep: ['derived', 'untested'], shallow: ['derived', 'untested'], g: ['goal', 'untested'] })
  const edges = [edge('r', 'k'), edge('k', 'deep'), edge('r', 'shallow'), edge('deep', 'g'), edge('shallow', 'g')]
  expect(nextNode(nodes, edges)).toBe('shallow')
})

test('next node skips nodes with prerequisites that are not known', () => {
  const nodes = graphNodes({ r: ['root', 'known'], a: ['derived', 'untested'], b: ['derived', 'missed'], g: ['goal', 'untested'] })
  expect(nextNode(nodes, [edge('r', 'a'), edge('a', 'b'), edge('b', 'g')])).toBe('a')
})

test('the goal comes last, and null when everything is known', () => {
  const edges = [edge('r', 'a'), edge('a', 'g')]
  expect(nextNode(graphNodes({ r: ['root', 'known'], a: ['derived', 'known'], g: ['goal', 'untested'] }), edges)).toBe('g')
  expect(nextNode(graphNodes({ r: ['root', 'known'], a: ['derived', 'known'], g: ['goal', 'known'] }), edges)).toBeNull()
})

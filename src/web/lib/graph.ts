import dagre from '@dagrejs/dagre'
import type { NodeState, StudyNode } from './api'

type Kind = StudyNode['kind']
type Edge = { from: string; to: string }

export const radius = (kind: Kind) => (kind === 'goal' ? 64 : 52)
/** Room around each circle for the root ring and the pop-out, so dagre spaces circles evenly. */
export const boxSize = (kind: Kind) => 2 * (radius(kind) + 12)

/** Top to bottom: roots at the top, the goal at the bottom. Returns each node's top-left corner. */
export function layout(nodes: { id: string; kind: Kind }[], edges: Edge[]) {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 48, ranksep: 64 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) g.setNode(n.id, { width: boxSize(n.kind), height: boxSize(n.kind) })
  for (const e of edges) g.setEdge(e.from, e.to)
  dagre.layout(g)
  return new Map(nodes.map(n => {
    const { x, y } = g.node(n.id)
    return [n.id, { x: x - boxSize(n.kind) / 2, y: y - boxSize(n.kind) / 2 }]
  }))
}

/** Changes only when the graph's structure does, so state changes recolor in place. */
export const layoutKey = (nodes: { id: string }[], edges: Edge[]) =>
  JSON.stringify([nodes.map(n => n.id).sort(), edges.map(e => `${e.from}→${e.to}`).sort()])

const STEP = 0.45

/**
 * The traveling light on hover: every line in the hovered node's ancestor subgraph, timed as a relay so
 * every branch reaches the hovered node together. A line ending k steps (longest path) away starts at (L − 1 − k) × STEP.
 */
export function lightTimings(edges: Edge[], hovered: string) {
  const into = new Map<string, Edge[]>()
  for (const e of edges) into.set(e.to, [...(into.get(e.to) ?? []), e])
  // Longest distance (in lines) from each ancestor down to the hovered node.
  const dist = new Map<string, number>([[hovered, 0]])
  const ancestorEdges: Edge[] = []
  const queue = [hovered]
  while (queue.length) {
    const node = queue.shift()!
    for (const e of into.get(node) ?? []) {
      if (!ancestorEdges.includes(e)) ancestorEdges.push(e)
      const d = dist.get(node)! + 1
      if (d > (dist.get(e.from) ?? -1)) {
        dist.set(e.from, d)
        queue.push(e.from)
      }
    }
  }
  const longest = Math.max(0, ...ancestorEdges.map(e => dist.get(e.from)!))
  const round = (s: number) => Math.round(s * 100) / 100
  return new Map(
    ancestorEdges.map(e => [`${e.from}→${e.to}`, { delay: round((longest - 1 - dist.get(e.to)!) * STEP), cycle: round(longest * STEP) }]),
  )
}

/** A character-count proxy for "doesn't fit on one line inside the circle". */
export const labelSize = (label: string, kind: Kind) => (kind === 'goal' ? (label.length > 12 ? 15 : 17) : label.length > 10 ? 13 : 15)

export const prereqText = (weak: { id: string; state: NodeState }[], nodes: { id: string; label: string }[]) =>
  weak.map(w => `${nodes.find(n => n.id === w.id)?.label ?? w.id} (${w.state})`).join(', ')

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

/** Length of a map line: React Flow's bottom-to-top bezier (curvature 0.35), sampled. */
export function lineLength(sx: number, sy: number, tx: number, ty: number) {
  const c = ty >= sy ? 0.5 * (ty - sy) : 0.35 * 25 * Math.sqrt(sy - ty)
  const at = (t: number, a: number, b: number, d: number, e: number) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * d + t ** 3 * e
  let length = 0
  for (let i = 1, x = sx, y = sy; i <= 64; i++) {
    const t = i / 64
    const [nx, ny] = [at(t, sx, sx, tx, tx), at(t, sy, sy + c, ty - c, ty)]
    length += Math.hypot(nx - x, ny - y)
    ;[x, y] = [nx, ny]
  }
  return length
}

/**
 * The traveling light toward the open node: every line in its ancestor subgraph at the same `speed`, timed as a
 * relay so every branch reaches the open node together. `lengths` are keyed `from→to`; seconds out, one shared cycle.
 */
export function lightTimings(edges: Edge[], target: string, lengths: Map<string, number>, speed: number, light: number) {
  const into = new Map<string, Edge[]>()
  for (const e of edges) into.set(e.to, [...(into.get(e.to) ?? []), e])
  const len = (e: Edge) => lengths.get(`${e.from}→${e.to}`) ?? 0
  // Longest distance (along the lines) from each ancestor down to the open node.
  const dist = new Map<string, number>([[target, 0]])
  const ancestorEdges: Edge[] = []
  const queue = [target]
  while (queue.length) {
    const node = queue.shift()!
    for (const e of into.get(node) ?? []) {
      if (!ancestorEdges.includes(e)) ancestorEdges.push(e)
      const d = dist.get(node)! + len(e)
      if (d > (dist.get(e.from) ?? -1)) {
        dist.set(e.from, d)
        queue.push(e.from)
      }
    }
  }
  const longest = Math.max(0, ...ancestorEdges.map(e => dist.get(e.from)!))
  const round = (s: number) => Math.round(s * 1000) / 1000
  // A line's light leaves its start so that its head reaches the end (longest − dist(to)) / speed after the relay starts.
  return new Map(
    ancestorEdges.map(e => [
      `${e.from}→${e.to}`,
      { delay: round((longest - dist.get(e.to)! - len(e)) / speed), duration: round((len(e) + light) / speed), cycle: round((longest + light) / speed), light },
    ]),
  )
}

/** A character-count proxy for "doesn't fit on one line inside the circle". */
export const labelSize = (label: string, kind: Kind) => (kind === 'goal' ? (label.length > 12 ? 15 : 17) : label.length > 10 ? 13 : 15)

export const prereqText = (weak: { id: string; state: NodeState }[], nodes: { id: string; label: string }[]) =>
  weak.map(w => `${nodes.find(n => n.id === w.id)?.label ?? w.id} (${w.state})`).join(', ')

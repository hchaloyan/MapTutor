export type NodeKind = 'root' | 'derived' | 'goal'
export type NodeState = 'untested' | 'missed' | 'frontier' | 'known'
export type GraphNode = { id: string; label: string; kind: NodeKind; description: string; strands: string[] }
/** `from` is a prerequisite of `to`. */
export type Edge = { from: string; to: string }

/** Kahn's algorithm. `leftover` is non-empty exactly when the edges contain a cycle. */
function topoOrder(ids: string[], edges: Edge[]) {
  const indegree = new Map(ids.map(id => [id, 0]))
  for (const e of edges) indegree.set(e.to, indegree.get(e.to)! + 1)
  const queue = ids.filter(id => indegree.get(id) === 0)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const e of edges) {
      if (e.from !== id) continue
      indegree.set(e.to, indegree.get(e.to)! - 1)
      if (indegree.get(e.to) === 0) queue.push(e.to)
    }
  }
  const done = new Set(order)
  return { order, leftover: ids.filter(id => !done.has(id)) }
}

/** Longest path from any root. Callers guarantee a DAG. */
export function depths(nodes: { id: string }[], edges: Edge[]): Map<string, number> {
  const ids = nodes.map(n => n.id)
  const depth = new Map(ids.map(id => [id, 0]))
  for (const id of topoOrder(ids, edges).order) {
    for (const e of edges) if (e.from === id) depth.set(e.to, Math.max(depth.get(e.to)!, depth.get(id)! + 1))
  }
  return depth
}

export function validateGraph(nodes: GraphNode[], edges: Edge[], probeStrands: string[]): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const n of nodes) {
    if (ids.has(n.id)) errors.push(`Duplicate node id "${n.id}".`)
    ids.add(n.id)
  }
  const valid = edges.filter(e => {
    const ok = ids.has(e.from) && ids.has(e.to)
    if (!ok) errors.push(`Edge ${e.from} → ${e.to} refers to an unknown node.`)
    return ok
  })

  const { leftover } = topoOrder([...ids], valid)
  if (leftover.length) {
    // Leftovers are cycle members plus everything downstream; peel off the downstream sinks.
    const cyclic = new Set(leftover)
    for (let changed = true; changed; ) {
      changed = false
      for (const id of cyclic) {
        if (!valid.some(e => e.from === id && cyclic.has(e.to))) {
          cyclic.delete(id)
          changed = true
        }
      }
    }
    return [...errors, `The edges form a cycle through: ${leftover.filter(id => cyclic.has(id)).join(', ')}.`]
  }

  const goals = nodes.filter(n => n.kind === 'goal')
  if (goals.length !== 1) errors.push(`There must be exactly one goal node; found ${goals.length}.`)

  const reached = new Set(nodes.filter(n => n.kind === 'root').map(n => n.id))
  for (const queue = [...reached]; queue.length; ) {
    const id = queue.shift()!
    for (const e of valid) {
      if (e.from === id && !reached.has(e.to)) {
        reached.add(e.to)
        queue.push(e.to)
      }
    }
  }

  const strands = new Set(probeStrands)
  const validStrands = [...strands].sort().join(', ') || '(none)'
  for (const n of nodes) {
    const hasPrereq = valid.some(e => e.to === n.id)
    const hasNext = valid.some(e => e.from === n.id)
    if (n.kind === 'root' && hasPrereq) errors.push(`Root "${n.id}" has a prerequisite; roots can't depend on anything.`)
    if (n.kind === 'goal' && hasNext) errors.push(`The goal "${n.id}" can't be a prerequisite of anything.`)
    if (n.kind !== 'goal' && !hasNext) errors.push(`Node "${n.id}" leads nowhere; every node except the goal needs an outgoing edge.`)
    if (!reached.has(n.id)) errors.push(`Node "${n.id}" is unreachable from every root.`)
    for (const s of n.strands) {
      if (!strands.has(s)) errors.push(`Node "${n.id}" uses strand "${s}", which no probe question used. Valid strands: ${validStrands}.`)
    }
  }
  return errors
}

export function initialState(node: { kind: NodeKind; strands: string[] }, probe: { strand: string; correct: boolean }[]): NodeState {
  const items = probe.filter(item => node.strands.includes(item.strand))
  const right = items.filter(item => item.correct).length
  if (items.length && right === items.length) return 'known'
  if (node.kind === 'goal' || !items.length) return 'untested'
  return right ? 'frontier' : 'missed'
}

/** A Known node that slips drops to frontier, never red. */
export function afterQuizCheck(_state: NodeState, everKnown: boolean, passed: boolean): NodeState {
  if (passed) return 'known'
  return everKnown ? 'frontier' : 'missed'
}

/** Guards on set_node_state. Returns the error for the tutor, or null when the change is allowed. */
export function checkSetState(
  node: { state: NodeState; everKnown: boolean },
  target: NodeState,
  checks: { passed: boolean; at: number }[],
): string | null {
  if (target === 'untested') return "Untested means no evidence, so it can't be set."
  if (target === 'missed' && node.everKnown) return "This node was known before, so it can't go back to missed; use frontier."
  if (target === 'known') {
    const last = (passed: boolean) => Math.max(-Infinity, ...checks.filter(c => c.passed === passed).map(c => c.at))
    if (last(true) <= last(false)) return 'A node can only become known after a passed quiz-check that is newer than its last failure.'
  }
  return null
}

/** Ancestors that aren't known, most foundational first, so [0] is the "Go to" target. */
export function weakAncestors(nodeId: string, nodes: { id: string; state: NodeState }[], edges: Edge[]) {
  const seen = new Set<string>()
  for (const queue = [nodeId]; queue.length; ) {
    const id = queue.shift()!
    for (const e of edges) {
      if (e.to === id && !seen.has(e.from)) {
        seen.add(e.from)
        queue.push(e.from)
      }
    }
  }
  const depth = depths(nodes, edges)
  return nodes
    .filter(n => seen.has(n.id) && n.state !== 'known')
    .sort((a, b) => depth.get(a.id)! - depth.get(b.id)!)
    .map(({ id, state }) => ({ id, state }))
}

const PRIORITY: Record<NodeState, number> = { missed: 0, frontier: 1, untested: 2, known: 3 }

export function nextNode(nodes: { id: string; kind: NodeKind; state: NodeState }[], edges: Edge[]): string | null {
  const state = new Map(nodes.map(n => [n.id, n.state]))
  const depth = depths(nodes, edges)
  const ready = nodes.filter(
    n => n.state !== 'known' && edges.every(e => e.to !== n.id || state.get(e.from) === 'known'),
  )
  const rank = (n: (typeof ready)[number]) => [n.kind === 'goal' ? 1 : 0, PRIORITY[n.state], depth.get(n.id)!]
  // Array.prototype.sort is stable, so ties keep input order.
  ready.sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)]
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]
  })
  return ready[0]?.id ?? null
}

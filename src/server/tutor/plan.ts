import type { DatabaseSync } from 'node:sqlite'
import { transaction } from '../core/db'
import { type Edge, type GraphNode, initialState, type NodeKind, type NodeState, validateGraph } from './graph'
import { probeStrands } from './quiz'
import type { ClientTool } from './tools'

type Proposal = { approach: string; nodes: GraphNode[]; edges: Edge[] }

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const KINDS: unknown[] = ['root', 'derived', 'goal']

function shapeProblems(input: unknown): string[] {
  const g = (input ?? {}) as Partial<Proposal>
  const errors: string[] = []
  if (!nonEmpty(g.approach)) errors.push('propose_graph needs an approach.')
  if (!Array.isArray(g.nodes) || !g.nodes.length) errors.push('propose_graph needs at least one node.')
  else {
    g.nodes.forEach((n: Partial<GraphNode>, i) => {
      const name = nonEmpty(n?.id) ? `Node "${n.id}"` : `Node ${i + 1}`
      if (!nonEmpty(n?.id)) errors.push(`${name} needs an id.`)
      if (!nonEmpty(n?.label)) errors.push(`${name} needs a label.`)
      if (!KINDS.includes(n?.kind)) errors.push(`${name}: kind must be root, derived, or goal.`)
      if (!nonEmpty(n?.description)) errors.push(`${name} needs a description.`)
      if (!Array.isArray(n?.strands) || !n.strands.every(s => typeof s === 'string')) errors.push(`${name}: strands must be a list of strand names.`)
    })
  }
  if (!Array.isArray(g.edges)) errors.push('propose_graph needs an edges list.')
  else g.edges.forEach((e: Partial<Edge>, i) => (nonEmpty(e?.from) && nonEmpty(e?.to)) || errors.push(`Edge ${i + 1} needs from and to node ids.`))
  return errors
}

export const proposeGraphTool: ClientTool = {
  kind: 'client',
  def: {
    name: 'propose_graph',
    description: [
      "Propose the study plan: the approach in prose and the dependency graph. Roots are unconditional truths, each derived node hangs off its prerequisites, and the user's goal is the single sink. Keep it small: few nodes, short labels.",
      'The app computes each node\'s state from the probe evidence, draws the graph, and shows an approval card. It returns { decision: "approved" } or { decision: "feedback", text } once the user responds. Calling it again replaces the graph.',
      'Node ids are short and unique within the graph; quiz-checks use them as nodeId. Every strand on a node must be the exact name of a strand used on probe questions.',
    ].join('\n\n'),
    input_schema: {
      type: 'object',
      properties: {
        approach: { type: 'string', description: 'What you will cover, in what order, and why this way. Shown above the approval card.' },
        nodes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string', description: 'About 3 words; it sits inside a small circle on the map.' },
              kind: { type: 'string', enum: ['root', 'derived', 'goal'] },
              description: { type: 'string' },
              strands: { type: 'array', items: { type: 'string' }, description: 'Probe strands that bear on this node.' },
            },
            required: ['id', 'label', 'kind', 'description', 'strands'],
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            properties: { from: { type: 'string', description: 'The prerequisite.' }, to: { type: 'string' } },
            required: ['from', 'to'],
          },
        },
      },
      required: ['approach', 'nodes', 'edges'],
    },
  },
  phases: ['probe', 'plan'],
  check(input, ctx) {
    const shape = shapeProblems(input)
    if (shape.length) return shape.join('\n')
    const g = input as Proposal
    return validateGraph(g.nodes, g.edges, probeStrands(ctx.db, ctx.studyId).map(s => s.strand)).join('\n') || null
  },
  // Replacing is safe: node threads can't exist before approval.
  onPause(input, { db, studyId }) {
    const { nodes, edges } = input as Proposal
    const probe = (
      db
        .prepare("SELECT strand, chosen_option_id = correct_option_id AS correct FROM quiz_items WHERE study_id = ? AND phase = 'probe'")
        .all(studyId) as { strand: string; correct: number }[]
    ).map(p => ({ strand: p.strand, correct: p.correct === 1 }))
    const now = Date.now()
    transaction(db, () => {
      db.prepare("UPDATE studies SET phase = 'plan' WHERE id = ?").run(studyId)
      db.prepare('DELETE FROM nodes WHERE study_id = ?').run(studyId)
      const insertNode = db.prepare(
        'INSERT INTO nodes (id, study_id, label, kind, description, strands, state, ever_known, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      for (const n of nodes) {
        const state = initialState(n, probe)
        insertNode.run(n.id, studyId, n.label, n.kind, n.description, JSON.stringify(n.strands), state, state === 'known' ? 1 : 0, now)
      }
      const insertEdge = db.prepare('INSERT OR IGNORE INTO edges (study_id, from_node, to_node) VALUES (?, ?, ?)')
      for (const e of edges) insertEdge.run(studyId, e.from, e.to)
    })
  },
  card: input => ({ approach: (input as Proposal).approach }),
  answer(input, answer, { db, studyId }) {
    const a = (answer ?? {}) as { decision?: unknown; text?: unknown }
    if (a.decision === 'approved') {
      db.prepare("UPDATE studies SET phase = 'teach', approach = ? WHERE id = ?").run((input as Proposal).approach, studyId)
      return { content: JSON.stringify({ decision: 'approved' }) }
    }
    if (a.decision !== 'feedback') return { error: 'Approve the plan or say what to change.' }
    if (!nonEmpty(a.text)) return { error: 'Say what you want changed.' }
    return { content: JSON.stringify({ decision: 'feedback', text: a.text.trim() }) }
  },
}

export type StudyNode = GraphNode & {
  state: NodeState
  everKnown: boolean
  summary: string | null
  evidence: { correct: number; total: number }
}

/** The study's graph. Evidence is derived here: probe items by strand, check items by node. */
export function loadGraph(db: DatabaseSync, studyId: string): { nodes: StudyNode[]; edges: Edge[] } {
  const rows = db
    .prepare('SELECT id, label, kind, description, strands, state, ever_known, summary FROM nodes WHERE study_id = ? ORDER BY rowid')
    .all(studyId) as { id: string; label: string; kind: NodeKind; description: string; strands: string; state: NodeState; ever_known: number; summary: string | null }[]
  const items = db
    .prepare('SELECT phase, strand, node_id, chosen_option_id = correct_option_id AS correct FROM quiz_items WHERE study_id = ?')
    .all(studyId) as { phase: 'probe' | 'check'; strand: string | null; node_id: string | null; correct: number }[]
  const nodes = rows.map(({ ever_known, strands: json, ...r }) => {
    const strands = JSON.parse(json) as string[]
    const mine = items.filter(it => (it.phase === 'probe' ? strands.includes(it.strand!) : it.node_id === r.id))
    return { ...r, strands, everKnown: ever_known === 1, evidence: { correct: mine.filter(it => it.correct === 1).length, total: mine.length } }
  })
  const edges = db.prepare('SELECT from_node AS "from", to_node AS "to" FROM edges WHERE study_id = ? ORDER BY rowid').all(studyId) as Edge[]
  return { nodes, edges }
}

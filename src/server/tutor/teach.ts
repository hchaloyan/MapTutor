import type Anthropic from '@anthropic-ai/sdk'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { recordUsage } from '../core/usage'
import type { UsageRow } from './engine'
import { isAppText } from './context'
import { checkSetState, type NodeKind, type NodeState } from './graph'
import type { ServerTool } from './tools'

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const fail = (content: string) => ({ content, isError: true })

function findNode(db: DatabaseSync, studyId: string, id: string) {
  return db.prepare('SELECT label, kind, state, ever_known FROM nodes WHERE study_id = ? AND id = ?').get(studyId, id) as
    | { label: string; kind: NodeKind; state: NodeState; ever_known: number }
    | undefined
}

/** The one place node states change after approval. The study is done once the goal is known, and stays done. */
export function setNodeState(db: DatabaseSync, studyId: string, nodeId: string, state: NodeState) {
  db.prepare('UPDATE nodes SET state = ?, ever_known = max(ever_known, ?), updated_at = ? WHERE study_id = ? AND id = ?').run(
    state, state === 'known' ? 1 : 0, Date.now(), studyId, nodeId,
  )
  if (state === 'known' && findNode(db, studyId, nodeId)?.kind === 'goal') {
    db.prepare("UPDATE studies SET phase = 'done' WHERE id = ? AND phase = 'teach'").run(studyId)
  }
}

export const focusNodeTool: ServerTool = {
  kind: 'server',
  def: {
    name: 'focus_node',
    description:
      "Open a node's thread and continue the lesson there. Call it before teaching a node. Each node has its own thread, which sees only its own history plus the study state. The app highlights the node for the user.",
    shape: { nodeId: z.string() },
  },
  phases: ['teach', 'done'],
  run(input, { db, studyId, nodeId }) {
    const id = (input as { nodeId?: unknown } | null)?.nodeId
    if (!nonEmpty(id)) return fail('focus_node needs a nodeId.')
    const target = findNode(db, studyId, id)
    if (!target) return fail(`Node "${id}" is not in this study.`)
    // A pending tool_use there must be answered before anything else is appended.
    if (id !== nodeId && db.prepare('SELECT 1 FROM messages WHERE study_id = ? AND node_id = ? AND pending = 1').get(studyId, id)) {
      return fail(`Node "${id}"'s thread is waiting for the user to answer a card there. Keep teaching here, or ask the user to open that node.`)
    }
    db.prepare('UPDATE studies SET focus_node_id = ? WHERE id = ?').run(id, studyId)
    if (id === nodeId) return { content: `Already in node "${id}"'s thread.` }
    return {
      content: `Opened node "${id}"'s thread. The lesson continues there.`,
      switchTo: { nodeId: id, note: `[App: focus_node opened this thread. Continue the lesson for "${target.label}" here.]` },
    }
  },
}

const SETTABLE: unknown[] = ['missed', 'frontier', 'known']

export const setNodeStateTool: ServerTool = {
  kind: 'server',
  def: {
    name: 'set_node_state',
    description:
      "Adjust a node's state when the conversation shows something the quiz-checks didn't, for example a gap that came up mid-lesson (frontier). Quiz-checks already set states, so most nodes never need this. Known needs a passed quiz-check on the node that is newer than its last failure. A node that was ever known can't go back to missed; use frontier.",
    shape: { nodeId: z.string(), state: z.enum(['missed', 'frontier', 'known']), reason: z.string().describe('What the conversation showed.') },
  },
  phases: ['teach', 'done'],
  run(input, { db, studyId }) {
    const { nodeId: id, state, reason } = (input ?? {}) as { nodeId?: unknown; state?: unknown; reason?: unknown }
    if (!nonEmpty(id) || !SETTABLE.includes(state) || !nonEmpty(reason)) {
      return fail('set_node_state needs a nodeId, a state (missed, frontier, or known), and a reason.')
    }
    const node = findNode(db, studyId, id)
    if (!node) return fail(`Node "${id}" is not in this study.`)
    const checks = (
      db
        .prepare(
          `SELECT min(chosen_option_id = correct_option_id) AS passed, max(answered_at) AS at
           FROM quiz_items WHERE study_id = ? AND node_id = ? AND phase = 'check' GROUP BY quiz_call_id`,
        )
        .all(studyId, id) as { passed: number; at: number }[]
    ).map(c => ({ passed: c.passed === 1, at: c.at }))
    const problem = checkSetState({ state: node.state, everKnown: node.ever_known === 1 }, state as NodeState, checks)
    if (problem) return fail(problem)
    setNodeState(db, studyId, id, state as NodeState)
    return { content: `Node "${id}" is now ${state}.` }
  },
}

export type Summarize = (transcript: string, onUsage?: (u: UsageRow) => void) => Promise<string>

/** The node, what it builds on, and the user and tutor text of its thread. Empty when the thread has no text. */
function transcript(db: DatabaseSync, studyId: string, node: { id: string; label: string; description: string }) {
  const rows = db
    .prepare('SELECT role, content FROM messages WHERE study_id = ? AND node_id = ? ORDER BY created_at, rowid')
    .all(studyId, node.id) as { role: 'user' | 'assistant'; content: string }[]
  const lines = rows.flatMap(r =>
    (JSON.parse(r.content) as Anthropic.Beta.BetaContentBlockParam[]).flatMap(b =>
      b.type === 'text' && !isAppText(b) ? [`${r.role === 'user' ? 'User' : 'Tutor'}: ${b.text}`] : [],
    ),
  )
  if (!lines.length) return ''
  const prereqs = (
    db
      .prepare('SELECT n.label FROM edges e JOIN nodes n ON n.study_id = e.study_id AND n.id = e.from_node WHERE e.study_id = ? AND e.to_node = ? ORDER BY e.rowid')
      .all(studyId, node.id) as { label: string }[]
  ).map(p => p.label)
  return [`Node: ${node.label} — ${node.description}`, ...(prereqs.length ? [`Builds on: ${prereqs.join(', ')}`] : []), '', ...lines].join('\n')
}

/** One side call per node that has been known, has no summary yet, and has a thread to summarize. */
export async function summarizeNew(db: DatabaseSync, studyId: string, summarize: Summarize) {
  const nodes = db
    .prepare('SELECT id, label, description FROM nodes WHERE study_id = ? AND ever_known = 1 AND summary IS NULL ORDER BY rowid')
    .all(studyId) as { id: string; label: string; description: string }[]
  const { projectId } = db.prepare('SELECT project_id AS projectId FROM studies WHERE id = ?').get(studyId) as { projectId: string }
  for (const node of nodes) {
    const text = transcript(db, studyId, node)
    if (!text) continue
    const summary = (await summarize(text, u => recordUsage(db, projectId, studyId, u))).trim()
    if (summary) db.prepare('UPDATE nodes SET summary = ? WHERE study_id = ? AND id = ? AND summary IS NULL').run(summary, studyId, node.id)
  }
}

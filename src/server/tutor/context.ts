import type Anthropic from '@anthropic-ai/sdk'
import type { DatabaseSync } from 'node:sqlite'
import { mediaType } from '../routes/files'
import { nextNode, weakAncestors } from './graph'
import { loadGraph } from './plan'
import { probeStrands } from './quiz'

type ContentBlock = Anthropic.Beta.BetaContentBlockParam

export function fileBlocks(db: DatabaseSync, projectId: string): ContentBlock[] {
  const files = db
    .prepare('SELECT kind, name, data, text_cache AS text FROM files WHERE project_id = ? ORDER BY created_at, rowid')
    .all(projectId) as { kind: string; name: string; data: Uint8Array | null; text: string | null }[]
  return files.map((f): ContentBlock => {
    const data = f.data ? Buffer.from(f.data).toString('base64') : ''
    if (f.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: f.name }
    if (f.kind === 'image') {
      const media_type = mediaType(f) as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
      return { type: 'image', source: { type: 'base64', media_type, data } }
    }
    return { type: 'text', text: `<file name="${f.name}">\n${f.text ?? ''}\n</file>` }
  })
}

function strandLine(db: DatabaseSync, studyId: string, phase: string) {
  const strands = probeStrands(db, studyId)
  return ['probe', 'plan'].includes(phase) && strands.length
    ? [`Strands used so far (reuse these exact names): ${strands.map(s => s.strand).join(', ')}`]
    : []
}

type Graph = ReturnType<typeof loadGraph>

function graphLines({ nodes, edges }: Graph) {
  if (!nodes.length) return []
  return [
    'Graph:',
    ...nodes.map(n => {
      const prereqs = edges.filter(e => e.to === n.id).map(e => e.from).join(', ') || 'none'
      return `- ${n.id} [${n.kind}] "${n.label}" — ${n.state} (${n.evidence.correct}/${n.evidence.total} correct); prerequisites: ${prereqs}`
    }),
    `Next node: ${nextNode(nodes, edges) ?? 'none'}`,
  ]
}

/** Node threads never see the main thread, so their state carries the approach and the node's weak prerequisites. */
function teachLines(study: { phase: string; approach: string | null }, { nodes, edges }: Graph, nodeId: string | null) {
  if (study.phase !== 'teach' && study.phase !== 'done') return []
  const summaries = nodes.filter(n => n.summary).map(n => `- ${n.id}: ${n.summary}`)
  const node = nodes.find(n => n.id === nodeId)
  const weak = node && (weakAncestors(node.id, nodes, edges).map(w => `${w.id} (${w.state})`).join(', ') || 'none')
  return [
    ...(summaries.length ? ['Summaries of known nodes:', ...summaries] : []),
    ...(node ? [`This node: ${node.description}`, `Weak prerequisites: ${weak}`, `Approach: ${study.approach}`] : []),
  ]
}

/** Text the app writes into user messages (state blocks, notes); the user never sees it. */
export const isAppText = (b: { type: string; text?: string }) =>
  b.type === 'text' && !!b.text && (b.text.startsWith('<study_state>') || b.text.startsWith('[App:'))

export function studyStateText(db: DatabaseSync, studyId: string, nodeId: string | null, allowedTools: string[]): string {
  const study = db.prepare('SELECT goal, phase, approach FROM studies WHERE id = ?').get(studyId) as { goal: string; phase: string; approach: string | null }
  const graph = loadGraph(db, studyId)
  return [
    '<study_state>',
    `Goal: ${study.goal}`,
    `Phase: ${study.phase}`,
    `Thread: ${nodeId ? `node ${nodeId}` : 'main'}`,
    `Tools allowed now: ${allowedTools.join(', ')}`,
    ...strandLine(db, studyId, study.phase),
    ...graphLines(graph),
    ...teachLines(study, graph, nodeId),
    '</study_state>',
  ].join('\n')
}

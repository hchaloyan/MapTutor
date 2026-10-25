import type Anthropic from '@anthropic-ai/sdk'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { FILES_DIR, MAX_ATTACHED_BYTES, ON_DEMAND_BYTES } from '../core/config'
import { filePath, mediaType } from '../routes/files'
import { nextNode, weakAncestors } from './graph'
import { loadGraph } from './plan'
import { probeStrands } from './quiz'

type ContentBlock = Anthropic.Beta.BetaContentBlockParam

/** Read may open only this project's copies, nothing else on the machine. */
export function canRead(projectId: string, input: unknown) {
  const path = (input as { file_path?: unknown } | null)?.file_path
  if (typeof path !== 'string') return false
  const rel = relative(join(FILES_DIR, projectId), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Files attach in upload order up to the budget; big ones are copied to disk and listed for Read instead. */
export function fileBlocks(db: DatabaseSync, projectId: string): ContentBlock[] {
  const files = db
    .prepare('SELECT id, kind, name, data, text_cache AS text FROM files WHERE project_id = ? ORDER BY created_at, rowid')
    .all(projectId) as { id: string; kind: string; name: string; data: Uint8Array | null; text: string | null }[]
  let attached = 0
  return files.map((f): ContentBlock => {
    const size = f.data ? f.data.length : Buffer.byteLength(f.text ?? '')
    if (size > ON_DEMAND_BYTES || attached + size > MAX_ATTACHED_BYTES) {
      // Rewritten for every new thread, so a refreshed URL is never stale.
      const path = filePath(projectId, f)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, f.data ?? f.text ?? '')
      const mb = (size / 1024 / 1024).toFixed(1)
      return {
        type: 'text',
        text: `<file name="${f.name}" size="${mb} MB" path="${path}">Too large to attach. Open it with the Read tool when you need it; for a PDF, pass \`pages\`, at most 20 pages per call.</file>`,
      }
    }
    attached += size
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

import type Anthropic from '@anthropic-ai/sdk'
import type { DatabaseSync } from 'node:sqlite'
import { TUTOR_MODEL } from '../core/config'
import { mediaType } from '../routes/files'
import { systemPrompt } from './prompt'
import { nextNode, weakAncestors } from './graph'
import { loadGraph } from './plan'
import { probeStrands } from './quiz'

type ContentBlock = Anthropic.Beta.BetaContentBlockParam
type MessageParam = Anthropic.Beta.BetaUserMessageParam | Anthropic.Beta.BetaAssistantMessageParam
export type { BetaMessageStreamParams as MessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { BetaMessageStreamParams as MessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages'

const CACHE = { type: 'ephemeral', ttl: '1h' } as const

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

export function threadMessages(db: DatabaseSync, studyId: string, nodeId: string | null): MessageParam[] {
  return (
    db
      .prepare('SELECT role, content FROM messages WHERE study_id = ? AND node_id IS ? ORDER BY created_at, rowid')
      .all(studyId, nodeId) as { role: 'user' | 'assistant'; content: string }[]
  ).map(row => ({ role: row.role, content: JSON.parse(row.content) }))
}

/** Copies the message with a cache breakpoint on its last block; stored rows are never touched. */
function withBreakpoint(message: MessageParam): MessageParam {
  const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : (message.content ?? [])
  return { ...message, content: content.map((b, i) => (i === content.length - 1 ? { ...b, cache_control: CACHE } : b)) as ContentBlock[] }
}

export function buildRequest(
  db: DatabaseSync,
  studyId: string,
  nodeId: string | null,
  tools: Anthropic.Beta.BetaToolUnion[],
): MessageStreamParams {
  const { projectId, searchCap } = db.prepare('SELECT project_id AS projectId, search_cap AS searchCap FROM studies WHERE id = ?').get(studyId) as {
    projectId: string
    searchCap: number
  }
  const files = fileBlocks(db, projectId)
  const thread = threadMessages(db, studyId, nodeId)
  const messages: MessageParam[] = [...(files.length ? [withBreakpoint({ role: 'user', content: files })] : []), ...thread]
  if (thread.length) messages[messages.length - 1] = withBreakpoint(messages[messages.length - 1])
  return {
    model: TUTOR_MODEL,
    max_tokens: 64000,
    betas: ['thinking-binding-controls-2026-08-01', 'server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    output_config: { effort: 'high' },
    system: [{ type: 'text', text: systemPrompt(), cache_control: CACHE }],
    tools: [...tools, { type: 'web_search_20260209', name: 'web_search', max_uses: searchCap }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    messages,
  }
}

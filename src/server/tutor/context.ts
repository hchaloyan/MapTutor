import type Anthropic from '@anthropic-ai/sdk'
import type { DatabaseSync } from 'node:sqlite'
import { TUTOR_MODEL, WEB_SEARCH_MAX_USES } from '../core/config'
import { mediaType } from '../routes/files'
import { systemPrompt } from './prompt'
import { nextNode } from './graph'
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

function graphLines(db: DatabaseSync, studyId: string) {
  const { nodes, edges } = loadGraph(db, studyId)
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

export function studyStateText(db: DatabaseSync, studyId: string, nodeId: string | null, allowedTools: string[]): string {
  const study = db.prepare('SELECT goal, phase FROM studies WHERE id = ?').get(studyId) as { goal: string; phase: string }
  return [
    '<study_state>',
    `Goal: ${study.goal}`,
    `Phase: ${study.phase}`,
    `Thread: ${nodeId ? `node ${nodeId}` : 'main'}`,
    `Tools allowed now: ${allowedTools.join(', ')}`,
    ...strandLine(db, studyId, study.phase),
    ...graphLines(db, studyId),
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
  const { projectId } = db.prepare('SELECT project_id AS projectId FROM studies WHERE id = ?').get(studyId) as { projectId: string }
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
    tools: [...tools, { type: 'web_search_20260209', name: 'web_search', max_uses: WEB_SEARCH_MAX_USES }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    messages,
  }
}

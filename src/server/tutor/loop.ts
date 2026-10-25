import type Anthropic from '@anthropic-ai/sdk'
import type { DatabaseSync } from 'node:sqlite'
import { buildRequest, type MessageStreamParams, studyStateText } from './context'
import { allowedTools, type Phase, TOOLS, type ToolCtx } from './tools'

export type StreamMessage = (
  params: MessageStreamParams,
  apiKey: string,
  onText: (delta: string) => void,
) => Promise<Anthropic.Beta.BetaMessage>
export type Emit = (event: 'text' | 'card' | 'error' | 'done', data: object) => void

export const MAX_STEPS = 20

const phaseOf = (db: DatabaseSync, studyId: string) =>
  (db.prepare('SELECT phase FROM studies WHERE id = ?').get(studyId) as { phase: Phase }).phase

function insertMessage(db: DatabaseSync, studyId: string, nodeId: string | null, role: 'user' | 'assistant', content: unknown, pending = 0) {
  db.prepare('INSERT INTO messages (id, study_id, node_id, role, content, pending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    crypto.randomUUID(), studyId, nodeId, role, JSON.stringify(content), pending, Date.now(),
  )
}

/** Appends a user message with the current study state as its last block. Never edits earlier rows. */
export function appendUserMessage(db: DatabaseSync, studyId: string, nodeId: string | null, content: Anthropic.Beta.BetaContentBlockParam[]) {
  const state = studyStateText(db, studyId, nodeId, allowedTools(phaseOf(db, studyId)))
  insertMessage(db, studyId, nodeId, 'user', [...content, { type: 'text', text: state }])
}

export function pendingCard(db: DatabaseSync, studyId: string, nodeId: string | null) {
  const row = db
    .prepare('SELECT id, content FROM messages WHERE study_id = ? AND node_id IS ? AND pending = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(studyId, nodeId) as { id: string; content: string } | undefined
  if (!row) return null
  const toolUse = (JSON.parse(row.content) as Anthropic.Beta.BetaContentBlock[]).find(
    (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
  )
  return toolUse ? { messageId: row.id, toolUse } : null
}

export function clearPending(db: DatabaseSync, messageId: string) {
  db.prepare('UPDATE messages SET pending = 0 WHERE id = ?').run(messageId)
}

/** Runs the tutor from the thread's current state until it ends, pauses on a card, or fails. Model errors propagate. */
export async function runTurn(opts: {
  db: DatabaseSync
  studyId: string
  nodeId: string | null
  apiKey: string
  streamMessage: StreamMessage
  emit: Emit
}) {
  const { db, studyId, nodeId, emit } = opts
  const ctx: ToolCtx = { db, studyId, nodeId }
  const fail = (message: string) => {
    emit('error', { message })
    emit('done', { awaiting: false })
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    const request = buildRequest(db, studyId, nodeId, TOOLS.map(t => t.def))
    const message = await opts.streamMessage(request, opts.apiKey, delta => emit('text', { delta }))
    const toolUse = message.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    const tool = toolUse && TOOLS.find(t => t.def.name === toolUse.name)
    const phase = phaseOf(db, studyId)
    const allowed = !!tool && tool.phases.includes(phase)
    const checkError = tool?.kind === 'client' && allowed ? tool.check(toolUse.input, ctx) : null
    const pause = message.stop_reason === 'tool_use' && tool?.kind === 'client' && allowed && checkError === null

    if (pause) tool.onPause?.(toolUse!.input, ctx)
    insertMessage(db, studyId, nodeId, 'assistant', message.content, pause ? 1 : 0)

    if (message.stop_reason === 'pause_turn') continue
    if (message.stop_reason === 'refusal') return fail('The tutor declined to answer that. Try rephrasing.')
    if (message.stop_reason === 'max_tokens') return fail('The reply was too long and got cut off.')
    if (message.stop_reason !== 'tool_use' || !toolUse) return emit('done', { awaiting: false })

    if (pause) {
      emit('card', { toolUseId: toolUse.id, name: toolUse.name, input: tool.card(toolUse.input, ctx, false) })
      return emit('done', { awaiting: true })
    }
    const result = !tool
      ? { content: `Unknown tool \`${toolUse.name}\`.`, isError: true }
      : !allowed
        ? { content: `\`${toolUse.name}\` isn't available in the ${phase} phase.`, isError: true }
        : tool.kind === 'server'
          ? tool.run(toolUse.input, ctx)
          : { content: checkError!, isError: true }
    appendUserMessage(db, studyId, nodeId, [
      { type: 'tool_result', tool_use_id: toolUse.id, content: result.content, ...(result.isError && { is_error: true }) },
    ])
  }
  fail('The tutor took too many steps. Send a message to continue.')
}

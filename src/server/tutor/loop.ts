import type Anthropic from '@anthropic-ai/sdk'
import type { DatabaseSync } from 'node:sqlite'
import { recordUsage } from '../core/usage'
import { fileBlocks, studyStateText } from './context'
import type { Block, Decision, RunHop, ToolOutcome } from './engine'
import { allowedTools, type ClientTool, type Phase, TOOLS, type ToolCtx } from './tools'

export type Emit = (event: 'text' | 'status' | 'card' | 'focus' | 'error' | 'done', data: object) => void

export const MAX_STEPS = 20 // hops per turn

const RETRY_NOTE = '[App: Your last reply did not arrive. Reply to the thread as it stands.]'

const phaseOf = (db: DatabaseSync, studyId: string) =>
  (db.prepare('SELECT phase FROM studies WHERE id = ?').get(studyId) as { phase: Phase }).phase

const stateText = (db: DatabaseSync, studyId: string, nodeId: string | null) =>
  studyStateText(db, studyId, nodeId, allowedTools(phaseOf(db, studyId)))

function insertMessage(db: DatabaseSync, studyId: string, nodeId: string | null, role: 'user' | 'assistant', content: unknown, pending = 0) {
  db.prepare('INSERT INTO messages (id, study_id, node_id, role, content, pending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    crypto.randomUUID(), studyId, nodeId, role, JSON.stringify(content), pending, Date.now(),
  )
}

/** Appends a user message with the current study state as its last block. Never edits earlier rows. */
export function appendUserMessage(db: DatabaseSync, studyId: string, nodeId: string | null, content: Block[]) {
  insertMessage(db, studyId, nodeId, 'user', [...content, { type: 'text', text: stateText(db, studyId, nodeId) }])
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

/** A tool_result's text: its string content, or its first text block. */
export const resultText = (b: Anthropic.Beta.BetaToolResultBlockParam): string =>
  typeof b.content === 'string' ? b.content : ((b.content?.find(c => c.type === 'text') as { text: string } | undefined)?.text ?? '')

/** The first block of `type` in the thread's rows whose `key` is `id`, and its row. */
function findBlock<T>(db: DatabaseSync, studyId: string, nodeId: string | null, type: 'tool_use' | 'tool_result', id: string) {
  const row = db
    .prepare(
      `SELECT m.id, m.pending, b.value AS block FROM messages m, json_each(m.content) b
       WHERE m.study_id = ? AND m.node_id IS ? AND json_extract(b.value, '$.type') = ? AND json_extract(b.value, ?) = ?`,
    )
    .get(studyId, nodeId, type, type === 'tool_use' ? '$.id' : '$.tool_use_id', id) as { id: string; pending: number; block: string } | undefined
  return row && { rowId: row.id, pending: row.pending === 1, block: JSON.parse(row.block) as T }
}

const threadSession = (db: DatabaseSync, studyId: string, nodeId: string | null) =>
  (
    (nodeId
      ? db.prepare('SELECT session_id FROM nodes WHERE study_id = ? AND id = ?').get(studyId, nodeId)
      : db.prepare('SELECT session_id FROM studies WHERE id = ?').get(studyId)) as { session_id: string | null }
  ).session_id

function setThreadSession(db: DatabaseSync, studyId: string, nodeId: string | null, sessionId: string) {
  if (nodeId) db.prepare('UPDATE nodes SET session_id = ? WHERE study_id = ? AND id = ? AND session_id IS NULL').run(sessionId, studyId, nodeId)
  else db.prepare('UPDATE studies SET session_id = ? WHERE id = ? AND session_id IS NULL').run(sessionId, studyId)
}

const isClient = (name: string | undefined) => TOOLS.some(t => t.kind === 'client' && t.def.name === name)

/** Retry resumes a card answer that is the thread's last row; anything else asks the tutor to reply again. */
export function retryPrompt(db: DatabaseSync, studyId: string, nodeId: string | null): Block[] | null {
  const last = db
    .prepare('SELECT content FROM messages WHERE study_id = ? AND node_id IS ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(studyId, nodeId) as { content: string } | undefined
  const result = last && (JSON.parse(last.content) as Block[]).find(b => b.type === 'tool_result')
  if (result && isClient(findBlock<{ name: string }>(db, studyId, nodeId, 'tool_use', result.tool_use_id)?.block.name)) return null
  return [{ type: 'text', text: RETRY_NOTE }]
}

/**
 * Runs the tutor from the thread's current state until it ends, defers on a card, or fails. Engine errors propagate.
 * Each hop is one run of one thread's session; `prompt` null resumes the session's deferred card call.
 * focus_node ends a hop and the next one continues in that node's thread; a `focus` event tells the client.
 * An aborted `signal` (Stop) keeps the text streamed so far and starts no further hop.
 */
export async function runTurn(opts: {
  db: DatabaseSync
  studyId: string
  nodeId: string | null
  prompt: Block[] | null
  runHop: RunHop
  emit: Emit
  signal?: AbortSignal
}) {
  const { db, studyId, emit, runHop, signal } = opts
  let nodeId = opts.nodeId
  let prompt = opts.prompt
  const { projectId } = db.prepare('SELECT project_id AS projectId FROM studies WHERE id = ?').get(studyId) as { projectId: string }
  const fail = (message: string) => {
    emit('error', { message })
    emit('done', { awaiting: false })
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) return emit('done', { awaiting: false })
    const thread = nodeId
    const ctx: ToolCtx = { db, studyId, nodeId: thread }
    const sessionId = threadSession(db, studyId, thread)
    // The mirror row is the prompt and study state; the session also gets the project files on its first prompt.
    const shown: Block[] | null = prompt && [...prompt, { type: 'text', text: stateText(db, studyId, thread) }]
    const sent = shown && [...(sessionId ? [] : fileBlocks(db, projectId)), ...shown]
    let streamed = '' // text since the last assistant message, kept if the hop is stopped
    let switchTo: { nodeId: string; note: string } | undefined

    const decide = (name: string, input: unknown, toolUseId: string): Decision => {
      const tool = TOOLS.find(t => t.def.name === name)
      if (!tool) return { kind: 'deny', reason: `Unknown tool \`${name}\`.` }
      // A card that was already shown is settled first: its answer may have changed the phase (approval → teach).
      if (tool.kind === 'client') {
        const stored = findBlock<Anthropic.Beta.BetaToolResultBlockParam>(db, studyId, thread, 'tool_result', toolUseId)
        if (stored) return { kind: 'answer', outcome: { content: [resultText(stored.block), stateText(db, studyId, thread)] } }
        if (findBlock(db, studyId, thread, 'tool_use', toolUseId)?.pending) return { kind: 'defer' }
      }
      const phase = phaseOf(db, studyId)
      if (!tool.phases.includes(phase)) return { kind: 'deny', reason: `\`${name}\` isn't available in the ${phase} phase.` }
      if (tool.kind === 'server') return { kind: 'run' }
      const problem = tool.check(input, ctx)
      return problem ? { kind: 'deny', reason: problem } : { kind: 'defer' }
    }
    const run = (name: string, input: unknown): ToolOutcome => {
      const tool = TOOLS.find(t => t.def.name === name)!
      // A card batched with another call can't defer (the SDK runs it), so the tutor is told to call it alone.
      if (tool.kind === 'client') return { content: [`Call \`${name}\` on its own, with no other tool call in the same message.`], isError: true }
      const r = tool.run(input, ctx)
      if (r.switchTo) switchTo = r.switchTo
      return { content: [r.content, stateText(db, studyId, thread)], ...(r.isError && { isError: true }), ...(r.switchTo && { stop: true }) }
    }

    const result = await runHop({
      sessionId,
      prompt: sent,
      decide,
      run,
      onSession: id => {
        setThreadSession(db, studyId, thread, id)
        if (shown) insertMessage(db, studyId, thread, 'user', shown)
      },
      onMessage: (role, content) => {
        if (role === 'assistant') {
          streamed = ''
          return insertMessage(db, studyId, thread, 'assistant', content)
        }
        // The route stores a card answer before the resume; the engine reports it again.
        const fresh = content.filter(b => b.type !== 'tool_result' || !findBlock(db, studyId, thread, 'tool_result', b.tool_use_id))
        if (fresh.length) insertMessage(db, studyId, thread, 'user', fresh)
      },
      onText: delta => {
        streamed += delta
        emit('text', { delta })
      },
      onStatus: kind => emit('status', { kind }),
      signal,
    })
    for (const row of result.usage) recordUsage(db, projectId, studyId, row)

    switch (result.stop) {
      case 'deferred': {
        const { id, name, input } = result.deferred!
        const tool = TOOLS.find(t => t.def.name === name) as ClientTool
        const row = findBlock(db, studyId, thread, 'tool_use', id)!
        // Card side effects run once, for a call that really became a card.
        if (!row.pending) tool.onPause?.(input, ctx)
        db.prepare('UPDATE messages SET pending = 1 WHERE id = ?').run(row.rowId)
        emit('card', { toolUseId: id, name, input: tool.card(input, ctx, false) })
        return emit('done', { awaiting: true })
      }
      case 'switched':
        nodeId = switchTo!.nodeId
        emit('focus', { nodeId })
        prompt = [{ type: 'text', text: switchTo!.note }]
        continue
      case 'nothing_deferred':
        prompt = [{ type: 'text', text: RETRY_NOTE }]
        continue
      case 'refusal':
        return fail('The tutor declined to answer that. Try rephrasing.')
      case 'max_tokens':
        return fail('The reply was too long and got cut off.')
      case 'max_turns':
        return fail('The tutor took too many steps. Send a message to continue.')
      case 'stopped':
        // Appending what streamed is still append-only; the session keeps its own copy of the cut-off reply.
        if (streamed) insertMessage(db, studyId, thread, 'assistant', [{ type: 'text', text: streamed }])
        return emit('done', { awaiting: false })
      case 'end_turn':
        return emit('done', { awaiting: false })
    }
  }
  fail('The tutor took too many steps. Send a message to continue.')
}

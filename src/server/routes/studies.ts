import type Anthropic from '@anthropic-ai/sdk'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { anthropicError, apiKey } from '../core/anthropic'
import { httpError } from '../core/http'
import { loadGraph } from '../tutor/plan'
import { probeStrands } from '../tutor/quiz'
import { type Phase, TOOLS, type ToolCtx } from '../tutor/tools'
import { appendUserMessage, clearPending, type Emit, runTurn, type StreamMessage } from '../tutor/loop'

type Block = Anthropic.Beta.BetaContentBlock | Anthropic.Beta.BetaContentBlockParam
type Row = { id: string; node_id: string | null; role: 'user' | 'assistant'; content: string; pending: number; created_at: number }

export type ThreadItem =
  | { type: 'user' | 'assistant'; text: string; createdAt: number }
  | { type: 'card'; toolUseId: string; name: string; input: unknown; answer: unknown; pending: boolean; createdAt: number }

const isState = (b: Block) => b.type === 'text' && b.text.startsWith('<study_state>')

function requireStudy(db: DatabaseSync, id: string) {
  const study = db.prepare('SELECT id, project_id AS projectId, goal, phase, approach FROM studies WHERE id = ?').get(id)
  if (!study) throw httpError(404, 'Study not found.')
  return study as { id: string; projectId: string; goal: string; phase: Phase; approach: string | null }
}

function requireNode(db: DatabaseSync, studyId: string, nodeId: string | null) {
  if (nodeId && !db.prepare('SELECT 1 FROM nodes WHERE id = ? AND study_id = ?').get(nodeId, studyId)) throw httpError(404, 'Node not found.')
}

const clientTool = (name: string) => TOOLS.find(t => t.kind === 'client' && t.def.name === name)

/** What the client renders for one thread: user and assistant text, and cards with their answers. */
function threadView(db: DatabaseSync, studyId: string, nodeId: string | null): ThreadItem[] {
  const rows = db
    .prepare('SELECT id, node_id, role, content, pending, created_at FROM messages WHERE study_id = ? AND node_id IS ? ORDER BY created_at, rowid')
    .all(studyId, nodeId) as Row[]
  const parsed = rows.map(r => ({ ...r, blocks: JSON.parse(r.content) as Block[] }))
  const results = new Map<string, Anthropic.Beta.BetaToolResultBlockParam>()
  for (const r of parsed) for (const b of r.blocks) if (b.type === 'tool_result') results.set(b.tool_use_id, b)
  const ctx: ToolCtx = { db, studyId, nodeId }

  return parsed.flatMap(r =>
    r.blocks.flatMap((b): ThreadItem[] => {
      const createdAt = r.created_at
      if (b.type === 'text' && !isState(b)) return [{ type: r.role, text: b.text, createdAt }]
      if (b.type !== 'tool_use') return []
      const tool = clientTool(b.name)
      const result = results.get(b.id)
      if (tool?.kind !== 'client' || (!r.pending && (!result || result.is_error))) return []
      const answer = result && typeof result.content === 'string' ? JSON.parse(result.content) : null
      return [{ type: 'card', toolUseId: b.id, name: b.name, input: tool.card(b.input, ctx, !!answer), answer, pending: r.pending === 1, createdAt }]
    }),
  )
}

export function studyRoutes(app: FastifyInstance, opts: { db: DatabaseSync; streamMessage: StreamMessage }) {
  const { db, streamMessage } = opts
  // ponytail: in-memory per-thread lock; holds only while one server process owns the database
  const running = new Set<string>()
  const threadKey = (studyId: string, nodeId: string | null) => `${studyId}:${nodeId ?? ''}`

  function lock(studyId: string, nodeId: string | null) {
    const key = threadKey(studyId, nodeId)
    if (running.has(key)) throw httpError(409, 'The tutor is still replying.')
    running.add(key)
    return () => running.delete(key)
  }

  async function stream(reply: FastifyReply, release: () => void, run: (emit: Emit) => Promise<void>) {
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    // A closed tab doesn't stop the turn: state stays consistent and the thread shows the reply on reload.
    const emit: Emit = (event, data) => {
      if (!reply.raw.destroyed) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    try {
      await run(emit)
    } catch (err) {
      const mapped = anthropicError(err)
      if (!mapped) app.log.error(err)
      emit('error', { message: mapped?.message ?? 'Something went wrong on the server.' })
      emit('done', { awaiting: false })
    } finally {
      release()
      reply.raw.end()
    }
  }

  app.get<{ Params: { id: string } }>('/api/studies/:id', async req => ({
    ...requireStudy(db, req.params.id),
    ...loadGraph(db, req.params.id),
    strands: probeStrands(db, req.params.id),
  }))

  app.get<{ Params: { id: string }; Querystring: { nodeId?: string } }>('/api/studies/:id/thread', async req => {
    requireStudy(db, req.params.id)
    const nodeId = req.query.nodeId || null
    requireNode(db, req.params.id, nodeId)
    return threadView(db, req.params.id, nodeId)
  })

  app.post<{ Params: { id: string }; Body: { text: string; nodeId?: string } }>(
    '/api/studies/:id/messages',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string', minLength: 1, maxLength: 20000 }, nodeId: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const key = apiKey(req)
      const studyId = req.params.id
      const { phase } = requireStudy(db, studyId)
      const nodeId = req.body.nodeId || null
      requireNode(db, studyId, nodeId)
      if (nodeId && (phase === 'probe' || phase === 'plan')) throw httpError(409, 'Node threads open once the plan is approved.')
      const text = req.body.text.trim()
      if (!text) throw httpError(400, "Message can't be blank.")
      const release = lock(studyId, nodeId)
      if (db.prepare('SELECT 1 FROM messages WHERE study_id = ? AND node_id IS ? AND pending = 1').get(studyId, nodeId)) {
        release()
        throw httpError(409, 'Answer the card first.')
      }
      appendUserMessage(db, studyId, nodeId, [{ type: 'text', text }])
      return stream(reply, release, emit => runTurn({ db, studyId, nodeId, apiKey: key, streamMessage, emit }))
    },
  )

  app.post<{ Params: { id: string }; Body: { toolUseId: string; answer: unknown } }>(
    '/api/studies/:id/tool-results',
    {
      schema: {
        body: { type: 'object', required: ['toolUseId', 'answer'], properties: { toolUseId: { type: 'string' }, answer: {} } },
      },
    },
    async (req, reply) => {
      const key = apiKey(req)
      const studyId = req.params.id
      requireStudy(db, studyId)
      const pending = (db.prepare('SELECT id, node_id, content FROM messages WHERE study_id = ? AND pending = 1').all(studyId) as Row[])
        .map(r => ({ ...r, toolUse: (JSON.parse(r.content) as Block[]).find(b => b.type === 'tool_use' && b.id === req.body.toolUseId) }))
        .find(r => r.toolUse)
      const toolUse = pending?.toolUse as Anthropic.Beta.BetaToolUseBlock | undefined
      const tool = toolUse && clientTool(toolUse.name)
      if (!pending || !toolUse || tool?.kind !== 'client') throw httpError(404, "That card isn't waiting for an answer.")
      const nodeId = pending.node_id
      const result = tool.answer(toolUse.input, req.body.answer, { db, studyId, nodeId }, toolUse.id)
      if ('error' in result) throw httpError(400, result.error)
      const release = lock(studyId, nodeId)
      clearPending(db, pending.id)
      appendUserMessage(db, studyId, nodeId, [{ type: 'tool_result', tool_use_id: toolUse.id, content: result.content }])
      return stream(reply, release, emit => runTurn({ db, studyId, nodeId, apiKey: key, streamMessage, emit }))
    },
  )
}

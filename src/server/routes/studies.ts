import type Anthropic from '@anthropic-ai/sdk'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { AgentError } from '../core/agent'
import { httpError } from '../core/http'
import { deleteStudySessions } from '../core/sessions'
import { usageByModel } from '../core/usage'
import { isAppText } from '../tutor/context'
import { weakAncestors } from '../tutor/graph'
import { loadGraph } from '../tutor/plan'
import { type Summarize, summarizeNew } from '../tutor/teach'
import { probeStrands } from '../tutor/quiz'
import { type Phase, TOOLS, type ToolCtx } from '../tutor/tools'
import type { Block as Prompt, RunHop } from '../tutor/engine'
import { appendUserMessage, clearPending, type Emit, resultText, retryPrompt, runTurn } from '../tutor/loop'

type Block = Anthropic.Beta.BetaContentBlock | Anthropic.Beta.BetaContentBlockParam
type Row = { id: string; node_id: string | null; role: 'user' | 'assistant'; content: string; pending: number; created_at: number }

export type ThreadItem =
  | { type: 'user' | 'assistant'; text: string; createdAt: number }
  | { type: 'card'; toolUseId: string; name: string; input: unknown; answer: unknown; pending: boolean; createdAt: number }


function requireStudy(db: DatabaseSync, id: string) {
  const study = db.prepare('SELECT id, project_id AS projectId, goal, title, phase, approach, focus_node_id AS focusNodeId FROM studies WHERE id = ?').get(id)
  if (!study) throw httpError(404, 'Study not found.')
  return study as { id: string; projectId: string; goal: string; title: string | null; phase: Phase; approach: string | null; focusNodeId: string | null }
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
      if (b.type === 'text' && !isAppText(b)) return [{ type: r.role, text: b.text, createdAt }]
      if (b.type !== 'tool_use') return []
      const tool = clientTool(b.name)
      const result = results.get(b.id)
      if (tool?.kind !== 'client' || (!r.pending && (!result || result.is_error))) return []
      const answer = result ? JSON.parse(resultText(result)) : null
      return [{ type: 'card', toolUseId: b.id, name: b.name, input: tool.card(b.input, ctx, !!answer), answer, pending: r.pending === 1, createdAt }]
    }),
  )
}

export function studyRoutes(app: FastifyInstance, opts: { db: DatabaseSync; runHop: RunHop; summarize: Summarize }) {
  const { db, runHop, summarize } = opts
  // One turn per study, since focus_node can move a turn into another thread. Stop aborts the controller.
  // ponytail: in-memory lock; holds only while one server process owns the database
  const running = new Map<string, AbortController>()

  function lock(studyId: string) {
    if (running.has(studyId)) throw httpError(409, 'The tutor is still replying.')
    const controller = new AbortController()
    running.set(studyId, controller)
    return { signal: controller.signal, release: () => running.delete(studyId) }
  }

  const lastMessage = (studyId: string, nodeId: string | null) =>
    db
      .prepare('SELECT role FROM messages WHERE study_id = ? AND node_id IS ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(studyId, nodeId) as { role: 'user' | 'assistant' } | undefined

  /** Streams one turn. Summaries come after `done` and the lock's release, so they never hold up the user. */
  async function streamTurn(reply: FastifyReply, turn: ReturnType<typeof lock>, studyId: string, nodeId: string | null, prompt: Prompt[] | null) {
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    // A closed tab doesn't stop the turn: state stays consistent and the thread shows the reply on reload.
    const emit: Emit = (event, data) => {
      if (!reply.raw.destroyed) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    // A null prompt resumes a stored card answer: the client shows it before the tutor replies.
    if (!prompt) emit('answered', {})
    try {
      await runTurn({ db, studyId, nodeId, prompt, runHop, emit, signal: turn.signal })
    } catch (err) {
      if (!(err instanceof AgentError)) app.log.error(err)
      emit('error', { message: err instanceof AgentError ? err.message : 'Something went wrong on the server.' })
      emit('done', { awaiting: false })
    } finally {
      turn.release()
      // A failed summary is retried after the next turn.
      await summarizeNew(db, studyId, summarize).catch(err => app.log.error(err))
      reply.raw.end()
    }
  }

  app.get<{ Params: { id: string } }>('/api/studies/:id', async req => ({
    ...requireStudy(db, req.params.id),
    ...loadGraph(db, req.params.id),
    strands: probeStrands(db, req.params.id),
    usage: usageByModel(db, 'study_id', req.params.id),
  }))

  app.delete<{ Params: { id: string } }>('/api/studies/:id', async (req, reply) => {
    requireStudy(db, req.params.id)
    const turn = lock(req.params.id)
    try {
      deleteStudySessions(db, [req.params.id])
      db.prepare('DELETE FROM studies WHERE id = ?').run(req.params.id)
    } finally {
      turn.release()
    }
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string } }>('/api/studies/:id/stop', async (req, reply) => {
    requireStudy(db, req.params.id)
    running.get(req.params.id)?.abort()
    return reply.code(204).send()
  })

  /** Ancestors that aren't known, most foundational first; the banner's "Go to" target is weak[0]. */
  app.get<{ Params: { id: string; nodeId: string } }>('/api/studies/:id/nodes/:nodeId/prerequisites', async req => {
    requireStudy(db, req.params.id)
    requireNode(db, req.params.id, req.params.nodeId)
    const { nodes, edges } = loadGraph(db, req.params.id)
    return { weak: weakAncestors(req.params.nodeId, nodes, edges) }
  })

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
      const studyId = req.params.id
      const { phase } = requireStudy(db, studyId)
      const nodeId = req.body.nodeId || null
      requireNode(db, studyId, nodeId)
      if (nodeId && (phase === 'probe' || phase === 'plan')) throw httpError(409, 'Node threads open once the plan is approved.')
      const text = req.body.text.trim()
      if (!text) throw httpError(400, "Message can't be blank.")
      const turn = lock(studyId)
      if (db.prepare('SELECT 1 FROM messages WHERE study_id = ? AND node_id IS ? AND pending = 1').get(studyId, nodeId)) {
        turn.release()
        throw httpError(409, 'Answer the card first.')
      }
      if (nodeId) db.prepare('UPDATE studies SET focus_node_id = ? WHERE id = ?').run(nodeId, studyId)
      return streamTurn(reply, turn, studyId, nodeId, [{ type: 'text', text }])
    },
  )

  /** Re-runs a thread whose last message (text, tool_result, or app note) got no reply, e.g. after an error. */
  app.post<{ Params: { id: string }; Body: { nodeId?: string } }>(
    '/api/studies/:id/retry',
    { schema: { body: { type: 'object', properties: { nodeId: { type: 'string' } } } } },
    async (req, reply) => {
      const studyId = req.params.id
      requireStudy(db, studyId)
      const nodeId = req.body?.nodeId || null
      requireNode(db, studyId, nodeId)
      const turn = lock(studyId)
      if (lastMessage(studyId, nodeId)?.role !== 'user') {
        turn.release()
        throw httpError(409, 'Nothing to retry.')
      }
      return streamTurn(reply, turn, studyId, nodeId, retryPrompt(db, studyId, nodeId))
    },
  )

  /** Opening an untaught node starts its lesson; a node with history just shows its thread (204). */
  app.post<{ Params: { id: string }; Body: { nodeId: string } }>(
    '/api/studies/:id/open',
    { schema: { body: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string', minLength: 1 } } } } },
    async (req, reply) => {
      const studyId = req.params.id
      const { phase } = requireStudy(db, studyId)
      const { nodeId } = req.body
      requireNode(db, studyId, nodeId)
      if (phase === 'probe' || phase === 'plan') throw httpError(409, 'Node threads open once the plan is approved.')
      if (lastMessage(studyId, nodeId)) return reply.code(204).send()
      const turn = lock(studyId)
      const { label } = db.prepare('SELECT label FROM nodes WHERE study_id = ? AND id = ?').get(studyId, nodeId) as { label: string }
      db.prepare('UPDATE studies SET focus_node_id = ? WHERE id = ?').run(nodeId, studyId)
      return streamTurn(reply, turn, studyId, nodeId, [{ type: 'text', text: `[App: The user opened "${label}". Teach it now.]` }])
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
      const turn = lock(studyId)
      clearPending(db, pending.id)
      appendUserMessage(db, studyId, nodeId, [{ type: 'tool_result', tool_use_id: toolUse.id, content: result.content }])
      return streamTurn(reply, turn, studyId, nodeId, null)
    },
  )
}

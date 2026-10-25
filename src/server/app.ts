import Fastify from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { anthropicError, apiKey, type CheckKey, checkKey, htmlToMarkdown, streamMessage, summarize } from './core/anthropic'
import { fileRoutes, type HtmlToMarkdown } from './routes/files'
import { projectRoutes } from './routes/projects'
import { studyRoutes } from './routes/studies'
import type { StreamMessage } from './tutor/loop'
import type { Summarize } from './tutor/teach'

export function buildApp(opts: {
  db: DatabaseSync
  logStream?: { write(line: string): void }
  htmlToMarkdown?: HtmlToMarkdown
  streamMessage?: StreamMessage
  summarize?: Summarize
  checkKey?: CheckKey
}) {
  const { db, logStream } = opts
  const app = Fastify({
    logger: logStream ? { stream: logStream, redact: ['req.headers["x-anthropic-key"]'] } : false,
  })

  app.setErrorHandler((err, _req, reply) => reply.send(anthropicError(err) ?? err))

  app.get('/api/health', async () => {
    db.prepare('SELECT 1').get()
    return { ok: true }
  })

  app.post('/api/key/check', async (req, reply) => {
    await (opts.checkKey ?? checkKey)(apiKey(req))
    return reply.code(204).send()
  })

  projectRoutes(app, db)
  fileRoutes(app, { db, htmlToMarkdown: opts.htmlToMarkdown ?? htmlToMarkdown })
  studyRoutes(app, { db, streamMessage: opts.streamMessage ?? streamMessage, summarize: opts.summarize ?? summarize })

  return app
}

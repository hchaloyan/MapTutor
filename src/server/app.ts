import Fastify from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { anthropicError, htmlToMarkdown, streamMessage } from './core/anthropic'
import { fileRoutes, type HtmlToMarkdown } from './routes/files'
import { projectRoutes } from './routes/projects'
import { studyRoutes } from './routes/studies'
import type { StreamMessage } from './tutor/loop'

export function buildApp(opts: {
  db: DatabaseSync
  logStream?: { write(line: string): void }
  htmlToMarkdown?: HtmlToMarkdown
  streamMessage?: StreamMessage
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

  projectRoutes(app, db)
  fileRoutes(app, { db, htmlToMarkdown: opts.htmlToMarkdown ?? htmlToMarkdown })
  studyRoutes(app, { db, streamMessage: opts.streamMessage ?? streamMessage })

  return app
}

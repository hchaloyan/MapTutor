import Fastify from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { agentEngine, AgentError, htmlToMarkdown, mcpRoutes, summarize } from './core/agent'
import { httpError } from './core/http'
import { fileRoutes, type HtmlToMarkdown } from './routes/files'
import { projectRoutes } from './routes/projects'
import { studyRoutes } from './routes/studies'
import type { RunHop } from './tutor/engine'
import type { Summarize } from './tutor/teach'

export function buildApp(opts: {
  db: DatabaseSync
  logStream?: { write(line: string): void }
  runHop?: RunHop
  summarize?: Summarize
  htmlToMarkdown?: HtmlToMarkdown
}) {
  const { db, logStream } = opts
  const app = Fastify({ logger: logStream ? { stream: logStream } : false })

  app.setErrorHandler((err, _req, reply) => reply.send(err instanceof AgentError ? httpError(502, err.message) : err))

  app.get('/api/health', async () => {
    db.prepare('SELECT 1').get()
    return { ok: true }
  })

  // The tutor's tools reach Claude Code through this server, at the address it listens on.
  mcpRoutes(app)
  const self = () => {
    const { address, port } = app.addresses()[0]
    return `http://${address}:${port}`
  }

  projectRoutes(app, db)
  fileRoutes(app, { db, htmlToMarkdown: opts.htmlToMarkdown ?? htmlToMarkdown })
  studyRoutes(app, { db, runHop: opts.runHop ?? agentEngine(db, self), summarize: opts.summarize ?? summarize })

  return app
}

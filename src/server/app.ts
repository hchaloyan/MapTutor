import Anthropic from '@anthropic-ai/sdk'
import Fastify from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { htmlToMarkdown } from './anthropic'
import { fileRoutes, type HtmlToMarkdown } from './files'
import { httpError } from './http'
import { projectRoutes } from './projects'

export function buildApp(opts: { db: DatabaseSync; logStream?: { write(line: string): void }; htmlToMarkdown?: HtmlToMarkdown }) {
  const { db, logStream } = opts
  const app = Fastify({
    logger: logStream ? { stream: logStream, redact: ['req.headers["x-anthropic-key"]'] } : false,
  })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof Anthropic.AuthenticationError) return reply.send(httpError(401, 'Your Anthropic API key was rejected.'))
    if (err instanceof Anthropic.APIError) return reply.send(httpError(502, `Anthropic API error: ${err.message}`))
    return reply.send(err)
  })

  app.get('/api/health', async () => {
    db.prepare('SELECT 1').get()
    return { ok: true }
  })

  projectRoutes(app, db)
  fileRoutes(app, { db, htmlToMarkdown: opts.htmlToMarkdown ?? htmlToMarkdown })

  return app
}

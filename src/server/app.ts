import Fastify from 'fastify'
import type { DatabaseSync } from 'node:sqlite'

export function buildApp(db: DatabaseSync, logStream?: { write(line: string): void }) {
  const app = Fastify({
    logger: logStream ? { stream: logStream, redact: ['req.headers["x-anthropic-key"]'] } : false,
  })

  app.get('/api/health', async () => {
    db.prepare('SELECT 1').get()
    return { ok: true }
  })

  return app
}

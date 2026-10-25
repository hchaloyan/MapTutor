import { expect, test } from 'vitest'
import { buildApp } from './app'
import { openDb } from './core/db'

test('health check answers ok', async () => {
  const res = await buildApp({ db: openDb(":memory:") }).inject('/api/health')
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ ok: true })
})

test('never logs the API key', async () => {
  const lines: string[] = []
  const app = buildApp({ db: openDb(":memory:"), logStream: { write: l => { lines.push(l) } } })
  await app.inject({ url: '/api/health', headers: { 'x-anthropic-key': 'sk-ant-secret-123' } })
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.join('')).not.toContain('sk-ant-secret-123')
})

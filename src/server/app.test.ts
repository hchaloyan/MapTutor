import Anthropic from '@anthropic-ai/sdk'
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

test('key check is a 204 for an accepted key and a 401 for a rejected one', async () => {
  const app = buildApp({
    db: openDb(':memory:'),
    checkKey: async key => {
      if (key !== 'sk-ant-good') throw new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers())
    },
  })
  const check = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/key/check', headers })
  expect((await check({ 'x-anthropic-key': 'sk-ant-good' })).statusCode).toBe(204)
  const bad = await check({ 'x-anthropic-key': 'sk-ant-bad' })
  expect(bad.statusCode).toBe(401)
  expect(bad.json().message).toBe('Your Anthropic API key was rejected.')
  expect((await check({})).statusCode).toBe(401)
})

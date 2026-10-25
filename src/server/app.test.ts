import { expect, test } from 'vitest'
import { buildApp } from './app'
import { openDb } from './core/db'

test('health check answers ok', async () => {
  const res = await buildApp({ db: openDb(':memory:') }).inject('/api/health')
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ ok: true })
})

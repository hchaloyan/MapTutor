import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { checkAndSave, getKey, maskKey, saveKey } from './key'

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})
afterEach(() => vi.unstubAllGlobals())

test('maskKey keeps the prefix and the last four', () => {
  expect(maskKey('sk-ant-api03-abcdefa1B2')).toBe('sk-ant-•••••••a1B2')
})

test('checkAndSave keeps the old key when the new one is rejected', async () => {
  saveKey('sk-ant-old')
  const sent: (string | null)[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const key = new Headers(init.headers).get('x-anthropic-key')
    sent.push(key)
    return key === 'sk-ant-good'
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ message: 'Your Anthropic API key was rejected.' }), { status: 401 })
  })
  expect(await checkAndSave('sk-ant-bad')).toBe(false)
  expect(getKey()).toBe('sk-ant-old')
  expect(await checkAndSave('sk-ant-good')).toBe(true)
  expect(getKey()).toBe('sk-ant-good')
  expect(sent).toEqual(['sk-ant-bad', 'sk-ant-good'])
})

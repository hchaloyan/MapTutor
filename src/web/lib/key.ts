import { api, ApiError } from './api'

// The user's Anthropic key lives only in this browser; the server forwards it per request and never stores it.
const KEY = 'maptutor.key'

export function getKey(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export const saveKey = (key: string) => localStorage.setItem(KEY, key)
export const removeKey = () => localStorage.removeItem(KEY)
export const maskKey = (key: string) => `sk-ant-•••••••${key.slice(-4)}`

/** Saves the key only if Anthropic accepts it. Errors other than a rejection propagate. */
export async function checkAndSave(key: string): Promise<boolean> {
  try {
    await api('/api/key/check', { method: 'POST', headers: { 'x-anthropic-key': key } })
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return false
    throw err
  }
  saveKey(key)
  return true
}

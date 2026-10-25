import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api, ApiError, uploadAll } from './api'

let requests: { url: string; init: RequestInit }[]

/** Answers each request with the next response in line. */
function respond(...responses: Response[]) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    return responses.shift()!
  })
}

beforeEach(() => {
  requests = []
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})
afterEach(() => vi.unstubAllGlobals())

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('api sends the saved key and maps server errors', async () => {
  localStorage.setItem('maptutor.key', 'sk-ant-mine')
  respond(json(409, { statusCode: 409, error: 'Conflict', message: 'The tutor is still replying.' }))
  const err = (await api('/api/studies/s1', { method: 'DELETE' }).catch(e => e)) as ApiError
  expect(err).toBeInstanceOf(ApiError)
  expect([err.status, err.message]).toEqual([409, 'The tutor is still replying.'])
  expect(new Headers(requests[0].init.headers).get('x-anthropic-key')).toBe('sk-ant-mine')
})

test('api sends JSON and returns undefined for 204', async () => {
  respond(new Response(null, { status: 204 }), json(201, { id: 'p1' }))
  expect(await api('/api/files/f1', { method: 'DELETE' })).toBeUndefined()
  expect(await api('/api/projects', { method: 'POST', json: { name: 'Calc' } })).toEqual({ id: 'p1' })
  expect(requests[1].init.body).toBe('{"name":"Calc"}')
  expect(new Headers(requests[1].init.headers).get('content-type')).toBe('application/json')
  expect(new Headers(requests[1].init.headers).has('x-anthropic-key')).toBe(false)
})

test('uploadAll keeps going after a failure', async () => {
  respond(json(201, {}), json(413, { message: "A project's files are limited to 20 MB in total." }), json(201, {}))
  const files = ['a.md', 'big.pdf', 'c.txt'].map(name => new File(['x'], name))
  expect(await uploadAll('p1', files)).toEqual(["big.pdf: A project's files are limited to 20 MB in total."])
  expect(requests.map(r => r.url)).toEqual(['/api/projects/p1/files?name=a.md', '/api/projects/p1/files?name=big.pdf', '/api/projects/p1/files?name=c.txt'])
  expect(new Headers(requests[0].init.headers).get('content-type')).toBe('application/octet-stream')
})

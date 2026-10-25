import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { buildApp } from './app'
import { openDb } from './db'

let server: Server
let base: string
let pageHtml: string
const pages: Record<string, [string, string]> = {
  '/doc.pdf': ['application/pdf', '%PDF-1.7 fake'],
  '/notes.txt': ['text/plain; charset=utf-8', 'plain notes'],
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/page') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageHtml)
    // Bodies that never finish: the server must decide from the headers alone.
    if (req.url === '/video') return res.writeHead(200, { 'content-type': 'video/mp4' }).write('x')
    if (req.url === '/huge.pdf') return res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(21 * 1024 * 1024) }).write('x')
    const page = pages[req.url ?? '']
    if (!page) return res.writeHead(404).end('nope')
    res.writeHead(200, { 'content-type': page[0] }).end(page[1])
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
})
beforeEach(() => {
  pageHtml = '<html><head><script>track()</script><style>p{}</style></head><body><h1>Derivatives</h1><!-- c --></body></html>'
})

async function setup(markdown = '# Converted') {
  const calls: { html: string; apiKey: string }[] = []
  const app = buildApp({
    db: openDb(':memory:'),
    htmlToMarkdown: async (html, apiKey) => {
      calls.push({ html, apiKey })
      return markdown
    },
  })
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Calc' } })).json()
  const importUrl = (url: string, key: string | null = 'sk-test') =>
    app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/urls`,
      headers: key ? { 'x-anthropic-key': key } : {},
      payload: { url },
    })
  const content = async (id: string) => (await app.inject(`/api/files/${id}/content`)).body
  const fileCount = async () => (await app.inject(`/api/projects/${project.id}`)).json().files.length
  return { app, calls, importUrl, content, fileCount, projectId: project.id as string }
}

test('imports an HTML page through the converter', async () => {
  const { calls, importUrl, content } = await setup()
  const res = await importUrl(`${base}/page`)
  expect(res.statusCode).toBe(201)
  expect(res.json()).toMatchObject({ kind: 'url', name: `${base}/page`, url: `${base}/page` })
  expect(await content(res.json().id)).toBe('# Converted')
  expect(calls).toHaveLength(1)
  expect(calls[0].apiKey).toBe('sk-test')
  expect(calls[0].html).toContain('<h1>Derivatives</h1>')
  expect(calls[0].html).not.toMatch(/<script|<style|<!--/)
})

test('imports a PDF link as a PDF without the converter', async () => {
  const { calls, importUrl, content } = await setup()
  const res = await importUrl(`${base}/doc.pdf`)
  expect(res.json()).toMatchObject({ kind: 'pdf', url: `${base}/doc.pdf` })
  expect(await content(res.json().id)).toBe('%PDF-1.7 fake')
  expect(calls).toHaveLength(0)
})

test('stores plain text as-is', async () => {
  const { calls, importUrl, content } = await setup()
  const res = await importUrl(`${base}/notes.txt`)
  expect(res.json().kind).toBe('url')
  expect(await content(res.json().id)).toBe('plain notes')
  expect(calls).toHaveLength(0)
})

test('reports a failing page and stores nothing', async () => {
  const { importUrl, fileCount } = await setup()
  const res = await importUrl(`${base}/missing`)
  expect(res.statusCode).toBe(502)
  expect(res.json().message).toBe('Fetching the page failed with status 404.')
  expect(await fileCount()).toBe(0)
})

test('rejects a non-http URL', async () => {
  const { importUrl } = await setup()
  const res = await importUrl('file:///etc/passwd')
  expect(res.statusCode).toBe(400)
})

test('requires an API key', async () => {
  const { importUrl, calls } = await setup()
  const res = await importUrl(`${base}/page`, null)
  expect(res.statusCode).toBe(401)
  expect(res.json().message).toBe('Add your Anthropic API key in settings.')
  expect(calls).toHaveLength(0)
})

test('refresh re-imports the page', async () => {
  let markdown = '# Old'
  const app = buildApp({ db: openDb(':memory:'), htmlToMarkdown: async () => markdown })
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Calc' } })).json()
  const headers = { 'x-anthropic-key': 'sk-test' }
  const file = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/urls`, headers, payload: { url: `${base}/page` } })).json()
  markdown = '# New'
  const res = await app.inject({ method: 'POST', url: `/api/files/${file.id}/refresh`, headers })
  expect(res.statusCode).toBe(200)
  expect(res.json().id).toBe(file.id)
  expect((await app.inject(`/api/files/${file.id}/content`)).body).toBe('# New')
})

test('refusing to refresh an uploaded file', async () => {
  const { app, projectId } = await setup()
  const file = (
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/files?name=notes.md`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('hi'),
    })
  ).json()
  const res = await app.inject({ method: 'POST', url: `/api/files/${file.id}/refresh`, headers: { 'x-anthropic-key': 'sk-test' } })
  expect(res.statusCode).toBe(400)
  expect(res.json().message).toBe('Only imported URLs can be refreshed.')
})

test('rejects an unsupported page type without downloading it', async () => {
  const { importUrl } = await setup()
  const res = await importUrl(`${base}/video`)
  expect(res.statusCode).toBe(415)
  expect(res.json().message).toBe('Unsupported page type: video/mp4.')
})

test('rejects a page whose declared size is over the project limit', async () => {
  const { importUrl } = await setup()
  const res = await importUrl(`${base}/huge.pdf`)
  expect(res.statusCode).toBe(413)
  expect(res.json().message).toBe("A project's files are limited to 20 MB in total.")
})

import { expect, test } from 'vitest'
import { buildApp } from './app'
import { openDb } from './db'

const MB = 1024 * 1024

async function setup() {
  const app = buildApp({ db: openDb(':memory:') })
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Calc' } })).json()
  return { app, projectId: project.id as string }
}

function upload(app: ReturnType<typeof buildApp>, projectId: string, name: string, bytes: Buffer) {
  return app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/files?name=${encodeURIComponent(name)}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: bytes,
  })
}

async function fileCount(app: ReturnType<typeof buildApp>, projectId: string) {
  return (await app.inject(`/api/projects/${projectId}`)).json().files.length
}

test('stores a PDF and serves it back', async () => {
  const { app, projectId } = await setup()
  const bytes = Buffer.from('%PDF-1.7 fake')
  const res = await upload(app, projectId, 'slides.pdf', bytes)
  expect(res.statusCode).toBe(201)
  expect(res.json()).toMatchObject({ kind: 'pdf', name: 'slides.pdf', url: null, size: bytes.length })
  const content = await app.inject(`/api/files/${res.json().id}/content`)
  expect(content.headers['content-type']).toBe('application/pdf')
  expect(content.rawPayload).toEqual(bytes)
})

test('accepts an uppercase extension', async () => {
  const { app, projectId } = await setup()
  const res = await upload(app, projectId, 'SCAN.PNG', Buffer.from([0x89, 0x50]))
  expect(res.json().kind).toBe('image')
  expect((await app.inject(`/api/files/${res.json().id}/content`)).headers['content-type']).toBe('image/png')
})

test('stores text as text_cache', async () => {
  const { app, projectId } = await setup()
  const res = await upload(app, projectId, 'notes.md', Buffer.from('é'))
  expect(res.json()).toMatchObject({ kind: 'text', size: 2 })
  const content = await app.inject(`/api/files/${res.json().id}/content`)
  expect(content.headers['content-type']).toBe('text/markdown; charset=utf-8')
  expect(content.body).toBe('é')
})

test('rejects an unsupported type', async () => {
  const { app, projectId } = await setup()
  const res = await upload(app, projectId, 'deck.pptx', Buffer.from('x'))
  expect(res.statusCode).toBe(415)
  expect(res.json().message).toBe('Unsupported file type. Upload a PDF, an image (PNG, JPEG, GIF, WebP), or a .md/.txt file.')
  expect(await fileCount(app, projectId)).toBe(0)
})

test('rejects text that is not UTF-8', async () => {
  const { app, projectId } = await setup()
  const res = await upload(app, projectId, 'notes.txt', Buffer.from([0xff, 0xfe]))
  expect(res.statusCode).toBe(415)
  expect(res.json().message).toBe("This file isn't valid UTF-8 text.")
  expect(await fileCount(app, projectId)).toBe(0)
})

test('rejects an image over 5 MB', async () => {
  const { app, projectId } = await setup()
  const res = await upload(app, projectId, 'photo.jpg', Buffer.alloc(5 * MB + 1))
  expect(res.statusCode).toBe(413)
  expect(res.json().message).toBe('Images are limited to 5 MB.')
})

test('enforces the project total and frees room on delete', async () => {
  const { app, projectId } = await setup()
  const a = (await upload(app, projectId, 'a.pdf', Buffer.alloc(6 * MB))).json()
  await upload(app, projectId, 'b.pdf', Buffer.alloc(6 * MB))
  const over = await upload(app, projectId, 'c.pdf', Buffer.alloc(9 * MB))
  expect(over.statusCode).toBe(413)
  expect(over.json().message).toBe("A project's files are limited to 20 MB in total.")
  expect(await fileCount(app, projectId)).toBe(2)
  await app.inject({ method: 'DELETE', url: `/api/files/${a.id}` })
  expect((await upload(app, projectId, 'c.pdf', Buffer.alloc(9 * MB))).statusCode).toBe(201)
})

test('upload to an unknown project is a 404', async () => {
  const { app } = await setup()
  const res = await upload(app, 'nope', 'notes.md', Buffer.from('hi'))
  expect(res.statusCode).toBe(404)
  expect(res.json().message).toBe('Project not found.')
})

test('deleting a file removes it', async () => {
  const { app, projectId } = await setup()
  const file = (await upload(app, projectId, 'notes.md', Buffer.from('hi'))).json()
  expect((await app.inject({ method: 'DELETE', url: `/api/files/${file.id}` })).statusCode).toBe(204)
  const gone = await app.inject(`/api/files/${file.id}/content`)
  expect(gone.statusCode).toBe(404)
  expect(gone.json().message).toBe('File not found.')
})

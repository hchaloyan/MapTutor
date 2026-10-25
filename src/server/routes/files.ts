import type { FastifyInstance } from 'fastify'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { FILES_DIR, MAX_IMAGE_BYTES, MAX_PROJECT_BYTES } from '../core/config'
import { requireProject } from '../core/db'
import { httpError } from '../core/http'
import { recordUsage } from '../core/usage'
import type { UsageRow } from '../tutor/engine'

export type FileKind = 'pdf' | 'image' | 'text' | 'url'

const KINDS: Record<string, 'pdf' | 'image' | 'text'> = {
  pdf: 'pdf', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', md: 'text', markdown: 'text', txt: 'text',
}
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

const extension = (name: string) => name.toLowerCase().split('.').pop() ?? ''

export function kindFor(name: string): 'pdf' | 'image' | 'text' | null {
  return KINDS[extension(name)] ?? null
}

/** Media type of a stored file's bytes (pdf and image files). */
export function mediaType(file: { kind: string; name: string }): string {
  return file.kind === 'pdf' ? 'application/pdf' : (IMAGE_TYPES[extension(file.name)] ?? 'application/octet-stream')
}

/** Where a file the tutor opens on demand is copied: its id, with an extension Read recognises. */
export const filePath = (projectId: string, f: { id: string; kind: string; name: string }) =>
  join(FILES_DIR, projectId, `${f.id}.${f.kind === 'pdf' ? 'pdf' : f.kind === 'image' ? extension(f.name) : 'md'}`)

const LIMIT = "A project's files are limited to 100 MB in total."

const SIZE = 'coalesce(length(data), length(CAST(text_cache AS BLOB)), 0)'
const FILE_INFO = `SELECT id, kind, name, url, ${SIZE} AS size, created_at AS createdAt FROM files`

export const listFiles = (db: DatabaseSync, projectId: string) =>
  db.prepare(`${FILE_INFO} WHERE project_id = ? ORDER BY created_at, rowid`).all(projectId)

export const fileInfo = (db: DatabaseSync, id: string) => db.prepare(`${FILE_INFO} WHERE id = ?`).get(id)

export function requireFile(db: DatabaseSync, id: string) {
  const file = db.prepare('SELECT id, project_id AS projectId, kind, name, url, data, text_cache AS text FROM files WHERE id = ?').get(id)
  if (!file) throw httpError(404, 'File not found.')
  return file as { id: string; projectId: string; kind: FileKind; name: string; url: string | null; data: Uint8Array | null; text: string | null }
}

/** Throws 413 unless `size` more bytes fit in the project (ignoring `replacingFileId`'s current bytes). */
export function checkRoom(db: DatabaseSync, projectId: string, size: number, replacingFileId?: string) {
  const { used } = db
    .prepare(`SELECT coalesce(sum(${SIZE}), 0) AS used FROM files WHERE project_id = ? AND id IS NOT ?`)
    .get(projectId, replacingFileId ?? null) as { used: number }
  if (used + size > MAX_PROJECT_BYTES) throw httpError(413, LIMIT)
}

export function decodeText(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw httpError(415, "This file isn't valid UTF-8 text.")
  }
}

export type HtmlToMarkdown = (html: string, onUsage?: (u: UsageRow) => void) => Promise<string>

// ponytail: regex strip, not a parser; it only trims tokens before the converter sees the page
const stripHtml = (html: string) =>
  html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, '')

async function fetchUrl(raw: string, htmlToMarkdown: HtmlToMarkdown, onUsage: (u: UsageRow) => void) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw httpError(400, "That isn't a valid URL.")
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw httpError(400, 'Only http and https URLs can be imported.')
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  } catch {
    throw httpError(502, "Couldn't reach that URL.")
  }
  if (!res.ok) throw httpError(502, `Fetching the page failed with status ${res.status}.`)
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const declared = Number(res.headers.get('content-length') ?? 0)
  const rejection = !['application/pdf', 'text/plain', 'text/markdown', 'text/html'].includes(type)
    ? httpError(415, `Unsupported page type: ${type || 'unknown'}.`)
    : declared > MAX_PROJECT_BYTES
      ? httpError(413, LIMIT)
      : null
  if (rejection) {
    await res.body?.cancel()
    throw rejection
  }
  // ponytail: a server that omits content-length can still send a huge body; add a streaming cap if that shows up
  let bytes: Buffer
  try {
    bytes = Buffer.from(await res.arrayBuffer())
  } catch {
    throw httpError(502, "Couldn't reach that URL.")
  }
  if (type === 'application/pdf') return { kind: 'pdf' as const, data: bytes, text: null }
  if (type === 'text/plain' || type === 'text/markdown') return { kind: 'url' as const, data: null, text: bytes.toString('utf8') }
  return { kind: 'url' as const, data: null, text: await htmlToMarkdown(stripHtml(bytes.toString('utf8')), onUsage) }
}

const importedSize = (file: { data: Buffer | null; text: string | null }) =>
  file.data ? file.data.length : Buffer.byteLength(file.text ?? '')

export function fileRoutes(app: FastifyInstance, opts: { db: DatabaseSync; htmlToMarkdown: HtmlToMarkdown }) {
  const { db, htmlToMarkdown } = opts

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_PROJECT_BYTES }, (_req, body, done) =>
    done(null, body),
  )

  app.post<{ Params: { id: string }; Querystring: { name: string }; Body: Buffer }>(
    '/api/projects/:id/files',
    { schema: { querystring: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (req, reply) => {
      requireProject(db, req.params.id)
      const { name } = req.query
      const kind = kindFor(name)
      if (!kind) throw httpError(415, 'Unsupported file type. Upload a PDF, an image (PNG, JPEG, GIF, WebP), or a .md/.txt file.')
      const bytes = req.body ?? Buffer.alloc(0)
      if (kind === 'image' && bytes.length > MAX_IMAGE_BYTES) throw httpError(413, 'Images are limited to 5 MB.')
      const text = kind === 'text' ? decodeText(bytes) : null
      checkRoom(db, req.params.id, bytes.length)
      const id = crypto.randomUUID()
      db.prepare('INSERT INTO files (id, project_id, kind, name, data, text_cache, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id, req.params.id, kind, name, text === null ? bytes : null, text, Date.now(),
      )
      return reply.code(201).send(fileInfo(db, id))
    },
  )

  app.post<{ Params: { id: string }; Body: { url: string } }>(
    '/api/projects/:id/urls',
    { schema: { body: { type: 'object', required: ['url'], properties: { url: { type: 'string', minLength: 1, maxLength: 2000 } } } } },
    async (req, reply) => {
      requireProject(db, req.params.id)
      const url = req.body.url.trim()
      const imported = await fetchUrl(url, htmlToMarkdown, u => recordUsage(db, req.params.id, null, u))
      checkRoom(db, req.params.id, importedSize(imported))
      const id = crypto.randomUUID()
      db.prepare('INSERT INTO files (id, project_id, kind, name, url, data, text_cache, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, req.params.id, imported.kind, url, url, imported.data, imported.text, Date.now(),
      )
      return reply.code(201).send(fileInfo(db, id))
    },
  )

  app.post<{ Params: { id: string } }>('/api/files/:id/refresh', async req => {
    const file = requireFile(db, req.params.id)
    if (!file.url) throw httpError(400, 'Only imported URLs can be refreshed.')
    const imported = await fetchUrl(file.url, htmlToMarkdown, u => recordUsage(db, file.projectId, null, u))
    checkRoom(db, file.projectId, importedSize(imported), file.id)
    rmSync(filePath(file.projectId, file), { force: true }) // the kind, and so the copy's name, may change
    db.prepare('UPDATE files SET kind = ?, data = ?, text_cache = ? WHERE id = ?').run(imported.kind, imported.data, imported.text, file.id)
    return fileInfo(db, file.id)
  })

  app.get<{ Params: { id: string } }>('/api/files/:id/content', async (req, reply) => {
    const file = requireFile(db, req.params.id)
    if (file.data) return reply.type(mediaType(file)).send(Buffer.from(file.data))
    return reply.type('text/markdown; charset=utf-8').send(file.text ?? '')
  })

  app.delete<{ Params: { id: string } }>('/api/files/:id', async (req, reply) => {
    const file = requireFile(db, req.params.id)
    rmSync(filePath(file.projectId, file), { force: true })
    db.prepare('DELETE FROM files WHERE id = ?').run(req.params.id)
    return reply.code(204).send()
  })
}

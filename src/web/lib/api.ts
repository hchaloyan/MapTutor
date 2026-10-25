import { getKey } from './key'

export type NodeState = 'untested' | 'missed' | 'frontier' | 'known'
export type Phase = 'probe' | 'plan' | 'teach' | 'done'
export type Usage = {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  webSearches: number
}[]
export type ProjectSummary = { id: string; name: string; createdAt: number; goalCount: number; fileCount: number }
export type FileInfo = { id: string; kind: 'pdf' | 'image' | 'text' | 'url'; name: string; url: string | null; size: number; createdAt: number }
export type StudySummary = {
  id: string
  goal: string
  title: string | null
  phase: Phase
  createdAt: number
  counts: Record<NodeState, number>
  usage: Usage
}
export type Project = { id: string; name: string; createdAt: number; files: FileInfo[]; studies: StudySummary[]; usage: Usage }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Calls the server with the saved key (unless `headers` sets one). Throws ApiError with the server's message. */
export async function api<T = unknown>(
  path: string,
  init: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  const key = getKey()
  if (key && !headers.has('x-anthropic-key')) headers.set('x-anthropic-key', key)
  if (init.json !== undefined) headers.set('content-type', 'application/json')
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    signal: init.signal,
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.message ?? 'Something went wrong.')
  return body as T
}

/** Uploads in order and keeps going past failures; returns one line per file that failed. */
export async function uploadAll(projectId: string, files: File[]): Promise<string[]> {
  const errors: string[] = []
  for (const file of files) {
    try {
      await api(`/api/projects/${projectId}/files?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: file,
        headers: { 'content-type': 'application/octet-stream' },
      })
    } catch (err) {
      errors.push(`${file.name}: ${(err as Error).message}`)
    }
  }
  return errors
}

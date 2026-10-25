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
export type StudyNode = {
  id: string
  label: string
  kind: 'root' | 'derived' | 'goal'
  description: string
  strands: string[]
  state: NodeState
  everKnown: boolean
  summary: string | null
  evidence: { correct: number; total: number }
}
export type Strand = { strand: string; correct: number; total: number }
export type Study = {
  id: string
  projectId: string
  goal: string
  title: string | null
  phase: Phase
  approach: string | null
  focusNodeId: string | null
  nodes: StudyNode[]
  edges: { from: string; to: string }[]
  strands: Strand[]
  usage: Usage
}
// Card inputs and answers are the tool's own shapes; the card components read them.
export type Card = { type: 'card'; toolUseId: string; name: 'quiz' | 'ask_user_question' | 'propose_graph'; input: any; answer: any; pending: boolean; createdAt: number }
export type ThreadItem = { type: 'user' | 'assistant'; text: string; createdAt: number } | Card
export type Project = { id: string; name: string; createdAt: number; files: FileInfo[]; studies: StudySummary[]; usage: Usage }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Calls the server. Throws ApiError with the server's message. */
export async function api<T = unknown>(
  path: string,
  init: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  const headers = new Headers(init.headers)
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

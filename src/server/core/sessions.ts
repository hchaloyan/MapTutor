import type { DatabaseSync } from 'node:sqlite'
import type { ModelUsage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'

// Agent SDK transcripts live in SQLite, keyed by session id alone: the SDK's projectKey is the
// sanitized cwd, which changes when the repo moves.
export function sqliteSessionStore(db: DatabaseSync): SessionStore {
  const insert = db.prepare('INSERT OR IGNORE INTO agent_entries (session_id, subpath, uuid, entry) VALUES (?, ?, ?, ?)')
  const select = db.prepare('SELECT entry FROM agent_entries WHERE session_id = ? AND subpath = ? ORDER BY seq')
  return {
    async append(key: SessionKey, entries: SessionStoreEntry[]) {
      for (const e of entries) insert.run(key.sessionId, key.subpath ?? '', e.uuid ?? null, JSON.stringify(e))
    },
    async load(key: SessionKey) {
      const rows = select.all(key.sessionId, key.subpath ?? '') as { entry: string }[]
      return rows.length ? rows.map(r => JSON.parse(r.entry)) : null
    },
    async delete(key: SessionKey) {
      deleteSessions(db, [key.sessionId])
    },
  }
}

/** The session's cumulative model usage, from its last `cost-state` entry. */
export function sessionUsage(db: DatabaseSync, sessionId: string): Record<string, Partial<ModelUsage>> {
  const row = db
    .prepare("SELECT entry FROM agent_entries WHERE session_id = ? AND subpath = '' AND json_extract(entry, '$.type') = 'cost-state' ORDER BY seq DESC LIMIT 1")
    .get(sessionId) as { entry: string } | undefined
  return row ? (JSON.parse(row.entry).modelUsage ?? {}) : {}
}

/** Whether the transcript's last tool call still waits for its result: a deferred card call a resume would run. */
export function hasDeferredCall(db: DatabaseSync, sessionId: string): boolean {
  // Paths go through the entry itself (b.fullkey), since a content element may be a bare string.
  const blocks = (type: string, field: string) =>
    `SELECT json_extract(e.entry, b.fullkey || '.${field}') AS id FROM agent_entries e, json_each(e.entry, '$.message.content') b
     WHERE e.session_id = ? AND e.subpath = '' AND json_extract(e.entry, b.fullkey || '.type') = '${type}'`
  const last = db.prepare(`${blocks('tool_use', 'id')} ORDER BY e.seq DESC LIMIT 1`).get(sessionId) as { id: string } | undefined
  return !!last && !db.prepare(`SELECT 1 FROM (${blocks('tool_result', 'tool_use_id')}) WHERE id = ?`).get(sessionId, last.id)
}

export function deleteSessions(db: DatabaseSync, sessionIds: string[]) {
  const del = db.prepare('DELETE FROM agent_entries WHERE session_id = ?')
  for (const id of sessionIds) del.run(id)
}

/** Deletes the transcripts of every thread (main and nodes) of these studies; they carry the project files too. */
export function deleteStudySessions(db: DatabaseSync, studyIds: string[]) {
  const sessions = db.prepare('SELECT session_id AS id FROM studies WHERE id = ? UNION SELECT session_id FROM nodes WHERE study_id = ?')
  for (const studyId of studyIds) {
    deleteSessions(db, (sessions.all(studyId, studyId) as { id: string | null }[]).flatMap(s => (s.id ? [s.id] : [])))
  }
}

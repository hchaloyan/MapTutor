import type { DatabaseSync } from 'node:sqlite'
import type { UsageRow } from '../tutor/engine'

export function recordUsage(db: DatabaseSync, projectId: string, studyId: string | null, row: UsageRow) {
  db.prepare(
    `INSERT INTO usage (project_id, study_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(projectId, studyId, row.model, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.webSearches, Date.now())
}

/** Totals per model, since tokens from different models cost different amounts. */
export function usageByModel(db: DatabaseSync, column: 'project_id' | 'study_id', id: string) {
  return db
    .prepare(
      `SELECT model, sum(input_tokens) AS inputTokens, sum(output_tokens) AS outputTokens, sum(cache_read_tokens) AS cacheReadTokens,
         sum(cache_write_tokens) AS cacheWriteTokens, sum(web_searches) AS webSearches
       FROM usage WHERE ${column} = ? GROUP BY model ORDER BY min(id)`,
    )
    .all(id)
}

import type Anthropic from '@anthropic-ai/sdk'
import type { DatabaseSync } from 'node:sqlite'

/** What a billed call reports. A `Message` or `BetaMessage` satisfies it. */
export type Billed = { model: string; usage: Anthropic.Usage | Anthropic.Beta.BetaUsage }
export type OnUsage = (billed: Billed) => void

export function recordUsage(db: DatabaseSync, projectId: string, studyId: string | null, { model, usage }: Billed) {
  db.prepare(
    `INSERT INTO usage (project_id, study_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectId, studyId, model, usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens ?? 0,
    usage.cache_creation_input_tokens ?? 0, usage.server_tool_use?.web_search_requests ?? 0, Date.now(),
  )
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

import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { afterQuizCheck, type NodeState } from './graph'
import { setNodeState } from './teach'
import type { ClientTool, Phase, ToolCtx } from './tools'

type Option = { id: string; text: string }
type Item = {
  id: string
  prompt: string
  options: Option[]
  correctOptionId: string
  explanation: string
  strand?: string
  nodeId?: string
}
type Quiz = { items: Item[] }

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const phaseOf = (ctx: ToolCtx) => (ctx.db.prepare('SELECT phase FROM studies WHERE id = ?').get(ctx.studyId) as { phase: Phase }).phase
/** Teach and done ask quiz-checks on nodes; probe and plan ask probe items on strands. */
const isCheck = (ctx: ToolCtx) => ['teach', 'done'].includes(phaseOf(ctx))

function problems(input: unknown, ctx: ToolCtx): string[] {
  const items = (input as Partial<Quiz> | null)?.items
  if (!Array.isArray(items) || items.length < 1 || items.length > 10) return ['A quiz needs 1–10 items.']
  const check = isCheck(ctx)
  const errors: string[] = []
  const seen = new Set<unknown>()
  items.forEach((it: Partial<Item>, i) => {
    const name = nonEmpty(it?.id) ? `Quiz item "${it.id}"` : `Quiz item ${i + 1}`
    if (!nonEmpty(it?.id)) errors.push(`${name} needs an id.`)
    else if (seen.has(it.id)) errors.push(`${name}: duplicate item id.`)
    seen.add(it?.id)
    if (!nonEmpty(it?.prompt)) errors.push(`${name} needs a prompt.`)
    if (!nonEmpty(it?.explanation)) errors.push(`${name} needs an explanation.`)
    const options = Array.isArray(it?.options) ? it.options : []
    const optionIds = options.map(o => o?.id)
    const validOptions =
      options.length >= 2 &&
      options.length <= 6 &&
      options.every(o => nonEmpty(o?.id) && nonEmpty(o?.text)) &&
      new Set(optionIds).size === optionIds.length
    if (!validOptions) errors.push(`${name} needs 2–6 options, each with a distinct id and non-empty text.`)
    else if (!optionIds.includes(it.correctOptionId!)) errors.push(`${name}: correctOptionId "${it.correctOptionId}" is not one of its option ids.`)
    if (check) {
      if (!nonEmpty(it?.nodeId)) errors.push(`${name} needs a nodeId during teaching.`)
      else if (!ctx.db.prepare('SELECT 1 FROM nodes WHERE id = ? AND study_id = ?').get(it.nodeId, ctx.studyId)) {
        errors.push(`${name}: node "${it.nodeId}" is not in this study.`)
      }
    } else if (!nonEmpty(it?.strand)) errors.push(`${name} needs a strand during the probe.`)
  })
  return errors
}

export const quizTool: ClientTool = {
  kind: 'client',
  def: {
    name: 'quiz',
    description: [
      'Ask the user graded multiple-choice questions. The app shows them as a card, grades the answers itself, and returns { results: [{ itemId, chosenOptionId, correct }] }. The user sees correctOptionId and explanation only after answering.',
      'Keep options even: every option is a bare claim with no justification, written in the same skeleton, length, grain size, and register as the others. Never bold a term in one option unless the parallel term is bolded in every option.',
      'During the probe (and plan), every item needs `strand`: a short topic tag, reused exactly for every question on that topic. During teaching, every item needs `nodeId`: the node it checks.',
      'Write math in LaTeX: $…$ inline, $$…$$ for display.',
    ].join('\n\n'),
    shape: {
      items: z
        .array(
          z.object({
            id: z.string(),
            prompt: z.string().describe('Markdown + LaTeX.'),
            options: z.array(z.object({ id: z.string(), text: z.string() })).min(2).max(6),
            correctOptionId: z.string(),
            explanation: z.string().describe('Shown only after the user answers. All reasoning goes here, never in options.'),
            strand: z.string().describe('Required during the probe.').optional(),
            nodeId: z.string().describe('Required during a quiz-check.').optional(),
          }),
        )
        .min(1)
        .max(10),
    },
  },
  phases: ['probe', 'plan', 'teach', 'done'],
  check: (input, ctx) => problems(input, ctx).join('\n') || null,
  card(input, _ctx, answered) {
    return {
      items: (input as Quiz).items.map(({ id, prompt, options, correctOptionId, explanation }) => ({
        id,
        prompt,
        options,
        ...(answered && { correctOptionId, explanation }),
      })),
    }
  },
  answer(input, answer, ctx, toolUseId) {
    const { items } = input as Quiz
    const raw = (answer as { choices?: unknown } | null)?.choices
    const choices = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    if (items.some(it => typeof choices[it.id] !== 'string')) return { error: 'Answer every question.' }
    if (items.some(it => !it.options.some(o => o.id === choices[it.id]))) return { error: "That isn't one of the options." }

    const check = isCheck(ctx)
    const insert = ctx.db.prepare(
      `INSERT INTO quiz_items (id, study_id, quiz_call_id, phase, strand, node_id, prompt, options, correct_option_id, explanation, chosen_option_id, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const now = Date.now()
    for (const it of items) {
      insert.run(
        `${toolUseId}:${it.id}`, ctx.studyId, toolUseId, check ? 'check' : 'probe', check ? null : it.strand!, check ? it.nodeId! : null,
        it.prompt, JSON.stringify(it.options), it.correctOptionId, it.explanation, choices[it.id] as string, now,
      )
    }
    if (check) applyChecks(ctx, items, choices)
    const results = items.map(it => ({ itemId: it.id, chosenOptionId: choices[it.id], correct: choices[it.id] === it.correctOptionId }))
    return { content: JSON.stringify({ results }) }
  },
}

/** A node passes a quiz-check only if every item on it in this call is correct. */
function applyChecks({ db, studyId }: ToolCtx, items: Item[], choices: Record<string, unknown>) {
  const passed = new Map<string, boolean>()
  for (const it of items) passed.set(it.nodeId!, (passed.get(it.nodeId!) ?? true) && choices[it.id] === it.correctOptionId)
  for (const [nodeId, ok] of passed) {
    const node = db.prepare('SELECT state, ever_known FROM nodes WHERE study_id = ? AND id = ?').get(studyId, nodeId) as { state: NodeState; ever_known: number }
    setNodeState(db, studyId, nodeId, afterQuizCheck(node.state, node.ever_known === 1, ok))
  }
}

/** Probe strands with their scores, in order of first use. Names are exact (case-sensitive). */
export function probeStrands(db: DatabaseSync, studyId: string) {
  return db
    .prepare(
      `SELECT strand, sum(chosen_option_id = correct_option_id) AS correct, count(*) AS total
       FROM quiz_items WHERE study_id = ? AND phase = 'probe' GROUP BY strand ORDER BY min(rowid)`,
    )
    .all(studyId) as { strand: string; correct: number; total: number }[]
}

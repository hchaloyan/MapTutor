import type { DatabaseSync } from 'node:sqlite'
import { z, type ZodRawShape } from 'zod'
import { proposeGraphTool } from './plan'
import { quizTool } from './quiz'
import { focusNodeTool, setNodeStateTool } from './teach'

export type Phase = 'probe' | 'plan' | 'teach' | 'done'
export type ToolCtx = { db: DatabaseSync; studyId: string; nodeId: string | null }
/** `shape` is the input schema the tutor server publishes. */
export type ToolDef = { name: string; description: string; shape: ZodRawShape }

/** Renders a card and pauses the loop until the user answers. */
export type ClientTool = {
  kind: 'client'
  def: ToolDef
  phases: Phase[]
  /** Error message for the tutor when the input is unusable, else null. */
  check(input: unknown, ctx: ToolCtx): string | null
  /** Side effects of a valid call, run before the card is stored and shown. */
  onPause?(input: unknown, ctx: ToolCtx): void
  /** What the client may see; `answered` unlocks what must stay hidden until the user answers. */
  card(input: unknown, ctx: ToolCtx, answered: boolean): unknown
  answer(input: unknown, answer: unknown, ctx: ToolCtx, toolUseId: string): { content: string } | { error: string }
}

/** Runs immediately on the server. */
export type ServerTool = {
  kind: 'server'
  def: ToolDef
  phases: Phase[]
  /** `switchTo` moves the rest of the turn into that node's thread, opened with `note`. */
  run(input: unknown, ctx: ToolCtx): { content: string; isError?: boolean; switchTo?: { nodeId: string; note: string } }
}

export type Tool = ClientTool | ServerTool

const ALL_PHASES: Phase[] = ['probe', 'plan', 'teach', 'done']

type Question = { question: string; options: { label: string; description?: string }[]; multiSelect?: boolean }

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

const askUserQuestion: ClientTool = {
  kind: 'client',
  def: {
    name: 'ask_user_question',
    description:
      'Ask the user a question that has no right answer: their goal, a preference, or what to do next. Renders a card with 2–4 options; the app always adds an "Other" choice where the user types their own answer. Returns { answers: string[] }: the chosen labels, or the text the user typed.',
    shape: {
      question: z.string(),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(2).max(4),
      multiSelect: z.boolean().describe('Allow choosing more than one option.').optional(),
    },
  },
  phases: ALL_PHASES,
  check(input) {
    const q = input as Partial<Question>
    const labels = Array.isArray(q.options) ? q.options.map(o => o?.label) : []
    const ok =
      nonEmpty(q.question) &&
      labels.length >= 2 &&
      labels.length <= 4 &&
      labels.every(nonEmpty) &&
      new Set(labels.map(l => l.trim())).size === labels.length &&
      (q.multiSelect === undefined || typeof q.multiSelect === 'boolean')
    return ok ? null : 'ask_user_question needs a question and 2–4 options, each with a non-empty, distinct label.'
  },
  card: input => input,
  answer(input, answer) {
    const raw = (answer as { answers?: unknown })?.answers
    const answers = Array.isArray(raw) ? raw.filter(nonEmpty).map(a => a.trim()) : []
    if (!answers.length) return { error: 'Pick an option or write your own answer.' }
    if (!(input as Question).multiSelect && answers.length > 1) return { error: 'Pick exactly one answer.' }
    return { content: JSON.stringify({ answers }) }
  },
}

const setGoalTitle: ServerTool = {
  kind: 'server',
  def: {
    name: 'set_goal_title',
    description: "Name the goal once it is concrete: a short title of about 2–6 words. The app shows it as the goal's name.",
    shape: { title: z.string().max(80) },
  },
  phases: ['probe', 'plan'],
  run(input, { db, studyId }) {
    const raw = (input as { title?: unknown } | null)?.title
    const title = typeof raw === 'string' ? raw.trim() : ''
    if (!title || title.length > 80) return { content: 'set_goal_title needs a title of 1–80 characters.', isError: true }
    db.prepare('UPDATE studies SET title = ? WHERE id = ?').run(title, studyId)
    return { content: `Goal title set to "${title}".` }
  },
}

export const TOOLS: Tool[] = [askUserQuestion, quizTool, proposeGraphTool, focusNodeTool, setNodeStateTool, setGoalTitle]

/** Claude Code's WebSearch is always available. */
export const allowedTools = (phase: Phase) => [...TOOLS.filter(t => t.phases.includes(phase)).map(t => t.def.name), 'WebSearch']

import type Anthropic from '@anthropic-ai/sdk'
import type { DatabaseSync } from 'node:sqlite'
import { proposeGraphTool } from './plan'
import { quizTool } from './quiz'

export type Phase = 'probe' | 'plan' | 'teach' | 'done'
export type ToolCtx = { db: DatabaseSync; studyId: string; nodeId: string | null }

/** Renders a card and pauses the loop until the user answers. */
export type ClientTool = {
  kind: 'client'
  def: Anthropic.Beta.BetaTool
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
  def: Anthropic.Beta.BetaTool
  phases: Phase[]
  run(input: unknown, ctx: ToolCtx): { content: string; isError?: boolean }
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
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, description: { type: 'string' } },
            required: ['label'],
          },
        },
        multiSelect: { type: 'boolean', description: 'Allow choosing more than one option.' },
      },
      required: ['question', 'options'],
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

export const TOOLS: Tool[] = [askUserQuestion, quizTool, proposeGraphTool]

/** Anthropic's server tools are always available; context.ts declares them. */
export const allowedTools = (phase: Phase) => [...TOOLS.filter(t => t.phases.includes(phase)).map(t => t.def.name), 'web_search']

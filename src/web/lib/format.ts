import type { NodeState, Phase, Usage } from './api'

export const countLabel = (n: number, noun: 'goal' | 'file') => (n === 0 ? `no ${noun}s` : `${n} ${noun}${n === 1 ? '' : 's'}`)

/** The tutor's short title once it has set one; until then, what the user typed. */
export const goalName = (s: { title: string | null; goal: string }) => s.title ?? s.goal

const PHASES: Record<Phase, string> = { probe: 'Probe', plan: 'Plan', teach: 'Teach', done: 'Done ✓' }
export const phaseLabel = (phase: Phase) => ({ text: PHASES[phase], done: phase === 'done' })

export const STATES: NodeState[] = ['known', 'frontier', 'missed', 'untested']

export const masterySegments = (counts: Record<NodeState, number>) =>
  STATES.map(state => ({ state, count: counts[state] })).filter(s => s.count > 0)

const MB = 1024 * 1024
const mb = (n: number) => Number((n / MB).toFixed(1))

export const formatBytes = (n: number) => (n >= MB ? `${mb(n)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

// The server's project limit (MAX_PROJECT_BYTES).
export const usedLabel = (bytes: number) => `${mb(bytes)} of 20 MB used`

const BADGES = { pdf: ['PDF', 'pdf'], image: ['IMG', 'image'], url: ['URL', 'url'] } as const

export function fileBadge(f: { kind: 'pdf' | 'image' | 'text' | 'url'; name: string }) {
  if (f.kind === 'text') return { label: /\.txt$/i.test(f.name) ? 'TXT' : 'MD', color: 'var(--badge-text)' }
  const [label, token] = BADGES[f.kind]
  return { label, color: `var(--badge-${token})` }
}

/** The graph pane's share of the goal screen, in percent. */
export const clampSplit = (pct: number) => Math.min(75, Math.max(25, pct))

/** `claude-opus-5-5` (optionally with a date suffix) → `Opus 5.5`; other IDs as-is. */
export function modelName(id: string) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(-\d{8})?$/.exec(id)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id
}

export const formatTokens = (n: number) => (n < 1000 ? String(n) : n < 999_950 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`)

export const usageTotals = (usage: Usage) => ({
  tokens: usage.reduce((sum, u) => sum + u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens, 0),
  searches: usage.reduce((sum, u) => sum + u.webSearches, 0),
})

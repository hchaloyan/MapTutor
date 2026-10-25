import type { NodeState } from '../lib/api'
import { masterySegments } from '../lib/format'

/** Segments in state colors sized by node counts; an empty gray track before the map exists. */
export function MasteryBar({ counts, width, height = 6 }: { counts: Record<NodeState, number>; width?: number; height?: number }) {
  const segments = masterySegments(counts)
  return (
    <span className={`mastery${segments.length ? '' : ' empty'}`} style={{ width, height }} aria-hidden="true">
      {segments.map(s => (
        <i key={s.state} style={{ flex: s.count, background: `var(--${s.state})` }} />
      ))}
    </span>
  )
}

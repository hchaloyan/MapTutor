import { Check } from 'lucide-react'
import { Fragment } from 'react'
import type { Phase } from '../lib/api'

const STEPS: [Phase, string][] = [
  ['probe', 'Probe'],
  ['plan', 'Plan'],
  ['teach', 'Teach'],
  ['done', 'Done'],
]

/** Probe — Plan — Teach — Done; the current step is in ink with an accent dot, and Done lights with ✓. */
export function PhaseSteps({ phase }: { phase: Phase }) {
  return (
    <div className="steps" aria-label={`Phase: ${phase}`}>
      {STEPS.map(([p, label], i) => (
        <Fragment key={p}>
          {i > 0 && <i className="step-line" />}
          <span className={`step${p === phase ? ' on' : ''}`}>{label}
            {p === 'done' && phase === 'done' && <Check size={14} strokeWidth={3} />}</span>
        </Fragment>
      ))}
    </div>
  )
}

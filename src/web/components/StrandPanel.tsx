import type { Strand } from '../lib/api'

/** What the graph pane shows before the tutor proposes a map: how each probed strand went. */
export function StrandPanel({ strands }: { strands: Strand[] }) {
  return (
    <div className="strands">
      <h2>Finding your edge</h2>
      <p>Your map appears once the tutor proposes a plan.</p>
      {strands.length === 0 ? (
        <p className="strands-wait">The tutor is settling your goal.</p>
      ) : (
        strands.map(s => (
          <div key={s.strand} className="strand-row">
            <span className="strand-name ellipsis">{s.strand}</span>
            <span className="strand-bar" aria-hidden="true">
              {s.correct > 0 && <i style={{ flex: s.correct, background: 'var(--known)' }} />}
              {s.total - s.correct > 0 && <i style={{ flex: s.total - s.correct, background: 'var(--missed)' }} />}
            </span>
            <span className="strand-score">
              {s.correct}/{s.total}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

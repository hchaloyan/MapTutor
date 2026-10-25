import { useState } from 'react'
import type { Card } from '../lib/api'
import { Markdown } from './Markdown'

/** The proposed approach with Approve plan / Suggest changes; the map shows in the graph pane meanwhile. */
export function PlanCard({ card, onAnswer, disabled }: { card: Card; onAnswer(answer: unknown): void; disabled: boolean }) {
  const [suggesting, setSuggesting] = useState(false)
  const [text, setText] = useState('')
  const answer = card.answer as { decision: 'approved' } | { decision: 'feedback'; text: string } | null

  return (
    <div className="card">
      <div className="card-label">PROPOSED PLAN</div>
      <Markdown text={card.input.approach} />
      {!card.pending ? (
        answer?.decision === 'approved' ? (
          <div className="plan-outcome approved">✓ Approved</div>
        ) : (
          answer && <div className="plan-outcome">You asked for changes: {answer.text}</div>
        )
      ) : suggesting ? (
        <div className="plan-suggest">
          <textarea autoFocus rows={3} value={text} placeholder="What should change?" aria-label="Suggested changes" onChange={e => setText(e.target.value)} />
          <div className="card-foot">
            <span className="grow" />
            <button className="btn btn-secondary" onClick={() => setSuggesting(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={disabled || !text.trim()} onClick={() => onAnswer({ decision: 'feedback', text: text.trim() })}>
              Send
            </button>
          </div>
        </div>
      ) : (
        <div className="card-foot">
          <span className="grow" />
          <button className="btn btn-secondary" disabled={disabled} onClick={() => setSuggesting(true)}>
            Suggest changes
          </button>
          <button className="btn btn-primary" disabled={disabled} onClick={() => onAnswer({ decision: 'approved' })}>
            Approve plan
          </button>
        </div>
      )}
    </div>
  )
}

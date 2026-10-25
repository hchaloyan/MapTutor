import { Check } from 'lucide-react'
import { useState } from 'react'
import type { Card } from '../lib/api'
import { questionAnswer } from '../lib/cards'

type Question = { question: string; options: { label: string; description?: string }[]; multiSelect?: boolean }

/** A menu of answers with no right one; "Other" is always last. Single choice answers on click. */
export function QuestionCard({ card, onAnswer, disabled }: { card: Card; onAnswer(answer: unknown): void; disabled: boolean }) {
  const q = card.input as Question
  const [picked, setPicked] = useState<string[]>([])
  const [other, setOther] = useState('')
  const [otherOn, setOtherOn] = useState(false)

  if (!card.pending) {
    const answers = (card.answer?.answers ?? []) as string[]
    const typed = answers.filter(a => !q.options.some(o => o.label === a))
    return (
      <div className="card question">
        <div className="question-text">{q.question}</div>
        {q.options.map(o => (
          <div key={o.label} className={`menu-row${answers.includes(o.label) ? ' chosen' : ' faded'}`}>
            <span className="menu-text">
              <span className="menu-label">{o.label}</span>
              {o.description && <span className="menu-desc">{o.description}</span>}
            </span>
          </div>
        ))}
        {typed.map(t => (
          <div key={t} className="menu-row chosen">
            <span className="menu-label">{t}</span>
          </div>
        ))}
      </div>
    )
  }

  const multi = !!q.multiSelect
  const toggle = (label: string) => setPicked(p => (p.includes(label) ? p.filter(l => l !== label) : [...p, label]))
  const sendMulti = () => onAnswer(questionAnswer(picked, otherOn ? other : ''))

  return (
    <div className="card question">
      <div className="question-text">{q.question}</div>
      {multi && <div className="question-sub">Pick any</div>}
      {q.options.map(o => (
        <button
          key={o.label}
          className={`menu-row${multi && picked.includes(o.label) ? ' chosen' : ''}`}
          disabled={disabled}
          role={multi ? 'checkbox' : undefined}
          aria-checked={multi ? picked.includes(o.label) : undefined}
          onClick={() => (multi ? toggle(o.label) : onAnswer({ answers: [o.label] }))}
        >
          {multi && <span className={`box${picked.includes(o.label) ? ' on' : ''}`}>{picked.includes(o.label) && <Check size={13} strokeWidth={3} />}</span>}
          <span className="menu-text">
            <span className="menu-label">{o.label}</span>
            {o.description && <span className="menu-desc">{o.description}</span>}
          </span>
        </button>
      ))}
      <div className="menu-row other">
        {multi && (
          <button className={`box${otherOn ? ' on' : ''}`} aria-label="Include my own answer" onClick={() => setOtherOn(!otherOn)}>
            {otherOn && <Check size={13} strokeWidth={3} />}
          </button>
        )}
        <input
          value={other}
          disabled={disabled}
          placeholder="Something else…"
          aria-label="Something else"
          onChange={e => {
            setOther(e.target.value)
            setOtherOn(!!e.target.value.trim())
          }}
          onKeyDown={e => e.key === 'Enter' && other.trim() && (multi ? sendMulti() : onAnswer(questionAnswer([], other)))}
        />
        {!multi && other.trim() && (
          <button className="btn btn-primary btn-small" disabled={disabled} onClick={() => onAnswer(questionAnswer([], other))}>
            Send
          </button>
        )}
      </div>
      {multi && (
        <div className="card-foot">
          <span className="grow" />
          <button className="btn btn-primary" disabled={disabled || !questionAnswer(picked, otherOn ? other : '').answers.length} onClick={sendMulti}>
            Send
          </button>
        </div>
      )}
    </div>
  )
}

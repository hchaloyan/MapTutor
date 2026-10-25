import { Check, ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Card } from '../lib/api'
import { LETTERS, type QuizItem, quizKey, quizSummary } from '../lib/cards'
import { Markdown } from './Markdown'

type Props = { card: Card; onAnswer(answer: unknown): void; disabled: boolean }

export function QuizCard(props: Props) {
  return props.card.pending ? <QuizPages {...props} /> : <QuizResults card={props.card} />
}

/** One question per page; picking doesn't advance. */
function QuizPages({ card, onAnswer, disabled }: Props) {
  const items = card.input.items as QuizItem[]
  const [page, setPage] = useState(0)
  const [choices, setChoices] = useState<Record<string, string>>({})
  const item = items[page]
  const last = page === items.length - 1
  const ready = last ? items.every(it => choices[it.id]) : !!choices[item.id]

  const pick = (optionId: string) => setChoices(c => ({ ...c, [item.id]: optionId }))
  const next = () => {
    if (!ready || disabled) return
    if (last) onAnswer({ choices })
    else setPage(page + 1)
  }
  const back = () => page > 0 && setPage(page - 1)

  useEffect(() => {
    if (disabled) return
    const onKey = (e: KeyboardEvent) => {
      const action = quizKey({ key: e.key, target: e.target as HTMLElement }, item.options.length)
      if (action === null || e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      if (action === 'next') next()
      else if (action === 'back') back()
      else pick(item.options[action].id)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  return (
    <div className="card">
      <div className="card-head">
        <span>
          QUESTION {page + 1} OF {items.length}
        </span>
        <span className="dots" aria-hidden="true">
          {items.map((it, i) => (
            <i key={it.id} className={choices[it.id] ? 'on' : i === page ? 'cur' : ''} />
          ))}
        </span>
      </div>
      <div className="quiz-prompt">
        <Markdown text={item.prompt} />
      </div>
      <div className="options" role="radiogroup">
        {item.options.map((o, i) => (
          <button
            key={o.id}
            role="radio"
            aria-checked={choices[item.id] === o.id}
            className={`option${choices[item.id] === o.id ? ' selected' : ''}`}
            disabled={disabled}
            onClick={() => pick(o.id)}
          >
            <b>{LETTERS[i]}</b>
            <Markdown text={o.text} inline />
          </button>
        ))}
      </div>
      <div className="card-foot">
        {page > 0 && (
          <button className="btn btn-secondary" onClick={back}>
            Back
          </button>
        )}
        <span className="grow" />
        <button className="btn btn-primary" disabled={!ready || disabled} onClick={next}>
          {last ? 'Submit answers' : 'Next'}
        </button>
      </div>
    </div>
  )
}

/** After submitting: one row per question; misses open showing the right answer, the pick, and why. */
function QuizResults({ card }: { card: Card }) {
  const summary = quizSummary(card)
  const [open, setOpen] = useState(() => new Set(summary.rows.filter(r => !r.right).map(r => r.item.id)))
  const toggle = (id: string) =>
    setOpen(s => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <div className="card">
      <div className="card-head">
        <span>
          QUIZ · {summary.correct} OF {summary.total} CORRECT
        </span>
        <span className="dots" aria-hidden="true">
          {summary.rows.map(r => (
            <i key={r.item.id} className={r.right ? 'ok' : 'no'} />
          ))}
        </span>
      </div>
      {summary.rows.map(({ item, chosen, right }) => (
        <div key={item.id} className="result">
          <button className="result-row" aria-expanded={open.has(item.id)} onClick={() => toggle(item.id)}>
            <span className={`mark ${right ? 'ok' : 'no'}`} aria-label={right ? 'Correct' : 'Wrong'}>
              {right ? <Check size={14} strokeWidth={3} /> : <X size={14} strokeWidth={3} />}
            </span>
            <span className="result-prompt">
              <Markdown text={item.prompt} inline />
            </span>
            <span className="chev" aria-hidden="true">
              {open.has(item.id) ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </span>
          </button>
          {open.has(item.id) && (
            <div className="result-open">
              <div className="options">
                {item.options.map((o, i) => {
                  const isRight = o.id === item.correctOptionId
                  const isPick = o.id === chosen
                  return (
                    <div key={o.id} className={`option${isRight ? ' right' : isPick ? ' wrong' : ' faded'}`}>
                      <b>{LETTERS[i]}</b>
                      <Markdown text={o.text} inline />
                      {isRight ? <span className="tag">Correct</span> : isPick && <span className="tag">Your answer</span>}
                    </div>
                  )
                })}
              </div>
              {item.explanation && (
                <div className="why">
                  <strong>Why: </strong>
                  <Markdown text={item.explanation} inline />
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

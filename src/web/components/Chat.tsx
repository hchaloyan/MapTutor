import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Card, ThreadItem } from '../lib/api'
import { errorView, liveSegments, type Turn } from '../lib/turn'
import { Markdown } from './Markdown'

function Waiting({ status, since }: { status: Turn['status']; since: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return (
    <div className="tutor waiting" role="status">
      <span className="spinner" aria-hidden="true" />
      {status === 'searching' ? 'Searching the web' : 'Thinking'} · {seconds}s
    </div>
  )
}

export function Chat(props: {
  title: string
  inMain: boolean
  onMain(): void
  items: ThreadItem[]
  turn: Turn
  draft: string
  setDraft(text: string): void
  queued: boolean
  composerPaused: string | null
  onSend(): void
  onStop(): void
  onRetry(): void
  onKeyLink(): void
  renderCard(card: Card): ReactNode
  banner?: ReactNode
  /** Drawn after the live reply and any error (the goal-complete card). */
  after?: ReactNode
}) {
  const { turn } = props
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const segments = liveSegments(turn)

  // Follow new text unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  const error = turn.error && !turn.running ? errorView(turn.error) : null
  const paused = props.composerPaused

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="ellipsis">{props.title}</span>
        {!props.inMain && (
          <button className="btn btn-secondary btn-small" onClick={props.onMain}>
            Main chat
          </button>
        )}
      </div>
      {props.banner ?? (
        <div
          ref={scroller}
          className="messages"
          onScroll={e => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {props.items.map((item, i) =>
            item.type === 'card' ? (
              <div key={item.toolUseId}>{props.renderCard(item)}</div>
            ) : item.type === 'user' ? (
              <div key={i} className="user">
                {item.text}
              </div>
            ) : (
              <div key={i} className="tutor">
                <Markdown text={item.text} />
              </div>
            ),
          )}
          {segments.map((text, i) =>
            text ? (
              <div key={`live${turn.dropped + i}`} className="tutor">
                <Markdown text={text} />
              </div>
            ) : (
              <Waiting key={`wait${turn.waitingSince}`} status={turn.status} since={turn.waitingSince} />
            ),
          )}
          {error && (
            <div className="chat-error">
              {error.text}
              {error.keyLink && (
                <>
                  {' '}
                  <button className="text-action" onClick={props.onKeyLink}>
                    API key
                  </button>
                  .
                </>
              )}{' '}
              <button className="text-action" onClick={props.onRetry}>
                Retry
              </button>
            </div>
          )}
          {props.after}
        </div>
      )}
      <div className={`composer${paused ? ' paused' : ''}`}>
        <textarea
          rows={1}
          value={paused ? '' : props.draft}
          disabled={!!paused}
          placeholder={paused ?? (props.queued ? 'Sends when the reply finishes…' : 'Message the tutor…')}
          aria-label="Message the tutor"
          onChange={e => props.setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              props.onSend()
            }
          }}
        />
        {turn.running ? (
          <button className="btn btn-primary" onClick={props.onStop}>
            <span className="stop-icon" aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button className="btn btn-primary" disabled={!!paused || !props.draft.trim()} onClick={props.onSend}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}

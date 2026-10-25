import { useState } from 'react'
import { api, type StudySummary } from '../lib/api'
import { useApp } from '../lib/app'
import { goalName, phaseLabel } from '../lib/format'
import { navigate } from '../lib/router'
import { ConfirmDialog } from './Dialog'
import { MasteryBar } from './MasteryBar'

/** Starting a goal opens it; the goal screen sends the typed text as the first message. */
export function NewGoal({ projectId }: { projectId: string }) {
  const app = useApp()
  const [goal, setGoal] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function start() {
    const text = goal.trim()
    if (!text || !app.requireKey()) return
    try {
      const study = await api<StudySummary>(`/api/projects/${projectId}/studies`, { method: 'POST', json: { goal: text } })
      navigate(`/goals/${study.id}`, { firstMessage: text })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <section>
      <div className="section-head">ADD A NEW GOAL</div>
      <div className="surface new-goal">
        <textarea
          value={goal}
          rows={2}
          aria-label="New goal"
          placeholder={'What do you want to learn? e.g. "help me study for the midterm"'}
          onChange={e => setGoal(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              start()
            }
          }}
        />
        <div className="new-goal-row">
          <button className="btn btn-primary" disabled={!goal.trim()} onClick={start}>
            Start
          </button>
        </div>
      </div>
      {error && <div className="error-line">{error}</div>}
    </section>
  )
}

export function GoalList({ studies, onChange }: { studies: StudySummary[]; onChange(): void }) {
  const [deleting, setDeleting] = useState<StudySummary | null>(null)
  return (
    <section>
      <div className="section-head">GOALS</div>
      <div className="surface">
        {studies.length === 0 && <div className="empty-row">No goals yet. Add one above.</div>}
        {studies.map(s => {
          const phase = phaseLabel(s.phase)
          return (
            <div key={s.id} className="row goal-row" role="link" tabIndex={0} onClick={() => navigate(`/goals/${s.id}`)} onKeyDown={e => e.key === 'Enter' && navigate(`/goals/${s.id}`)}>
              <span className="goal-name ellipsis">{goalName(s)}</span>
              <span className={`goal-phase${phase.done ? ' done' : ''}`}>{phase.text}</span>
              <MasteryBar counts={s.counts} width={150} />
              <button
                className="row-x"
                aria-label="Delete this goal"
                onClick={e => {
                  e.stopPropagation()
                  setDeleting(s)
                }}
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
      {deleting && (
        <ConfirmDialog
          title="Delete this goal?"
          body="This removes its map and chats. It can't be undone."
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/api/studies/${deleting.id}`, { method: 'DELETE' })
            setDeleting(null)
            onChange()
          }}
        />
      )}
    </section>
  )
}

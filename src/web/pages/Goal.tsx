import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Chat } from '../components/Chat'
import { PhaseSteps } from '../components/PhaseSteps'
import { PlanCard } from '../components/PlanCard'
import { QuestionCard } from '../components/QuestionCard'
import { QuizCard } from '../components/QuizCard'
import { SplitPane } from '../components/SplitPane'
import { StrandPanel } from '../components/StrandPanel'
import { TopBar } from '../components/TopBar'
import { api, type Card, type Project, type Study, type ThreadItem } from '../lib/api'
import { useApp } from '../lib/app'
import { goalName } from '../lib/format'
import { navigate } from '../lib/router'
import { postStream } from '../lib/sse'
import { idleTurn, turnReducer } from '../lib/turn'

const threadQuery = (id: string | null) => (id ? `?nodeId=${encodeURIComponent(id)}` : '')

export function Goal({ goalId }: { goalId: string }) {
  const app = useApp()
  const [study, setStudy] = useState<Study | null>(null)
  const [projectName, setProjectName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [threadId, setThreadId] = useState<string | null | undefined>(undefined) // undefined until the study loads
  const [items, setItems] = useState<ThreadItem[]>([])
  const [turn, dispatch] = useReducer(turnReducer, idleTurn)
  const [draft, setDraft] = useState('')
  const [queued, setQueued] = useState<string | null>(null)

  // Refs for callbacks that outlive a render: the open thread, the latest turn, and a guard against double sends.
  const threadRef = useRef(threadId)
  threadRef.current = threadId
  const turnRef = useRef(turn)
  turnRef.current = turn
  const busy = useRef(false)
  const queuedRef = useRef(queued)
  queuedRef.current = queued

  const loadStudy = useCallback(async () => {
    const s = await api<Study>(`/api/studies/${goalId}`)
    setStudy(s)
    return s
  }, [goalId])

  const loadThread = useCallback(
    async (id: string | null) => {
      const list = await api<ThreadItem[]>(`/api/studies/${goalId}/thread${threadQuery(id)}`)
      if (threadRef.current === id) setItems(list)
      return list
    },
    [goalId],
  )

  useEffect(() => {
    loadStudy()
      .then(s => {
        setThreadId(s.phase === 'teach' || s.phase === 'done' ? s.focusNodeId : null)
        return api<Project>(`/api/projects/${s.projectId}`)
      })
      .then(p => setProjectName(p.name))
      .catch(err => setError((err as Error).message))
  }, [loadStudy])

  /** Runs one turn route to its `done`. Returns whether the turn ended waiting on a card. */
  const runTurn = useCallback(
    async (path: string, json: object) => {
      let awaiting = false
      dispatch({ type: 'start', now: Date.now() })
      try {
        await postStream(`/api/studies/${goalId}/${path}`, json, e => {
          dispatch({ type: 'event', event: e.event, data: e.data, now: Date.now() })
          if (e.event === 'focus') setThreadId(e.data.nodeId)
          if (e.event === 'done') awaiting = e.data.awaiting
          if (e.event === 'error' && e.data.message === 'Your Anthropic API key was rejected.') app.setKeyStatus('rejected')
        })
      } catch (err) {
        dispatch({ type: 'fail', message: (err as Error).message })
      }
      return awaiting
    },
    [goalId, app],
  )

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || !app.requireKey()) return
      if (busy.current) {
        setQueued(text)
        setDraft('')
        return
      }
      busy.current = true
      setDraft('')
      setItems(list => [...list, { type: 'user', text, createdAt: Date.now() }])
      const awaiting = await runTurn('messages', { text, ...(threadRef.current && { nodeId: threadRef.current }) })
      busy.current = false
      const next = queuedRef.current
      if (next) {
        setQueued(null)
        if (awaiting) setDraft(next)
        else send(next)
      }
    },
    [app, runTurn],
  )

  const sendRef = useRef(send)
  sendRef.current = send

  /** Retry and card answers: turns that add no visible user message. */
  const resume = useCallback(
    async (path: string, json: object) => {
      if (busy.current || !app.requireKey()) return
      busy.current = true
      await runTurn(path, json)
      busy.current = false
    },
    [app, runTurn],
  )

  // The thread or study changed on the server: refetch, then drop the live text the thread now holds.
  useEffect(() => {
    if (turn.refetch === 0 || threadRef.current === undefined) return
    const upTo = turnRef.current.committed
    Promise.all([loadThread(threadRef.current), loadStudy()])
      .then(() => dispatch({ type: 'synced', upTo }))
      .catch(() => {})
  }, [turn.refetch, loadThread, loadStudy])

  // Opening a thread: load it; a brand-new goal sends its first message once.
  useEffect(() => {
    if (threadId === undefined) return
    loadThread(threadId)
      .then(list => {
        const first = (history.state as { firstMessage?: string } | null)?.firstMessage
        if (first && threadId === null && list.length === 0) {
          history.replaceState(null, '')
          sendRef.current(first)
        }
      })
      .catch(err => setError((err as Error).message))
  }, [threadId, loadThread])

  if (error) return <div className="first-run error-line">{error}</div>
  if (!study || threadId === undefined) return null

  const node = study.nodes.find(n => n.id === threadId)
  const pendingCard = items.some(i => i.type === 'card' && i.pending)

  return (
    <div className="app">
      <TopBar
        left={
          <>
            <button className="text-action muted back-link ellipsis" onClick={() => navigate(`/projects/${study.projectId}`)}>
              ← {projectName}
            </button>
            <span className="goal-title ellipsis" title={study.goal}>
              {goalName(study)}
            </span>
          </>
        }
        center={<PhaseSteps phase={study.phase} />}
      />
      <main className="page">
        <SplitPane
          left={<div className="graph-pane">{study.nodes.length === 0 ? <StrandPanel strands={study.strands} /> : null}</div>}
          right={
            <Chat
              title={node?.label ?? 'Main chat'}
              inMain={threadId === null}
              onMain={() => setThreadId(null)}
              items={items}
              turn={turn}
              draft={draft}
              setDraft={setDraft}
              queued={!!queued}
              composerPaused={pendingCard && !turn.running ? 'Answer the card above to continue' : null}
              onSend={() => send(draft)}
              onStop={() => api(`/api/studies/${goalId}/stop`, { method: 'POST' }).catch(() => {})}
              onRetry={() => resume('retry', threadId ? { nodeId: threadId } : {})}
              onKeyLink={() => app.setKeyPanelOpen(true)}
              renderCard={(card: Card) => {
                const props = { card, disabled: turn.running, onAnswer: (answer: unknown) => resume('tool-results', { toolUseId: card.toolUseId, answer }) }
                return card.name === 'quiz' ? <QuizCard {...props} /> : card.name === 'propose_graph' ? <PlanCard {...props} /> : <QuestionCard {...props} />
              }}
            />
          }
        />
      </main>
    </div>
  )
}

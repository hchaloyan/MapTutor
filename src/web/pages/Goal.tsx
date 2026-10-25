import { ArrowLeft } from 'lucide-react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Chat } from '../components/Chat'
import { Confetti } from '../components/Confetti'
import { MasteryBar } from '../components/MasteryBar'
import { StudyMap } from '../components/Map'
import { PhaseSteps } from '../components/PhaseSteps'
import { PlanCard } from '../components/PlanCard'
import { PrereqBanner } from '../components/PrereqBanner'
import { QuestionCard } from '../components/QuestionCard'
import { QuizCard } from '../components/QuizCard'
import { SplitPane } from '../components/SplitPane'
import { StrandPanel } from '../components/StrandPanel'
import { TopBar } from '../components/TopBar'
import { UsageButton } from '../components/Usage'
import { api, type Card, type NodeState, type Phase, type Project, type Study, type ThreadItem } from '../lib/api'
import { goalName, STATES } from '../lib/format'
import { prereqText } from '../lib/graph'
import { navigate } from '../lib/router'
import { postStream } from '../lib/sse'
import { idleTurn, turnReducer } from '../lib/turn'

const threadQuery = (id: string | null) => (id ? `?nodeId=${encodeURIComponent(id)}` : '')

export function Goal({ goalId }: { goalId: string }) {
  const [study, setStudy] = useState<Study | null>(null)
  const [projectName, setProjectName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [threadId, setThreadId] = useState<string | null | undefined>(undefined) // undefined until the study loads
  const [items, setItems] = useState<ThreadItem[]>([])
  const [turn, dispatch] = useReducer(turnReducer, idleTurn)
  const [draft, setDraft] = useState('')
  const [queued, setQueued] = useState<string | null>(null)
  const [turnThread, setTurnThread] = useState<string | null | undefined>(undefined) // where the live reply belongs
  const [burst, setBurst] = useState<{ x: number; y: number } | null>(null)
  const pane = useRef<HTMLDivElement>(null)
  const lastPhase = useRef<Phase | null>(null)
  const [banner, setBanner] = useState<{ nodeId: string; weak: { id: string; state: NodeState }[] } | null>(null)

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
      let ended = false
      setTurnThread(threadRef.current)
      dispatch({ type: 'start', now: Date.now() })
      try {
        await postStream(`/api/studies/${goalId}/${path}`, json, e => {
          dispatch({ type: 'event', event: e.event, data: e.data, now: Date.now() })
          if (e.event === 'focus') {
            setBanner(null)
            setThreadId(e.data.nodeId)
            setTurnThread(e.data.nodeId)
          }
          if (e.event === 'done') {
            awaiting = e.data.awaiting
            ended = true
          }
        })
        // A 204 (e.g. `open` on a thread that has history by now) sends no `done`; end the turn so it refetches.
        if (!ended) dispatch({ type: 'event', event: 'done', data: { awaiting: false }, now: Date.now() })
      } catch (err) {
        dispatch({ type: 'fail', message: (err as Error).message })
      }
      return awaiting
    },
    [goalId],
  )

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return
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
    [runTurn],
  )

  const sendRef = useRef(send)
  sendRef.current = send

  /** Retry and card answers: turns that add no visible user message. */
  const resume = useCallback(
    async (path: string, json: object) => {
      if (busy.current) return
      busy.current = true
      await runTurn(path, json)
      busy.current = false
    },
    [runTurn],
  )

  /** Shows a node's thread; an empty one starts its lesson unless a turn is running. */
  const proceed = useCallback(
    async (nodeId: string) => {
      setBanner(null)
      setThreadId(nodeId)
      const list = await loadThread(nodeId).catch(() => null)
      if (list?.length === 0 && threadRef.current === nodeId) resume('open', { nodeId })
    },
    [loadThread, resume],
  )

  /** A map click (Teach/Done only): weak prerequisites show the banner first. Mid-turn it only switches the view. */
  const openNode = useCallback(
    async (nodeId: string) => {
      setBanner(null)
      setThreadId(nodeId)
      if (busy.current) return
      const { weak } = await api<{ weak: { id: string; state: NodeState }[] }>(
        `/api/studies/${goalId}/nodes/${encodeURIComponent(nodeId)}/prerequisites`,
      ).catch(() => ({ weak: [] }))
      if (threadRef.current !== nodeId) return
      if (weak.length) setBanner({ nodeId, weak })
      else proceed(nodeId)
    },
    [goalId, proceed],
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

  // The goal turning Known while the page is open (teach → done) fires one burst from the goal circle; a reload doesn't.
  const phase = study?.phase ?? null
  useEffect(() => {
    if (lastPhase.current === 'teach' && phase === 'done' && pane.current && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const box = pane.current.getBoundingClientRect()
      const goal = pane.current.querySelector('.map-node.goal .map-circle')?.getBoundingClientRect()
      setBurst(goal ? { x: goal.left + goal.width / 2 - box.left, y: goal.top + goal.height / 2 - box.top } : { x: box.width / 2, y: box.height / 2 })
    }
    lastPhase.current = phase
  }, [phase])

  if (error) return <div className="first-run error-line">{error}</div>
  if (!study || threadId === undefined) return null

  const node = study.nodes.find(n => n.id === threadId)
  const pendingCard = items.some(i => i.type === 'card' && i.pending)
  const shown = banner?.nodeId === threadId ? banner : null
  const goTo = shown && study.nodes.find(n => n.id === shown.weak[0].id)

  return (
    <div className="app">
      <TopBar
        left={
          <>
            <button className="text-action muted back-link ellipsis" onClick={() => navigate(`/projects/${study.projectId}`)}>
              <ArrowLeft size={16} aria-hidden="true" /> {projectName}
            </button>
            <span className="goal-title ellipsis" title={study.goal}>
              {goalName(study)}
            </span>
          </>
        }
        center={<PhaseSteps phase={study.phase} />}
        right={<UsageButton usage={study.usage} scope="goal" />}
      />
      <main className="page">
        <SplitPane
          left={
            <div ref={pane} className="graph-pane">
              {study.nodes.length === 0 ? (
                <StrandPanel strands={study.strands} />
              ) : (
                <StudyMap study={study} openId={threadId} clickable={study.phase === 'teach' || study.phase === 'done'} onOpen={openNode} />
              )}
              {burst && <Confetti origin={burst} onDone={() => setBurst(null)} />}
            </div>
          }
          right={
            <Chat
              title={node?.label ?? 'Main chat'}
              inMain={threadId === null}
              onMain={() => {
                setBanner(null)
                setThreadId(null)
              }}
              items={items}
              turn={turnThread === threadId ? turn : { ...turn, segments: [], error: null }}
              draft={draft}
              setDraft={setDraft}
              queued={!!queued}
              composerPaused={shown ? 'Message the tutor…' : pendingCard && !turn.running ? 'Answer the card above to continue' : null}
              after={
                study.phase === 'done' &&
                node?.kind === 'goal' &&
                !turn.running && (
                  <div className="card goal-complete">
                    <div className="goal-complete-title">Goal complete</div>
                    <div className="muted">
                      {study.nodes.filter(n => n.state === 'known').length} of {study.nodes.length} known
                    </div>
                    <MasteryBar counts={Object.fromEntries(STATES.map(s => [s, study.nodes.filter(n => n.state === s).length])) as Record<NodeState, number>} height={8} />
                  </div>
                )
              }
              banner={
                shown &&
                goTo &&
                node && (
                  <PrereqBanner
                    text={prereqText(shown.weak, study.nodes)}
                    goTo={goTo}
                    nodeLabel={node.label}
                    onGo={() => proceed(goTo.id)}
                    onContinue={() => proceed(node.id)}
                  />
                )
              }
              onSend={() => send(draft)}
              onStop={() => api(`/api/studies/${goalId}/stop`, { method: 'POST' }).catch(() => {})}
              onRetry={() => resume('retry', threadId ? { nodeId: threadId } : {})}
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

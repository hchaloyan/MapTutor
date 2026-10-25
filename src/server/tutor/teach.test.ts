import type { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { buildApp } from '../app'
import { LOCAL_USER_ID, openDb } from '../core/db'
import { studyStateText } from './context'
import { scripted } from './scripted'
import { proposeGraphTool } from './plan'
import { quizTool } from './quiz'
import { focusNodeTool, setNodeStateTool } from './teach'

type Reply = { content: unknown[]; stop_reason: string }
const text = (t: string): Reply => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' })
const toolCall = (name: string, input: unknown, id = 'tu_1'): Reply => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' })

const node = (id: string, kind: string, strands: string[] = []) => ({ id, label: id.toUpperCase(), kind, description: `About ${id}.`, strands })
const GRAPH = {
  approach: 'Limits and slope, then the derivative.',
  nodes: [node('limits', 'root', ['limits']), node('slope', 'root', ['algebra']), node('deriv', 'goal')],
  edges: [{ from: 'limits', to: 'deriv' }, { from: 'slope', to: 'deriv' }],
}

/** limits starts known (2/2), slope frontier (1/2), deriv untested. */
function seedTeach(db: DatabaseSync, studyId: string) {
  let n = 0
  for (const [strand, correct] of [['limits', 1], ['limits', 1], ['algebra', 1], ['algebra', 0]] as const) {
    db.prepare(
      `INSERT INTO quiz_items (id, study_id, quiz_call_id, phase, strand, prompt, options, correct_option_id, explanation, chosen_option_id, answered_at)
       VALUES (?, ?, 'tu_p', 'probe', ?, 'p', '[]', 'a', 'e', ?, 0)`,
    ).run(`p${n++}`, studyId, strand, correct ? 'a' : 'b')
  }
  proposeGraphTool.onPause!(GRAPH, { db, studyId, nodeId: null })
  db.prepare("UPDATE studies SET phase = 'teach', approach = ? WHERE id = ?").run(GRAPH.approach, studyId)
}

function setup() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', ?, 'Calc', 0)").run(LOCAL_USER_ID)
  db.prepare("INSERT INTO studies (id, project_id, goal, phase, created_at) VALUES ('s1', 'p1', 'midterm', 'probe', 0)").run()
  seedTeach(db, 's1')
  const ctx = (nodeId: string | null = null) => ({ db, studyId: 's1', nodeId })
  const state = (id: string) => db.prepare("SELECT state, ever_known FROM nodes WHERE study_id = 's1' AND id = ?").get(id)
  const phase = () => (db.prepare("SELECT phase FROM studies WHERE id = 's1'").get() as { phase: string }).phase
  return { db, ctx, state, phase }
}

const check = (id: string, nodeId: string) => ({
  id,
  prompt: `Question ${id}`,
  options: [{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }],
  correctOptionId: 'a',
  explanation: 'Because.',
  nodeId,
})
let call = 0
/** Answers a quiz-check; `picks` maps item id to 'a' (right) or 'b' (wrong). */
function answerCheck(t: ReturnType<typeof setup>, items: ReturnType<typeof check>[], picks: Record<string, string>) {
  return quizTool.answer({ items }, { choices: picks }, t.ctx(), `tu_c${call++}`)
}

async function setupApp(script: (Reply | (() => Promise<Reply>))[], opts: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const db = openDb(':memory:')
  const { calls, runHop } = scripted(script)
  const app = buildApp({ db, runHop, ...opts })
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Calc' } })).json()
  const study = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/studies`, payload: { goal: 'midterm' } })).json()
  seedTeach(db, study.id)
  const send = (body: object) => app.inject({ method: 'POST', url: `/api/studies/${study.id}/messages`, payload: body })
  const answer = (toolUseId: string, answer: unknown) =>
    app.inject({ method: 'POST', url: `/api/studies/${study.id}/tool-results`, payload: { toolUseId, answer } })
  const get = async () => (await app.inject(`/api/studies/${study.id}`)).json()
  const thread = async (nodeId?: string) => (await app.inject(`/api/studies/${study.id}/thread${nodeId ? `?nodeId=${nodeId}` : ''}`)).json()
  const rows = (nodeId: string | null) =>
    (db.prepare('SELECT role, content FROM messages WHERE study_id = ? AND node_id IS ? ORDER BY created_at, rowid').all(study.id, nodeId) as {
      role: string
      content: string
    }[]).map(r => ({ role: r.role, content: JSON.parse(r.content) }))
  return { app, db, calls, studyId: study.id as string, send, answer, get, thread, rows }
}

const events = (payload: string) =>
  payload
    .split('\n\n')
    .filter(Boolean)
    .map(chunk => [/^event: (.*)$/m.exec(chunk)![1], JSON.parse(/^data: (.*)$/m.exec(chunk)![1])])

test('focus_node switches the turn into the node thread', async () => {
  const t = await setupApp([toolCall('focus_node', { nodeId: 'slope' }), text('Why slope?')])
  expect(events((await t.send({ text: 'next' })).payload)).toEqual([
    ['focus', { nodeId: 'slope' }],
    ['text', { delta: 'Why slope?' }],
    ['done', { awaiting: false }],
  ])
  const main = t.rows(null)
  expect(main.map(r => r.role)).toEqual(['user', 'assistant', 'user'])
  expect(main[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' })
  expect(main[2].content[0].content[0].text).toBe('Opened node "slope"\'s thread. The lesson continues there.')
  const slope = t.rows('slope')
  expect(slope.map(r => r.role)).toEqual(['user', 'assistant'])
  expect(slope[0].content[0].text).toBe('[App: focus_node opened this thread. Continue the lesson for "SLOPE" here.]')
  expect(slope[0].content[1].text).toContain('Thread: node slope')
  // The second request is the slope thread alone.
  expect(t.calls[1]).toHaveLength(1)
  expect(JSON.stringify(t.calls[1])).not.toContain('tu_1')
  expect((await t.get()).focusNodeId).toBe('slope')
  expect(await t.thread('slope')).toMatchObject([{ type: 'assistant', text: 'Why slope?' }])
})

test('focus_node on the current thread acknowledges; unknown nodes and pending cards are errors', () => {
  const t = setup()
  expect(focusNodeTool.run({ nodeId: 'slope' }, t.ctx('slope'))).toEqual({ content: 'Already in node "slope"\'s thread.' })
  expect(focusNodeTool.run({}, t.ctx())).toEqual({ content: 'focus_node needs a nodeId.', isError: true })
  expect(focusNodeTool.run({ nodeId: 'nope' }, t.ctx())).toEqual({ content: 'Node "nope" is not in this study.', isError: true })
  t.db.prepare("INSERT INTO messages (id, study_id, node_id, role, content, pending, created_at) VALUES ('m1', 's1', 'slope', 'assistant', '[]', 1, 0)").run()
  expect(focusNodeTool.run({ nodeId: 'slope' }, t.ctx())).toEqual({
    content: 'Node "slope"\'s thread is waiting for the user to answer a card there. Keep teaching here, or ask the user to open that node.',
    isError: true,
  })
})

test('quiz-checks move each node by its own items', () => {
  const t = setup()
  answerCheck(t, [check('q1', 'slope'), check('q2', 'slope'), check('q3', 'deriv'), check('q4', 'deriv')], { q1: 'a', q2: 'a', q3: 'a', q4: 'b' })
  expect(t.state('slope')).toEqual({ state: 'known', ever_known: 1 })
  expect(t.state('deriv')).toEqual({ state: 'missed', ever_known: 0 })
  expect(t.phase()).toBe('teach')
})

test('a known node that fails drops to frontier, and the goal passing finishes the study', () => {
  const t = setup()
  answerCheck(t, [check('q1', 'limits')], { q1: 'b' })
  expect(t.state('limits')).toEqual({ state: 'frontier', ever_known: 1 })
  answerCheck(t, [check('q1', 'deriv')], { q1: 'a' })
  expect(t.state('deriv')).toEqual({ state: 'known', ever_known: 1 })
  expect(t.phase()).toBe('done')
  answerCheck(t, [check('q1', 'deriv')], { q1: 'b' })
  expect(t.state('deriv')).toEqual({ state: 'frontier', ever_known: 1 })
  expect(t.phase()).toBe('done')
})

test('set_node_state is guarded by quiz evidence', () => {
  const t = setup()
  const set = (nodeId: string, state: string) => setNodeStateTool.run({ nodeId, state, reason: 'conversation' }, t.ctx())
  expect(set('slope', 'known')).toEqual({ content: 'A node can only become known after a passed quiz-check that is newer than its last failure.', isError: true })
  expect(set('limits', 'missed')).toEqual({ content: "This node was known before, so it can't go back to missed; use frontier.", isError: true })
  expect(set('limits', 'untested')).toEqual({ content: 'set_node_state needs a nodeId, a state (missed, frontier, or known), and a reason.', isError: true })
  expect(setNodeStateTool.run({ nodeId: 'limits', state: 'frontier' }, t.ctx())).toMatchObject({ isError: true })
  expect(set('nope', 'frontier')).toEqual({ content: 'Node "nope" is not in this study.', isError: true })
  expect(set('limits', 'frontier')).toEqual({ content: 'Node "limits" is now frontier.' })
  expect(t.state('limits')).toEqual({ state: 'frontier', ever_known: 1 })

  answerCheck(t, [check('q1', 'slope')], { q1: 'a' })
  expect(set('slope', 'frontier')).toEqual({ content: 'Node "slope" is now frontier.' })
  expect(set('slope', 'known')).toEqual({ content: 'Node "slope" is now known.' })
})

test('node threads see the approach, weak prerequisites, and summaries', () => {
  const t = setup()
  t.db.prepare("UPDATE nodes SET summary = 'A limit is where f heads.' WHERE study_id = 's1' AND id = 'limits'").run()
  const deriv = studyStateText(t.db, 's1', 'deriv', [])
  for (const line of [
    'Summaries of known nodes:\n- limits: A limit is where f heads.',
    'This node: About deriv.',
    'Weak prerequisites: slope (frontier)',
    `Approach: ${GRAPH.approach}`,
  ]) {
    expect(deriv).toContain(line)
  }
  expect(studyStateText(t.db, 's1', 'limits', [])).toContain('Weak prerequisites: none')
  const main = studyStateText(t.db, 's1', null, [])
  expect(main).toContain('Summaries of known nodes:')
  expect(main).not.toContain('This node:')
  expect(main).not.toContain('Approach:')
})

test('one turn per study: a second thread is a 409 while a turn runs', async () => {
  let release!: () => void
  let started!: () => void
  const running = new Promise<void>(resolve => (started = resolve))
  const t = await setupApp([
    () => {
      started()
      return new Promise(resolve => (release = () => resolve(text('done'))))
    },
  ])
  const first = t.send({ text: 'one' })
  await running
  const second = await t.send({ text: 'two', nodeId: 'slope' })
  expect(second.statusCode).toBe(409)
  release()
  await first
})

test('posting in a node thread focuses it, and app notes stay out of the thread view', async () => {
  const t = await setupApp([text('Limits it is.')])
  await t.send({ text: 'teach me limits', nodeId: 'limits' })
  expect((await t.get()).focusNodeId).toBe('limits')
  t.db.prepare("INSERT INTO messages (id, study_id, node_id, role, content, created_at) VALUES ('m9', ?, 'limits', 'user', ?, 9e15)").run(
    t.studyId,
    JSON.stringify([{ type: 'text', text: '[App: focus_node opened this thread.]' }]),
  )
  expect((await t.thread('limits')).map((i: { text: string }) => i.text)).toEqual(['teach me limits', 'Limits it is.'])
})

test('after a quiz-check, tutor tools are refused until the user replies', async () => {
  const t = await setupApp([
    toolCall('quiz', { items: [check('q1', 'slope')] }, 'tu_q'),
    toolCall('quiz', { items: [check('q2', 'slope')] }, 'tu_q2'),
    toolCall('set_node_state', { nodeId: 'slope', state: 'frontier', reason: 'r' }, 'tu_s'),
    text('What felt shaky?'),
    toolCall('quiz', { items: [check('q3', 'slope')] }, 'tu_q3'),
  ])
  await t.send({ text: 'teach me slope', nodeId: 'slope' })
  const res = await t.answer('tu_q', { choices: { q1: 'b' } })
  expect(events(res.payload).at(-1)).toEqual(['done', { awaiting: false }])
  // Both calls after the check were refused, the second one even though the first refusal is now the newest row.
  for (const i of [2, 3]) expect(JSON.stringify(t.calls[i].at(-1))).toContain("The user hasn't replied since the quiz")
  const reply = await t.send({ text: 'I forgot to add them up.', nodeId: 'slope' })
  expect(events(reply.payload).at(-1)).toEqual(['done', { awaiting: true }])
})

test('a node that becomes known gets one summary from its thread', async () => {
  const transcripts: string[] = []
  const summarize = async (transcript: string) => (transcripts.push(transcript), ' Slope is rise over run. ')
  const t = await setupApp([toolCall('quiz', { items: [check('q1', 'slope')] }, 'tu_q'), text('Nice.'), text('More.')], { summarize })
  await t.send({ text: 'teach me slope', nodeId: 'slope' })
  expect(transcripts).toEqual([])
  await t.answer('tu_q', { choices: { q1: 'a' } })
  expect(transcripts).toHaveLength(1)
  expect(transcripts[0]).toBe('Node: SLOPE — About slope.\n\nUser: teach me slope\nTutor: Nice.')
  const slope = (await t.get()).nodes.find((n: { id: string }) => n.id === 'slope')
  expect(slope).toMatchObject({ state: 'known', summary: 'Slope is rise over run.' })
  await t.send({ text: 'again', nodeId: 'slope' })
  expect(transcripts).toHaveLength(1)
})

test('a summary failure is logged, and the next turn retries it', async () => {
  const lines: string[] = []
  let attempts = 0
  const summarize = async () => {
    if (attempts++ === 0) throw new Error('summary boom')
    return 'Slope is rise over run.'
  }
  const t = await setupApp([toolCall('quiz', { items: [check('q1', 'slope')] }, 'tu_q'), text('Nice.'), text('More.')], {
    summarize,
    logStream: { write: (line: string) => lines.push(line) },
  })
  await t.send({ text: 'teach me slope', nodeId: 'slope' })
  const res = await t.answer('tu_q', { choices: { q1: 'a' } })
  expect(events(res.payload).at(-1)).toEqual(['done', { awaiting: false }])
  expect(lines.join('')).toContain('summary boom')
  await t.send({ text: 'again', nodeId: 'slope' })
  expect((await t.get()).nodes.find((n: { id: string }) => n.id === 'slope').summary).toBe('Slope is rise over run.')
})

test('the prerequisite endpoint lists weak ancestors, most foundational first', async () => {
  const t = await setupApp([])
  const weak = async (nodeId: string) => (await t.app.inject(`/api/studies/${t.studyId}/nodes/${nodeId}/prerequisites`))
  expect((await weak('deriv')).json()).toEqual({ weak: [{ id: 'slope', state: 'frontier' }] })
  expect((await weak('limits')).json()).toEqual({ weak: [] })
  expect((await weak('nope')).statusCode).toBe(404)
})

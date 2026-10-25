import type { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { buildApp } from '../app'
import { LOCAL_USER_ID, openDb } from '../core/db'
import { studyStateText } from './context'
import { loadGraph, proposeGraphTool } from './plan'
import { scripted } from './scripted'

type Reply = { content: unknown[]; stop_reason: string }
const text = (t: string): Reply => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' })
const propose = (input: unknown, id = 'tu_g'): Reply => ({ content: [{ type: 'tool_use', id, name: 'propose_graph', input }], stop_reason: 'tool_use' })

const node = (id: string, kind: string, strands: string[] = []) => ({ id, label: id.toUpperCase(), kind, description: `About ${id}.`, strands })
const GRAPH = {
  approach: 'Start from limits and slope, then derive the derivative.',
  nodes: [node('limits', 'root', ['limits']), node('slope', 'root', ['algebra']), node('deriv', 'goal', ['derivatives'])],
  edges: [{ from: 'limits', to: 'deriv' }, { from: 'slope', to: 'deriv' }],
}

let n = 0
/** Probe evidence: limits 2/2, algebra 1/2, derivatives 0/1. */
function seedProbe(db: DatabaseSync, studyId: string) {
  for (const [strand, correct] of [['limits', 1], ['limits', 1], ['algebra', 1], ['algebra', 0], ['derivatives', 0]] as const) {
    db.prepare(
      `INSERT INTO quiz_items (id, study_id, quiz_call_id, phase, strand, prompt, options, correct_option_id, explanation, chosen_option_id, answered_at)
       VALUES (?, ?, 'tu_p', 'probe', ?, 'p', '[]', 'a', 'e', ?, 0)`,
    ).run(`p${n++}`, studyId, strand, correct ? 'a' : 'b')
  }
}

function setup(phase = 'probe') {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', ?, 'Calc', 0)").run(LOCAL_USER_ID)
  db.prepare("INSERT INTO studies (id, project_id, goal, phase, created_at) VALUES ('s1', 'p1', 'midterm', ?, 0)").run(phase)
  seedProbe(db, 's1')
  return { db, ctx: { db, studyId: 's1', nodeId: null } }
}

async function setupApp(script: Reply[]) {
  const db = openDb(':memory:')
  const app = buildApp({ db, runHop: scripted(script).runHop })
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Calc' } })).json()
  const study = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/studies`, payload: { goal: 'midterm' } })).json()
  seedProbe(db, study.id)
  const send = (body: object) => app.inject({ method: 'POST', url: `/api/studies/${study.id}/messages`, payload: body })
  const answer = (toolUseId: string, answer: unknown) =>
    app.inject({ method: 'POST', url: `/api/studies/${study.id}/tool-results`, payload: { toolUseId, answer } })
  const get = async () => (await app.inject(`/api/studies/${study.id}`)).json()
  const lastUser = () =>
    JSON.parse(
      (db.prepare("SELECT content FROM messages WHERE role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { content: string }).content,
    )
  return { db, studyId: study.id as string, send, answer, get, lastUser }
}

test('a valid proposal passes; every problem in a bad one is reported at once', () => {
  const { ctx } = setup()
  expect(proposeGraphTool.check(GRAPH, ctx)).toBeNull()
  const bad = { approach: ' ', nodes: [{ id: 'a', label: '', kind: 'axiom', description: 'd', strands: 'x' }, {}], edges: [{ from: 'a' }] }
  expect(proposeGraphTool.check(bad, ctx)).toBe(
    [
      'propose_graph needs an approach.',
      'Node "a" needs a label.',
      'Node "a": kind must be root, derived, or goal.',
      'Node "a": strands must be a list of strand names.',
      'Node 2 needs an id.',
      'Node 2 needs a label.',
      'Node 2: kind must be root, derived, or goal.',
      'Node 2 needs a description.',
      'Node 2: strands must be a list of strand names.',
      'Edge 1 needs from and to node ids.',
    ].join('\n'),
  )
  expect(proposeGraphTool.check(null, ctx)).toBe('propose_graph needs an approach.\npropose_graph needs at least one node.\npropose_graph needs an edges list.')
  const twoGoals = { ...GRAPH, nodes: [...GRAPH.nodes, node('extra', 'goal')], edges: [...GRAPH.edges, { from: 'limits', to: 'extra' }] }
  expect(proposeGraphTool.check(twoGoals, ctx)).toBe('There must be exactly one goal node; found 2.')
})

test('unknown strands are rejected with the valid names listed', () => {
  const { ctx } = setup()
  const wrongCase = { ...GRAPH, nodes: [node('limits', 'root', ['Limits']), ...GRAPH.nodes.slice(1)] }
  expect(proposeGraphTool.check(wrongCase, ctx)).toBe(
    'Node "limits" uses strand "Limits", which no probe question used. Valid strands: algebra, derivatives, limits.',
  )
})

test('proposing pauses on an approval card, moves to plan, and stores states from the probe', async () => {
  const t = await setupApp([propose(GRAPH)])
  const sse = (await t.send({ text: 'ready' })).payload
  expect(sse).toContain(`event: card\ndata: ${JSON.stringify({ toolUseId: 'tu_g', name: 'propose_graph', input: { approach: GRAPH.approach } })}`)
  expect(sse).toContain('event: done\ndata: {"awaiting":true}')
  const study = await t.get()
  expect(study.phase).toBe('plan')
  expect(study.nodes).toEqual([
    { ...GRAPH.nodes[0], state: 'known', everKnown: true, summary: null, evidence: { correct: 2, total: 2 } },
    { ...GRAPH.nodes[1], state: 'frontier', everKnown: false, summary: null, evidence: { correct: 1, total: 2 } },
    { ...GRAPH.nodes[2], state: 'untested', everKnown: false, summary: null, evidence: { correct: 0, total: 1 } },
  ])
  expect(study.edges).toEqual(GRAPH.edges)
})

test('a re-proposal replaces the graph', async () => {
  const smaller = { approach: 'Just limits.', nodes: [node('limits', 'root', ['limits']), node('goal', 'goal')], edges: [{ from: 'limits', to: 'goal' }] }
  const t = await setupApp([propose(GRAPH), propose(smaller, 'tu_g2')])
  await t.send({ text: 'ready' })
  const sse = (await t.answer('tu_g', { decision: 'feedback', text: ' Fewer nodes. ' })).payload
  expect(sse).toContain('"approach":"Just limits."')
  const study = await t.get()
  expect(study.nodes.map((n: { id: string }) => n.id)).toEqual(['limits', 'goal'])
  expect(study.edges).toEqual(smaller.edges)
  expect(t.db.prepare('SELECT count(*) AS n FROM edges').get()).toEqual({ n: 1 })
  expect(t.lastUser()[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_g', content: '{"decision":"feedback","text":"Fewer nodes."}' })
})

test('approve moves to teach and stores the approach; feedback needs text and stays in plan', async () => {
  const t = await setupApp([propose(GRAPH), text('Let us begin.')])
  await t.send({ text: 'ready' })
  for (const [bad, message] of [
    [{ decision: 'feedback', text: '  ' }, 'Say what you want changed.'],
    [{ decision: 'maybe' }, 'Approve the plan or say what to change.'],
    ['yes', 'Approve the plan or say what to change.'],
  ] as const) {
    const res = await t.answer('tu_g', bad)
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toBe(message)
  }
  expect((await t.get()).phase).toBe('plan')
  await t.answer('tu_g', { decision: 'approved' })
  expect(await t.get()).toMatchObject({ phase: 'teach', approach: GRAPH.approach })
  const [result, state] = t.lastUser()
  expect(result).toMatchObject({ type: 'tool_result', content: '{"decision":"approved"}' })
  expect(state.text).toContain('Phase: teach')
})

test('propose_graph is rejected during teach', async () => {
  const t = await setupApp([propose(GRAPH), text('ok')])
  t.db.prepare("UPDATE studies SET phase = 'teach' WHERE id = ?").run(t.studyId)
  await t.send({ text: 'new plan' })
  expect(t.lastUser()[0]).toMatchObject({ is_error: true, content: [{ type: 'text', text: "`propose_graph` isn't available in the teach phase." }] })
  expect((await t.get()).nodes).toEqual([])
})

test('study state lists the graph and the next node', () => {
  const { db, ctx } = setup()
  expect(studyStateText(db, 's1', null, [])).not.toContain('Graph:')
  proposeGraphTool.onPause!(GRAPH, ctx)
  expect(studyStateText(db, 's1', null, [])).toContain(
    [
      'Graph:',
      '- limits [root] "LIMITS" — known (2/2 correct); prerequisites: none',
      '- slope [root] "SLOPE" — frontier (1/2 correct); prerequisites: none',
      '- deriv [goal] "DERIV" — untested (0/1 correct); prerequisites: limits, slope',
      'Next node: slope',
    ].join('\n'),
  )
})

test('evidence counts probe items by strand and check items by node', () => {
  const { db, ctx } = setup()
  proposeGraphTool.onPause!({ ...GRAPH, nodes: [node('limits', 'root', ['limits', 'algebra']), ...GRAPH.nodes.slice(1)] }, ctx)
  db.prepare(
    `INSERT INTO quiz_items (id, study_id, quiz_call_id, phase, node_id, prompt, options, correct_option_id, explanation, chosen_option_id, answered_at)
     VALUES ('c1', 's1', 'tu_c', 'check', 'deriv', 'p', '[]', 'a', 'e', 'a', 1)`,
  ).run()
  const evidence = Object.fromEntries(loadGraph(db, 's1').nodes.map(n => [n.id, n.evidence]))
  expect(evidence).toEqual({ limits: { correct: 3, total: 4 }, slope: { correct: 1, total: 2 }, deriv: { correct: 1, total: 2 } })
})

test('node threads stay closed until the plan is approved', async () => {
  const t = await setupApp([propose(GRAPH), text('ok'), text('Limits first.')])
  await t.send({ text: 'ready' })
  const early = await t.send({ text: 'hi', nodeId: 'limits' })
  expect(early.statusCode).toBe(409)
  expect(early.json().message).toBe('Node threads open once the plan is approved.')
  await t.answer('tu_g', { decision: 'approved' })
  expect((await t.send({ text: 'hi', nodeId: 'limits' })).statusCode).toBe(200)
})

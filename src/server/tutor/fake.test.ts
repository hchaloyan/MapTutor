import { expect, test } from 'vitest'
import { buildApp } from '../app'
import { openDb } from '../core/db'
import { fakeModel, fakeTutor } from './fake'

type Event = { event: string; data: Record<string, any> }

const events = (payload: string): Event[] =>
  payload
    .split('\n\n')
    .filter(Boolean)
    .map(chunk => ({ event: /^event: (.*)$/m.exec(chunk)![1], data: JSON.parse(/^data: (.*)$/m.exec(chunk)![1]) }))

async function setup() {
  const app = buildApp({ db: openDb(':memory:'), ...fakeTutor({ delayMs: 0 }) })
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Calc' } })).json()
  const study = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/studies`, payload: { goal: 'help me study for the midterm' } })).json()
  const seen: Event[] = []
  const post = async (path: string, payload: object) => {
    const res = await app.inject({ method: 'POST', url: `/api/studies/${study.id}/${path}`, payload })
    expect(res.statusCode).toBe(200)
    const list = events(res.payload)
    expect(list.filter(e => e.event === 'done')).toHaveLength(1)
    seen.push(...list)
    return list
  }
  const card = (list: Event[]) => list.find(e => e.event === 'card')?.data
  const getStudy = async () => (await app.inject(`/api/studies/${study.id}`)).json()
  return { app, post, card, seen, getStudy }
}

test('the fake tutor walks a goal from question to done', async () => {
  const t = await setup()
  let c = t.card(await t.post('messages', { text: 'help me study for the midterm' }))!
  expect(c.name).toBe('ask_user_question')
  c = t.card(await t.post('tool-results', { toolUseId: c.toolUseId, answer: { answers: ['Pass the midterm next week'] } }))!
  expect(c.name).toBe('quiz')
  expect((await t.getStudy()).title).toBe('Ace the calculus midterm')

  // Probe: functions and limits right, derivatives (the third question) wrong.
  const probe = Object.fromEntries(c.input.items.map((it: { id: string }, i: number) => [it.id, i === 2 ? 'a' : 'b']))
  c = t.card(await t.post('tool-results', { toolUseId: c.toolUseId, answer: { choices: probe } }))!
  expect(c.name).toBe('propose_graph')
  expect((await t.getStudy()).strands).toEqual([
    { strand: 'functions', correct: 1, total: 1 },
    { strand: 'limits', correct: 1, total: 1 },
    { strand: 'derivatives', correct: 0, total: 1 },
  ])

  // Feedback once: the plan comes back revised and still validates.
  c = t.card(await t.post('tool-results', { toolUseId: c.toolUseId, answer: { decision: 'feedback', text: 'More exam practice' } }))!
  expect(c.name).toBe('propose_graph')
  expect(c.input.approach).toContain('More exam practice')
  const planned = await t.getStudy()
  expect(planned.phase).toBe('plan')
  expect(Object.fromEntries(planned.nodes.map((n: { id: string; state: string }) => [n.id, n.state]))).toEqual({
    functions: 'known', limits: 'known', slope: 'frontier', derivative: 'missed', chain: 'untested',
  })

  // Approve, then pass each quiz-check until the goal is known.
  let list = await t.post('tool-results', { toolUseId: c.toolUseId, answer: { decision: 'approved' } })
  for (let i = 0; i < 10 && t.card(list); i++) {
    const quiz = t.card(list)!
    expect(quiz.name).toBe('quiz')
    list = await t.post('tool-results', { toolUseId: quiz.toolUseId, answer: { choices: Object.fromEntries(quiz.input.items.map((it: { id: string }) => [it.id, 'b'])) } })
  }

  const done = await t.getStudy()
  expect(done.phase).toBe('done')
  expect(done.nodes.every((n: { state: string }) => n.state === 'known')).toBe(true)
  expect(t.seen.filter(e => e.event === 'focus').map(e => e.data.nodeId)).toEqual(['slope', 'derivative', 'chain'])
  expect(t.seen.filter(e => e.event === 'status' && e.data.kind === 'searching')).toHaveLength(1)
  expect(t.seen.some(e => e.event === 'error')).toBe(false)
  expect(list.filter(e => e.event === 'text').map(e => e.data.delta).join('')).toBe("That's the goal. Nicely done.")
})

test('a wrong quiz-check answer gets the same question again', async () => {
  const t = await setup()
  let c = t.card(await t.post('messages', { text: 'hi' }))!
  c = t.card(await t.post('tool-results', { toolUseId: c.toolUseId, answer: { answers: ['Pass the midterm next week'] } }))!
  c = t.card(await t.post('tool-results', { toolUseId: c.toolUseId, answer: { choices: Object.fromEntries(c.input.items.map((it: { id: string }, i: number) => [it.id, i === 2 ? 'a' : 'b'])) } }))!
  c = t.card(await t.post('tool-results', { toolUseId: c.toolUseId, answer: { decision: 'approved' } }))!
  const wrong = t.card(await t.post('tool-results', { toolUseId: c.toolUseId, answer: { choices: { [c.input.items[0].id]: 'a' } } }))!
  expect(wrong.name).toBe('quiz')
  expect(wrong.input.items[0].prompt).toBe(c.input.items[0].prompt)
})

test('the fake tutor streams in chunks and honours Stop', async () => {
  const model = fakeModel({ delayMs: 40 })
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hello there, how are you today' }, { type: 'text', text: '<study_state>\nPhase: teach\nThread: main\n</study_state>' }] },
  ] as Parameters<typeof model>[0]
  const deltas: string[] = []
  const statuses: string[] = []
  const message = await model(messages, d => deltas.push(d), { onStatus: s => statuses.push(s) })
  expect(statuses).toEqual(['thinking'])
  expect(deltas.join('')).toBe('You said: hello there, how are you today')
  expect(deltas.length).toBeGreaterThan(1)
  expect(message).toMatchObject({ model: 'fake-tutor', stop_reason: 'end_turn', content: [{ type: 'text', text: 'You said: hello there, how are you today' }] })

  const controller = new AbortController()
  const stopped = model(messages, () => controller.abort(), { onStatus: () => {}, signal: controller.signal })
  await expect(stopped).rejects.toThrow()
})

test('a message containing [fail] errors once, so Retry can be tried for free', async () => {
  const t = await setup()
  const first = await t.post('messages', { text: 'hello [fail]' })
  expect(first.map(e => e.event)).toEqual(['error', 'done'])
  expect(first[0].data.message).toBe('Claude is overloaded right now. Try again in a moment.')
  const retried = await t.post('retry', {})
  expect(retried.filter(e => e.event === 'card')).toHaveLength(1)
})

import Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'vitest'
import { buildApp } from '../app'
import { openDb } from '../core/db'
import type { StreamMessage } from '../tutor/loop'

type Reply = { content: unknown[]; stop_reason: string }
const text = (t: string): Reply => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' })
const QUESTION = { question: 'What is the goal?', options: [{ label: 'Pass the midterm' }, { label: 'Understand it' }] }
const ask = (id = 'tu_1'): Reply => ({ content: [{ type: 'tool_use', id, name: 'ask_user_question', input: QUESTION }], stop_reason: 'tool_use' })
const KEY = { 'x-anthropic-key': 'sk-test' }

type Opts = Parameters<StreamMessage>[3]

async function setup(script: (Reply | ((opts: Opts) => Promise<Reply>))[]) {
  const calls: Parameters<StreamMessage>[0][] = []
  const streamMessage: StreamMessage = async (params, _key, onText, opts) => {
    calls.push(structuredClone(params))
    const next = script.shift()!
    const reply = typeof next === 'function' ? await next(opts) : next
    for (const b of reply.content as { type: string; text?: string }[]) if (b.type === 'text') onText(b.text!)
    return reply as unknown as Anthropic.Beta.BetaMessage
  }
  const db = openDb(':memory:')
  const app = buildApp({ db, streamMessage })
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Calc' } })).json()
  const study = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/studies`, payload: { goal: 'midterm' } })).json()
  const send = (body: object, url = `/api/studies/${study.id}/messages`, headers: Record<string, string> = KEY) =>
    app.inject({ method: 'POST', url, headers, payload: body })
  const answer = (toolUseId: string, answer: unknown) => send({ toolUseId, answer }, `/api/studies/${study.id}/tool-results`)
  const thread = async () => (await app.inject(`/api/studies/${study.id}/thread`)).json()
  return { app, db, calls, projectId: project.id as string, studyId: study.id as string, send, answer, thread }
}

const events = (payload: string) =>
  payload
    .split('\n\n')
    .filter(Boolean)
    .map(chunk => ({ event: /^event: (.*)$/m.exec(chunk)![1], data: JSON.parse(/^data: (.*)$/m.exec(chunk)![1]) }))

test('a message streams text and done, and the thread shows both turns', async () => {
  const t = await setup([text('Hello!')])
  const res = await t.send({ text: 'help me study' })
  expect(res.headers['content-type']).toBe('text/event-stream')
  expect(events(res.payload)).toEqual([
    { event: 'text', data: { delta: 'Hello!' } },
    { event: 'done', data: { awaiting: false } },
  ])
  expect((await t.thread()).map((i: { type: string; text: string }) => [i.type, i.text])).toEqual([
    ['user', 'help me study'],
    ['assistant', 'Hello!'],
  ])
})

test('a card pauses; answering resumes the turn and the thread shows the answer', async () => {
  const t = await setup([ask(), text('Great, the midterm it is.')])
  const first = events((await t.send({ text: 'help' })).payload)
  expect(first).toEqual([
    { event: 'card', data: { toolUseId: 'tu_1', name: 'ask_user_question', input: QUESTION } },
    { event: 'done', data: { awaiting: true } },
  ])
  expect((await t.thread()).at(-1)).toMatchObject({ type: 'card', toolUseId: 'tu_1', pending: true, answer: null })
  const second = events((await t.answer('tu_1', { answers: ['Pass the midterm'] })).payload)
  expect(second.at(-1)).toEqual({ event: 'done', data: { awaiting: false } })
  const items = await t.thread()
  expect(items.find((i: { type: string }) => i.type === 'card')).toMatchObject({ pending: false, answer: { answers: ['Pass the midterm'] } })
  expect(items.at(-1)).toMatchObject({ type: 'assistant', text: 'Great, the midterm it is.' })
})

test('sending a message while a card is pending is a 409', async () => {
  const t = await setup([ask()])
  await t.send({ text: 'help' })
  const res = await t.send({ text: 'never mind' })
  expect(res.statusCode).toBe(409)
  expect(res.json().message).toBe('Answer the card first.')
})

test('a second request while a turn runs is a 409', async () => {
  let release!: () => void
  let started!: () => void
  const running = new Promise<void>(resolve => (started = resolve))
  const t = await setup([
    () => {
      started()
      return new Promise(resolve => (release = () => resolve(text('done'))))
    },
  ])
  const first = t.send({ text: 'one' })
  await running
  const second = await t.send({ text: 'two' })
  expect(second.statusCode).toBe(409)
  expect(second.json().message).toBe('The tutor is still replying.')
  release()
  expect(events((await first).payload).at(-1)).toEqual({ event: 'done', data: { awaiting: false } })
})

test('an unknown toolUseId is a 404 and a bad answer is a 400', async () => {
  const t = await setup([ask()])
  await t.send({ text: 'help' })
  const unknown = await t.answer('tu_nope', { answers: ['x'] })
  expect(unknown.statusCode).toBe(404)
  expect(unknown.json().message).toBe("That card isn't waiting for an answer.")
  const bad = await t.answer('tu_1', { answers: [] })
  expect(bad.statusCode).toBe(400)
  expect(bad.json().message).toBe('Pick an option or write your own answer.')
})

test('a rejected key mid-turn streams an error, then done', async () => {
  const t = await setup([
    () => Promise.reject(new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers())),
    text('back'),
  ])
  expect(events((await t.send({ text: 'help' })).payload)).toEqual([
    { event: 'error', data: { message: 'Your Anthropic API key was rejected.' } },
    { event: 'done', data: { awaiting: false } },
  ])
  // The message stayed stored, so the next one goes through.
  expect((await t.send({ text: 'again' })).statusCode).toBe(200)
  expect((await t.thread()).filter((i: { type: string }) => i.type === 'user')).toHaveLength(2)
})

test('requires a key and a known study', async () => {
  const t = await setup([])
  const noKey = await t.send({ text: 'help' }, undefined, {})
  expect(noKey.statusCode).toBe(401)
  const unknown = await t.send({ text: 'help' }, '/api/studies/nope/messages')
  expect(unknown.statusCode).toBe(404)
  expect(unknown.json().message).toBe('Study not found.')
  expect((await t.app.inject(`/api/studies/${t.studyId}`)).json()).toMatchObject({ goal: 'midterm', phase: 'probe', nodes: [], edges: [] })
})

test('study_state blocks never show in the thread view', async () => {
  const t = await setup([text('ok')])
  await t.send({ text: 'help' })
  expect(JSON.stringify(await t.thread())).not.toContain('study_state')
})

const setTitle = (title: unknown, id = 'tu_t'): Reply => ({
  content: [{ type: 'tool_use', id, name: 'set_goal_title', input: { title } }],
  stop_reason: 'tool_use',
})
/** The tool_result block the tutor got back in the given call. */
const lastToolResult = (call: Parameters<StreamMessage>[0]) =>
  (call.messages.at(-1)!.content as { type: string }[]).find(b => b.type === 'tool_result')

test('set_goal_title stores a short title that the study endpoints return', async () => {
  const t = await setup([setTitle('  Ace the midterm '), text('Titled.')])
  expect((await t.app.inject(`/api/studies/${t.studyId}`)).json().title).toBeNull()
  await t.send({ text: 'help' })
  expect(lastToolResult(t.calls[1])).toMatchObject({ content: 'Goal title set to "Ace the midterm".' })
  expect((await t.app.inject(`/api/studies/${t.studyId}`)).json().title).toBe('Ace the midterm')
  expect((await t.app.inject(`/api/projects/${t.projectId}`)).json().studies[0].title).toBe('Ace the midterm')
})

test('set_goal_title rejects a blank or over-80-character title', async () => {
  const t = await setup([setTitle('   ', 'tu_1'), setTitle('x'.repeat(81), 'tu_2'), text('ok')])
  await t.send({ text: 'help' })
  for (const call of t.calls.slice(1)) {
    expect(lastToolResult(call)).toMatchObject({ is_error: true, content: 'set_goal_title needs a title of 1–80 characters.' })
  }
  expect((await t.app.inject(`/api/studies/${t.studyId}`)).json().title).toBeNull()
})

test('deleting a goal removes it and its threads; mid-turn it is a 409', async () => {
  let release!: () => void
  let started!: () => void
  const running = new Promise<void>(resolve => (started = resolve))
  const t = await setup([
    () => {
      started()
      return new Promise(resolve => (release = () => resolve(text('done'))))
    },
  ])
  const del = () => t.app.inject({ method: 'DELETE', url: `/api/studies/${t.studyId}` })
  const turn = t.send({ text: 'help' })
  await running
  const busy = await del()
  expect(busy.statusCode).toBe(409)
  expect(busy.json().message).toBe('The tutor is still replying.')
  expect((await t.app.inject(`/api/studies/${t.studyId}`)).statusCode).toBe(200)
  release()
  await turn
  expect((await del()).statusCode).toBe(204)
  expect((await t.app.inject(`/api/studies/${t.studyId}`)).statusCode).toBe(404)
  expect((await t.app.inject(`/api/projects/${t.projectId}`)).json().studies).toEqual([])
  expect(t.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 })
  expect((await del()).statusCode).toBe(404)
})

/** A model call that blocks until `release()`, so the test can act while a turn runs. */
function held(reply: Reply = text('done')) {
  let release!: () => void
  let started!: () => void
  const running = new Promise<void>(resolve => (started = resolve))
  const step = () => {
    started()
    return new Promise<Reply>(resolve => (release = () => resolve(reply)))
  }
  return { step, running, release: () => release() }
}

test('stop is a 204 whether or not a turn is running', async () => {
  let started!: () => void
  const running = new Promise<void>(resolve => (started = resolve))
  const t = await setup([
    // Waits for Stop, then rejects the way an aborted stream does.
    opts =>
      new Promise((_resolve, reject) => {
        started()
        opts?.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')))
      }),
  ])
  const stop = (id = t.studyId) => t.app.inject({ method: 'POST', url: `/api/studies/${id}/stop` })
  expect((await stop()).statusCode).toBe(204)
  expect((await stop('nope')).statusCode).toBe(404)
  const turn = t.send({ text: 'help' })
  await running
  expect((await stop()).statusCode).toBe(204)
  expect(events((await turn).payload)).toEqual([{ event: 'done', data: { awaiting: false } }])
})

test('retry re-runs a failed turn without a new user message; otherwise it is a 409', async () => {
  const t = await setup([
    () => Promise.reject(new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers())),
    text('Recovered.'),
  ])
  const retry = (body: object = {}) => t.send(body, `/api/studies/${t.studyId}/retry`)
  expect((await retry()).statusCode).toBe(409) // empty thread
  await t.send({ text: 'help' })
  expect(events((await retry()).payload)).toEqual([
    { event: 'text', data: { delta: 'Recovered.' } },
    { event: 'done', data: { awaiting: false } },
  ])
  expect((await t.thread()).map((i: { type: string; text: string }) => [i.type, i.text])).toEqual([
    ['user', 'help'],
    ['assistant', 'Recovered.'],
  ])
  const again = await retry()
  expect(again.statusCode).toBe(409)
  expect(again.json().message).toBe('Nothing to retry.')
})

test('open starts the lesson in an empty node thread; with history it is a 204; before approval a 409', async () => {
  const t = await setup([text('Lesson one.')])
  const open = (nodeId: string) => t.send({ nodeId }, `/api/studies/${t.studyId}/open`)
  t.db.prepare("INSERT INTO nodes (id, study_id, label, kind, description, state, updated_at) VALUES ('n1', ?, 'Limits', 'root', 'd', 'untested', 0)").run(t.studyId)
  const early = await open('n1')
  expect(early.statusCode).toBe(409)
  expect(early.json().message).toBe('Node threads open once the plan is approved.')
  t.db.prepare("UPDATE studies SET phase = 'teach' WHERE id = ?").run(t.studyId)
  expect((await open('nope')).statusCode).toBe(404)
  expect(events((await open('n1')).payload)).toEqual([
    { event: 'text', data: { delta: 'Lesson one.' } },
    { event: 'done', data: { awaiting: false } },
  ])
  const sent = t.calls[0].messages.at(-1)!.content as { type: string; text: string }[]
  expect(sent[0]).toEqual({ type: 'text', text: '[App: The user opened "Limits". Teach it now.]' })
  expect(sent.at(-1)!.text).toMatch(/^<study_state>[\s\S]*Thread: node n1/)
  expect((await t.app.inject(`/api/studies/${t.studyId}`)).json().focusNodeId).toBe('n1')
  expect((await t.app.inject(`/api/studies/${t.studyId}/thread?nodeId=n1`)).json()).toMatchObject([{ type: 'assistant', text: 'Lesson one.' }])
  const reopened = await open('n1')
  expect(reopened.statusCode).toBe(204)
  expect(t.calls).toHaveLength(1)
})

test('retry, open, and messages are 409 while a turn runs', async () => {
  const h = held()
  const t = await setup([h.step])
  t.db.prepare("UPDATE studies SET phase = 'teach' WHERE id = ?").run(t.studyId)
  t.db.prepare("INSERT INTO nodes (id, study_id, label, kind, description, state, updated_at) VALUES ('n1', ?, 'Limits', 'root', 'd', 'untested', 0)").run(t.studyId)
  const turn = t.send({ text: 'help' })
  await h.running
  for (const res of [
    await t.send({}, `/api/studies/${t.studyId}/retry`),
    await t.send({ nodeId: 'n1' }, `/api/studies/${t.studyId}/open`),
    await t.send({ text: 'two' }),
  ]) {
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toBe('The tutor is still replying.')
  }
  h.release()
  expect(events((await turn).payload).filter(e => e.event === 'done')).toHaveLength(1)
  expect(t.calls).toHaveLength(1)
})

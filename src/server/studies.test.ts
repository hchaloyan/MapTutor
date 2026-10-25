import Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'vitest'
import { buildApp } from './app'
import { openDb } from './db'
import type { StreamMessage } from './tutor'

type Reply = { content: unknown[]; stop_reason: string }
const text = (t: string): Reply => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' })
const QUESTION = { question: 'What is the goal?', options: [{ label: 'Pass the midterm' }, { label: 'Understand it' }] }
const ask = (id = 'tu_1'): Reply => ({ content: [{ type: 'tool_use', id, name: 'ask_user_question', input: QUESTION }], stop_reason: 'tool_use' })
const KEY = { 'x-anthropic-key': 'sk-test' }

async function setup(script: (Reply | (() => Promise<Reply>))[]) {
  const streamMessage: StreamMessage = async (_params, _key, onText) => {
    const next = script.shift()!
    const reply = typeof next === 'function' ? await next() : next
    for (const b of reply.content as { type: string; text?: string }[]) if (b.type === 'text') onText(b.text!)
    return reply as unknown as Anthropic.Beta.BetaMessage
  }
  const app = buildApp({ db: openDb(':memory:'), streamMessage })
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Calc' } })).json()
  const study = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/studies`, payload: { goal: 'midterm' } })).json()
  const send = (body: object, url = `/api/studies/${study.id}/messages`, headers: Record<string, string> = KEY) =>
    app.inject({ method: 'POST', url, headers, payload: body })
  const answer = (toolUseId: string, answer: unknown) => send({ toolUseId, answer }, `/api/studies/${study.id}/tool-results`)
  const thread = async () => (await app.inject(`/api/studies/${study.id}/thread`)).json()
  return { app, studyId: study.id as string, send, answer, thread }
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

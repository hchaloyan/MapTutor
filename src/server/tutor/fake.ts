import type Anthropic from '@anthropic-ai/sdk'
import { AgentError } from '../core/agent'
import type { HtmlToMarkdown } from '../routes/files'
import { resultText } from './loop'
import { type SimModel, simEngine } from './sim'
import type { Summarize } from './teach'

type Block = { type: string; text?: string; id?: string; name?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
type Reply = { text: string; tool?: { name: string; input: unknown }; searching?: boolean }
type Messages = Anthropic.Beta.BetaMessageParam[]

const blocksOf = (m: Messages[number]): Block[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as Block[]))
const isApp = (b: Block) => b.type === 'text' && (b.text?.startsWith('<study_state>') || b.text?.startsWith('[App:'))

const options = (texts: string[]) => texts.map((text, i) => ({ id: 'abcd'[i], text }))

const PROBE = [
  { strand: 'functions', prompt: 'If $f(x) = 2x + 1$, what is $f(3)$?', options: ['$6$', '$7$', '$8$', '$5$'] },
  { strand: 'limits', prompt: 'What is $\\lim_{x \\to 2} (x^2 + 1)$?', options: ['$4$', '$5$', '$3$', 'It does not exist'] },
  { strand: 'derivatives', prompt: 'What is the derivative of $x^3$?', options: ['$x^2$', '$3x^2$', '$3x$', '$\\frac{x^4}{4}$'] },
]

const APPROACH =
  'You already have **functions** and **limits**, so we build **slope** as a limit of secant lines, turn it into the **derivative**, and finish with the **chain rule**, with an exam-style question at every step.'

const proposal = (approach: string) => ({
  approach,
  nodes: [
    { id: 'functions', label: 'Functions', kind: 'root', description: 'Inputs, outputs, and composing functions.', strands: ['functions'] },
    { id: 'limits', label: 'Limits', kind: 'root', description: 'What a function approaches near a point.', strands: ['limits'] },
    { id: 'slope', label: 'Slope', kind: 'derived', description: 'The slope of a curve at a point, as a limit of secant slopes.', strands: ['limits', 'derivatives'] },
    { id: 'derivative', label: 'Derivative', kind: 'derived', description: 'The slope at every point, as a new function.', strands: ['derivatives'] },
    { id: 'chain', label: 'Chain rule', kind: 'goal', description: 'Differentiating a composition of functions.', strands: ['derivatives'] },
  ],
  edges: [
    { from: 'functions', to: 'slope' },
    { from: 'limits', to: 'slope' },
    { from: 'slope', to: 'derivative' },
    { from: 'derivative', to: 'chain' },
  ],
})

const check = (nodeId: string, label: string) => ({
  items: [
    {
      id: `${nodeId}-1`,
      nodeId,
      prompt: `Which statement about **${label}** matches the lesson?`,
      options: options(['It only applies to straight lines', 'It is built from the limit we just set up', 'It needs no prerequisites', 'It is defined by a table of values']),
      correctOptionId: 'b',
      explanation: `${label} rests on the limit $\\lim_{h \\to 0}$ from the lesson; the other options drop that step.`,
    },
  ],
})

const lesson = (label: string) =>
  [
    `## ${label}`,
    `Let's build **${label}** from what you already know. Take a point $a$ and a small step $h$; the average rate of change over that step is $\\frac{f(a+h) - f(a)}{h}$.`,
    'Shrinking the step gives the instantaneous rate:',
    "$$f'(a) = \\lim_{h \\to 0} \\frac{f(a+h) - f(a)}{h}$$",
    '- The limit is what turns an average into an exact value.\n- Everything after this builds on that one move.',
    'Try the question below.',
  ].join('\n\n')

/** Picks the reply from the thread's last message and its newest study state. The goal itself is ignored. */
function script(messages: Messages): Reply {
  const last = blocksOf(messages.at(-1)!)
  // A tool result carries the newest state inside its content.
  const state = messages
    .flatMap(blocksOf)
    .flatMap(b => (b.type === 'tool_result' && Array.isArray(b.content) ? (b.content as Block[]) : [b]))
    .findLast(b => b.type === 'text' && b.text?.startsWith('<study_state>'))?.text ?? ''
  const phase = /^Phase: (\w+)/m.exec(state)?.[1]
  const node = /^Thread: node (\S+)/m.exec(state)?.[1]
  const next = /^Next node: (\S+)/m.exec(state)?.[1]
  const labelOf = (id: string) => new RegExp(`^- ${id} \\[\\w+\\] "([^"]*)"`, 'm').exec(state)?.[1] ?? id
  const toolUses = messages.flatMap(blocksOf).filter(b => b.type === 'tool_use')
  const focus = (lead: string): Reply =>
    next && next !== 'none' ? { text: `${lead} Next up: ${labelOf(next)}.`, tool: { name: 'focus_node', input: { nodeId: next } } } : { text: lead }

  const result = last.find(b => b.type === 'tool_result')
  if (result) {
    const name = toolUses.find(b => b.id === result.tool_use_id)?.name
    const content = resultText(result as Anthropic.Beta.BetaToolResultBlockParam)
    if (result.is_error) return { text: `That didn't work: ${content}` }
    const json = () => JSON.parse(content) // client tools answer in JSON; server tools in plain text
    if (name === 'ask_user_question') return { text: '', tool: { name: 'set_goal_title', input: { title: 'Ace the calculus midterm' } } }
    if (name === 'set_goal_title') {
      return {
        searching: true,
        text: "Great. Three quick questions so I can see where you're starting from.",
        tool: { name: 'quiz', input: { items: PROBE.map((q, i) => ({ id: `q${i + 1}`, strand: q.strand, prompt: q.prompt, options: options(q.options), correctOptionId: 'b', explanation: 'The second option follows from the definition.' })) } },
      }
    }
    if (name === 'propose_graph' && phase === 'plan') {
      return { text: 'Revised.', tool: { name: 'propose_graph', input: proposal(`Revised for your note: "${json().text}". ${APPROACH}`) } }
    }
    if (name === 'propose_graph' && phase === 'teach') return focus('Plan approved.')
    if (name === 'quiz') {
      const results = json().results as { correct: boolean }[]
      if (phase === 'probe' || phase === 'plan') return { text: "Here's the plan I'd suggest.", tool: { name: 'propose_graph', input: proposal(APPROACH) } }
      if (phase === 'done') return { text: "That's the goal. Nicely done." }
      if (node && results.some(r => !r.correct)) {
        return { text: 'Not quite. The key is the limit: the slope comes from shrinking $h$ to $0$. Try it again.', tool: { name: 'quiz', input: check(node, labelOf(node)) } }
      }
      return focus('Correct.')
    }
  }

  if (node && last.some(b => b.type === 'text' && b.text?.startsWith('[App:'))) {
    return { text: lesson(labelOf(node)), tool: { name: 'quiz', input: check(node, labelOf(node)) } }
  }
  // What the user typed since the tutor last spoke; a Retry adds an app note after it.
  const since = messages.slice(messages.findLastIndex(m => m.role === 'assistant') + 1)
  const said = since.flatMap(blocksOf).findLast(b => b.type === 'text' && !isApp(b))?.text
  if (said && phase === 'probe' && !toolUses.some(b => b.name === 'ask_user_question')) {
    return {
      text: "Happy to help. First, what's the aim?",
      tool: {
        name: 'ask_user_question',
        input: {
          question: 'What do you want to be able to do by the end?',
          options: [
            { label: 'Pass the midterm next week', description: 'Limits through the chain rule, exam-style problems' },
            { label: 'Really understand derivatives', description: 'Slower, from first principles' },
            { label: 'Catch up on what I missed' },
          ],
        },
      },
    }
  }
  return { text: said ? `You said: ${said}` : "I'm here. What would you like to do next?" }
}

/** The scripted model: thinking, then the reply in chunks. Stop rejects the way an aborted stream does. */
export function fakeModel({ delayMs }: { delayMs: number }): SimModel {
  const failed = new Set<string>()
  return async (messages, onText, { onStatus, signal }) => {
    // A user message containing [fail] errors once, so the error line and Retry can be tried.
    const said = blocksOf(messages.at(-1)!).find(b => b.type === 'text' && b.text?.includes('[fail]'))?.text
    if (said && !failed.has(said)) {
      failed.add(said)
      throw new AgentError('Claude is overloaded right now. Try again in a moment.')
    }
    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Request was aborted.'))
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('Request was aborted.'))), { once: true })
      })
    const reply = script(messages)
    onStatus('thinking')
    await wait(delayMs)
    if (reply.searching) {
      onStatus('searching')
      await wait(delayMs)
    }
    for (const chunk of reply.text.match(/(?:\S+\s*){1,4}|\s+/g) ?? []) {
      await wait(delayMs / 4)
      onText(chunk)
    }
    await wait(0) // a Stop during the last chunk still counts
    return {
      id: `msg_fake_${crypto.randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: 'fake-tutor',
      content: [
        ...(reply.text ? [{ type: 'text', text: reply.text, citations: null }] : []),
        ...(reply.tool ? [{ type: 'tool_use', id: `toolu_fake_${crypto.randomUUID()}`, ...reply.tool }] : []),
      ],
      stop_reason: reply.tool ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Beta.BetaMessage
  }
}

/** A scripted tutor for building and testing the frontend without calling Claude. */
export function fakeTutor({ delayMs }: { delayMs: number }) {
  const summarize: Summarize = async transcript => `Fake summary: ${transcript.split('\n')[0]}`
  const htmlToMarkdown: HtmlToMarkdown = async html => html.replace(/<[^>]*>/g, '')
  return { runHop: simEngine(fakeModel({ delayMs })), summarize, htmlToMarkdown }
}

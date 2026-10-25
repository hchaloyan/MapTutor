# Tutor agent

## Why

The tutor runs on the Claude Agent SDK. Each thread (the main thread, or one node's thread) is one Claude Code session: its transcript is kept and resumed, so Claude remembers that thread's conversation and nothing else. Everything in this file follows from that:

- **Structured state lives in the app.** It goes through tools into the database. The transcript is the model's memory of a conversation, never where the app reads state from.
- **The app grades quizzes.** The model doesn't grade its own questions, which removes one source of error.
- **One session per thread.** A single shared chat would carry every lesson into every turn, with topics interleaved. Cost would grow each turn, and the tutor's focus on the current node would get diluted. Per-node threads with short summaries keep each session small and on-topic.

## Principle

The tutor never drives the UI with free text. Anything structured (quizzes, goal questions, the graph, node states) goes through a tool call that the app renders and validates. Chat text is for explanation only.

## System prompt

The prompt is fixed and identical for every user:

1. **The teaching skill**, verbatim from [prompts/teaching-skill.md](prompts/teaching-skill.md), with its frontmatter stripped (philosophy, Principle i, Principle ii, probe → plan → teach, quiz-option construction rules, LaTeX formatting).
2. **An app appendix** that maps the skill's references onto this app:

| Skill says | In the app |
|---|---|
| `quiz` | `quiz` tool |
| `ask_user_question` | `ask_user_question` tool, allowed in every phase |
| `researcher` subagent | Web search tool (see [Verification](#verification)) |
| "Draw the dependency map as mermaid" | `propose_graph` tool. Do not write mermaid in chat |
| "Wait for his go-ahead" | `propose_graph` returns only after the user approves or sends feedback |
| Obsidian renders LaTeX | The chat renders Markdown with KaTeX (`$…$`, `$$…$$`) |
| "Him" | The current user |

The appendix also tells the tutor:

- How to read the `<study_state>` block (the current phase and its allowed tools live there, not in the system prompt).
- That every probe quiz item needs a `strand`, and every quiz-check item needs a `nodeId`.
- To settle the goal (the skill's 1b) before the level quiz (1a), because the strands to probe depend on the goal.
- To put the prose approach in `propose_graph`'s `approach` field, not in chat.
- To name the goal with `set_goal_title` once it is concrete.
- That an app note saying the user opened a node means: teach that node now, from its beginning.
- **Files first:** the project files are the user's own course material. Teach from them (their definitions, notation, and scope), check them before searching the web, search when they don't answer or seem wrong, and say so when a file disagrees with a reliable source.
- **Teach new foundations inline:** a foundational fact that has no node is taught in the current node's thread (motivate, establish, connect, quiz-check there). There is no `add_node`.

## Tools

### Client-rendered tools

These render a card in the UI and pause the loop until the user acts: the call defers (see [Tool loop](#tool-loop)). The user's action becomes the `tool_result`.

```ts
ask_user_question({
  question: string,
  options: { label: string, description?: string }[],  // 2–4 options; the UI always adds "Other"
  multiSelect?: boolean
}) -> { answers: string[] }

quiz({
  items: {
    id: string,
    prompt: string,                       // Markdown + LaTeX
    options: { id: string, text: string }[],
    correctOptionId: string,
    explanation: string,                  // shown only after answering
    strand?: string,                      // required during probe
    nodeId?: string                       // required during quiz-check
  }[]
}) -> { results: { itemId, chosenOptionId, correct: boolean }[] }

propose_graph({
  approach: string,                       // the prose plan, shown above the approval card
  nodes: {
    id: string,
    label: string,                        // about 3 words; it sits inside a small circle
    kind: "root" | "derived" | "goal",
    description: string,
    strands: string[]                     // probe strands that bear on this node
  }[],
  edges: { from: string, to: string }[]   // from = prerequisite
}) -> { decision: "approved" } | { decision: "feedback", text: string }
```

The app grades quizzes itself by comparing `chosenOptionId` to `correctOptionId`. The tutor receives the results and never grades its own questions.

The skill says "the tool already tells you to keep options even", so the `quiz` tool description must say it: options are parallel in length, grain size, and register, and none carries its own justification.

### Server-only tools

These run immediately and return an acknowledgement or an error.

```ts
set_node_state({ nodeId, state, reason }) -> ok | error   // guarded; see 03-graph.md
focus_node({ nodeId }) -> ok                               // highlights the node and switches the active thread
set_goal_title({ title }) -> ok | error                    // probe and plan; 1–80 characters, about 2–6 words; the UI shows it as the goal's name
```

### Validation on `propose_graph`

The server rejects the call with an error `tool_result` if any of these fail:

- The edges form a cycle.
- There is not exactly one `goal` node.
- A `root` node has a prerequisite.
- A node is unreachable from every root.
- A node's `strands` contains a name that wasn't used as a `strand` on any probe quiz item in this study. The match is exact. The error lists the valid strand names so the tutor can correct the call.

Initial node states are computed by the app from probe evidence, not supplied by the tutor (see [03-graph.md](03-graph.md#initial-states)).

## Tool loop

A turn is a chain of **hops** (at most 20). A hop is one `query()` on the thread's session, allowed up to 20 model calls, and it runs until the model ends its turn, a card defers, or `focus_node` switches threads.

1. **Tools.** The tutor's tools are an MCP server named `tutor`, served by MapTutor's own Fastify server at `POST /mcp/:hop` (a random id per hop, removed when the hop ends). Claude Code sees them as `mcp__tutor__<name>`, next to its own `WebSearch`. A `PreToolUse` hook asks the loop to decide each call:
   - A tool the current phase doesn't allow is denied with the reason, which Claude sees as an error.
   - A card batched with other calls in one message can't defer, so its handler refuses it ("call it on its own"). The prompt also says to call one tool per message.
2. **Server-only tool:** its handler runs at once and Claude continues within the hop. `focus_node` ends the hop after its result (`PostToolUse` returns `continue: false`); the next hop starts in the target thread with an `[App: …]` note.
3. **Client-rendered tool:** the hook returns `defer`. The hop ends with the call deferred; the loop runs the tool's pause step once, marks the call pending and streams the card. When the user answers, the route grades or applies the answer exactly once and stores the `tool_result`, then resumes the session with **no prompt**. The hook fires again for the same `tool_use_id`, finds the stored answer, and the handler returns it.
4. When the model ends its turn, the turn is done.

**The `messages` table is a display mirror** of the sessions: thread views, summaries and pending cards read it; the model's context is the session. The prompt row is written when a session starts, assistant rows as they arrive, and tool results unless the route already stored that answer.

Responses stream over SSE: `text { delta }`, `status { kind: 'thinking' | 'searching' }` (when a thinking block or a web search starts; the client runs the timer), `card`, `focus { nodeId }`, `error { message }`, and exactly one `done { awaiting }`.

**Turn control.** One turn runs per study at a time; anything else that would start one gets a 409.

- **Stop** (`POST /api/studies/:id/stop`) interrupts the running hop (`Query.interrupt()`; aborting the query doesn't stop generation). The text streamed so far stays in the transcript and the thread, no usage is recorded for the interrupted hop, no further hop runs, and the client gets `done`.
- **Retry** (`POST /api/studies/:id/retry { nodeId? }`) re-runs a thread whose last message got no reply (after an error), without sending the user's message twice. If the last message is a card answer, it resumes the deferred call with no prompt; otherwise it sends `[App: Your last reply did not arrive. Reply to the thread as it stands.]`. Nothing to retry is a 409.
- **Open** (`POST /api/studies/:id/open { nodeId }`) starts the lesson in a node thread with no messages: it focuses the node and appends a hidden `[App: The user opened "<label>". Teach it now.]` note with the study state. A node with history answers 204 and starts nothing.

## Context assembly

Each thread's session holds, in order:

| Part | Contents |
|---|---|
| System | The fixed prompt and app appendix, identical for every session |
| First prompt | The project files (PDFs and images as native content blocks; Markdown and fetched URLs as text), the user's text, and `<study_state>` |
| Later prompts | The user's text (or an `[App: …]` note) and `<study_state>` |

Claude Code caches the session's prefix on its own.

**Study state** (goal, phase, allowed tools, graph with states and evidence counts, summaries of Known nodes) is a `<study_state>` text block on every prompt the server sends. The newest one is current.

**Why append-only.** The system prompt never carries state, and the tool set is the same in every phase (the hook denies a tool outside the current phase), so a session's history is never edited; state rides on new prompts instead. The project files go into a thread's first prompt only: a file added or changed mid-study reaches threads started after the change.

Per-node threads keep each session small and make out-of-order navigation cheap. A node's thread never carries another node's transcript, only that node's summary.

**Summaries.** When a node first becomes Known, the server makes a cheap side call: "Summarize what was established in this node and how it connects, in 2–3 sentences." The result is stored in `node.summary`.

## Verification

The skill requires checking any uncertain fact before teaching it. The app does this with Claude Code's `WebSearch` tool:

- **Every phase:** web search is enabled with no cap (the model decides how much to search), because the skill says to verify any uncertain fact before saying it, and probe quiz items state facts too. The files come first: the tutor checks them before searching.
- **Plan phase:** one scoping pass before `propose_graph`, to confirm the core concepts, first principles, and common gotchas.
- **Corrections:** if a check changes something already taught, the prompt tells the tutor to say so openly.
- **Cost:** searches count against the user's plan. The usage popover shows the search count.

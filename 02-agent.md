# Tutor agent

## Why

The Claude API is stateless: Claude sees only what the backend sends in each request. Prompt caching makes resending a repeated prefix cheaper and faster, but it does not give Claude memory. Everything in this file follows from that:

- **Structured state lives in the app.** It goes through tools into the database, because the model keeps nothing between requests.
- **The app grades quizzes.** The model doesn't grade its own questions, which removes one source of error.
- **Context is assembled fresh for every request.** A single shared chat would resend every lesson on every turn, with topics interleaved. Cost would grow each turn, and the tutor's focus on the current node would get diluted. Per-node threads with short summaries keep each request small and on-topic.

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

These render a card in the UI and pause the loop until the user acts. The user's action becomes the `tool_result`.

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

1. The server calls the Messages API with the assembled context and the full tool set. A tool the current phase doesn't allow gets an error `tool_result`. At most one tool call per assistant message (`disable_parallel_tool_use`).
2. If the response ends with `tool_use`:
   - **Server-only tool:** execute it, append the `tool_result`, and go back to step 1.
   - **Client-rendered tool:** persist the pending tool call, stream the card to the client, and stop. When the user responds, append the `tool_result` and go back to step 1.
3. Otherwise, persist the assistant message and stream it to the client.

Responses stream over SSE: `text { delta }`, `status { kind: 'thinking' | 'searching' }` (when a thinking block or a web search starts; the client runs the timer), `card`, `focus { nodeId }`, `error { message }`, and exactly one `done { awaiting }`.

**Turn control.** One turn runs per study at a time; anything else that would start one gets a 409.

- **Stop** (`POST /api/studies/:id/stop`) aborts the running stream. The text streamed so far is appended as a text-only assistant message (the cut-off step's thinking and tool blocks are dropped; appending is still append-only), usage is recorded from what the stream reported, no further model call is made, and the client gets `done`. Stopped before any text, nothing is stored; the next user message follows the last one, and the API merges the two.
- **Retry** (`POST /api/studies/:id/retry { nodeId? }`) re-runs a thread whose last message is a user message with no reply (after an error), without adding anything. Otherwise 409.
- **Open** (`POST /api/studies/:id/open { nodeId }`) starts the lesson in a node thread with no messages: it focuses the node and appends a hidden `[App: The user opened "<label>". Teach it now.]` note with the study state. A node with history answers 204 and starts nothing.

## Context assembly

The context for each request is built from these blocks, in this order:

| Block | Contents | Cached? |
|---|---|---|
| System | Fixed prompt and app appendix, identical on every request | Yes (breakpoint 1, 1h) |
| Project files | One leading user message: PDFs and images as native content blocks; Markdown and fetched URLs as text | Yes (breakpoint 2, 1h) |
| Thread | Messages from the active thread (main thread or one node's thread), append-only | Yes (breakpoint 3 on the last message, 1h) |

**Study state** (goal, phase, allowed tools, graph with states and evidence counts, summaries of Known nodes) is a `<study_state>` text block appended to every user message the server sends, stored with that message, and never rewritten. The newest one is current.

**Why append-only.** Opus 5.5 checks that the `system` prompt, the `tools`, and every earlier message are unchanged since each replayed thinking block was produced, and rejects edited history on new accounts. So the system prompt never carries state, `tools` is always the full set (the server rejects a tool outside the current phase with an error `tool_result`), and state rides on new messages instead of being rebuilt. Changing project files mid-study is the one prefix change left; requests set `prefix_mismatch_behavior: "drop_block"` so stale thinking is dropped instead of failing.

Per-node threads keep the context small and make out-of-order navigation cheap. A node's thread never carries another node's transcript, only that node's summary.

**Summaries.** When a node first becomes Known, the server makes a cheap side call: "Summarize what was established in this node and how it connects, in 2–3 sentences." The result is stored in `node.summary`.

## Verification

The skill requires checking any uncertain fact before teaching it. The app does this with Claude's server-side web search tool:

- **Every phase:** web search is enabled with no `max_uses` cap (the model decides how much to search), because the skill says to verify any uncertain fact before saying it, and probe quiz items state facts too. The files come first: the tutor checks them before searching.
- **Plan phase:** one scoping pass before `propose_graph`, to confirm the core concepts, first principles, and common gotchas.
- **Corrections:** if a check changes something already taught, the prompt tells the tutor to say so openly.
- **Cost:** searches are billed to the user's key. The usage popover shows the search count.

Use the tool version listed in the current Claude API docs.

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

- The current phase and its allowed tools.
- That every probe quiz item needs a `strand`, and every quiz-check item needs a `nodeId`.
- To settle the goal (the skill's 1b) before the level quiz (1a), because the strands to probe depend on the goal.
- To put the prose approach in `propose_graph`'s `approach` field, not in chat.

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
    hint?: string,
    strand?: string,                      // required during probe
    nodeId?: string                       // required during quiz-check
  }[]
}) -> { results: { itemId, chosenOptionId, correct: boolean }[] }

propose_graph({
  approach: string,                       // the prose plan, shown above the approval card
  nodes: {
    id: string,
    label: string,                        // short
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

1. The server calls the Messages API with the assembled context and the phase's allowed tools.
2. If the response ends with `tool_use`:
   - **Server-only tool:** execute it, append the `tool_result`, and go back to step 1.
   - **Client-rendered tool:** persist the pending tool call, stream the card to the client, and stop. When the user responds, append the `tool_result` and go back to step 1.
3. Otherwise, persist the assistant message and stream it to the client.

Responses stream over SSE.

## Context assembly

The context for each request is built from these blocks, in this order:

| Block | Contents | Cached? |
|---|---|---|
| System | Fixed prompt and app appendix | Yes (breakpoint 1) |
| Project files | PDFs and images as native content blocks; Markdown and fetched URLs as text | Yes (breakpoint 2) |
| Study state | Goal, phase, graph JSON with states and evidence counts, summaries of Known nodes | No |
| Thread | Messages from the active thread (main thread or one node's thread) | No |

Per-node threads keep the context small and make out-of-order navigation cheap. A node's thread never carries another node's transcript, only that node's summary.

**Summaries.** When a node first becomes Known, the server makes a cheap side call: "Summarize what was established in this node and how it connects, in 2–3 sentences." The result is stored in `node.summary`.

## Verification

The skill requires checking any uncertain fact before teaching it. The app does this with Claude's server-side web search tool:

- **Every phase:** web search is enabled with a low per-request `max_uses` cap, because the skill says to verify any uncertain fact before saying it, and probe quiz items state facts too.
- **Plan phase:** one scoping pass before `propose_graph`, to confirm the core concepts, first principles, and common gotchas.
- **Corrections:** if a check changes something already taught, the prompt tells the tutor to say so openly.
- **Cost:** searches are billed to the user's key. The project page shows a note about this. The per-request cap should be a setting.

Use the tool version listed in the current Claude API docs.

# Agent Loop (Component 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The tutor runs. A user message in a thread goes to Claude with the fixed prompt, the project files, the study state, and that thread's history. Replies stream back over SSE. A client-rendered tool (`ask_user_question` for now) pauses the loop until the user answers.

**Architecture:** `context.ts` assembles each request, `tools.ts` holds the tool registry, `tutor.ts` runs the loop, and `studies.ts` provides the HTTP and SSE routes. The Claude call sits behind an injectable `streamMessage`, so tests script responses and inspect the requests. Components 4–6 add tools to the registry and lines to the study-state block.

**Tech Stack:** Fastify 5, `node:sqlite`, `@anthropic-ai/sdk` 1.3 (`client.beta.messages.stream`), Vitest.

**Spec:** [02-agent.md](../../../02-agent.md) (Tools, Tool loop, Context assembly), [01-user-flow.md](../../../01-user-flow.md), [prompts/teaching-skill.md](../../../prompts/teaching-skill.md)

## Global Constraints

**Each thread's history is append-only.** Opus 5.5 rejects a replayed thinking block when the `system` prompt, the `tools`, or any earlier message changed since the block was made. Every design choice below follows from that:
- **Frozen system prompt.** `system` is the teaching skill plus `prompts/app-appendix.md`, identical on every request, with no phase or state in it.
- **Fixed tool list.** `tools` is always the full set, in a fixed order. The server enforces the phase by returning an error `tool_result` for a tool the current phase doesn't allow.
- **State rides on each new message.** The current study state is a `<study_state>…</study_state>` text block appended to every user message the server sends (user text and `tool_result` messages alike). It's stored with the message and never rewritten. The model reads the newest one.
- **Stored as sent.** Messages are stored as the exact content blocks sent or received. `cache_control` markers are added at request time only and never stored.
- **Escape hatch for file changes.** Changing project files mid-study is the one unavoidable prefix change, so requests set `thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }`. Stale thinking is dropped instead of failing with a 400.

**Request parameters (pinned):**
- `model: TUTOR_MODEL`, `max_tokens: 64000`, `output_config: { effort: 'high' }`
- `tool_choice: { type: 'auto', disable_parallel_tool_use: true }`, so there's at most one tool call per assistant message
- `betas: ['thinking-binding-controls-2026-08-01', 'server-side-fallback-2026-07-01']`, `fallbacks: 'default'`
- `tools`: the registry's client and server tools, then `{ type: 'web_search_20260209', name: 'web_search', max_uses: WEB_SEARCH_MAX_USES }` with `WEB_SEARCH_MAX_USES = 3` in `config.ts`

**Cache breakpoints:** all are `{ type: 'ephemeral', ttl: '1h' }`, since quiz pauses can outlast 5 minutes.
1. The last `system` block.
2. The last project-file block. Files go in one leading user message; it's omitted when the project has no files.
3. The last block of the last message.

**Turns and SSE:**
- **Step cap.** At most `MAX_STEPS = 20` model calls per user turn.
- **One turn per thread.** An in-memory set of running thread keys enforces this. Mark it with a `// ponytail:` comment, since it only holds for a single process.
- **SSE events:** `text {delta}`, `card {toolUseId, name, input}`, `error {message}`, `done {awaiting: boolean}`. Every response ends with exactly one `done`, and an `error` is followed by `done {awaiting: false}`.

## Review Focus

1. **A second request on a thread while a turn runs or a card is pending.** It gets a 409 and isn't streamed. Tests in Task 3.
2. **An Anthropic error mid-turn** (bad key, 5xx). The client gets an SSE `error` with the mapped message, then `done`. The user's message stays stored, so a retry works. Test in Task 3.
3. **History is append-only across turns.** A second request's `messages` must start with the first request's `messages`, byte for byte (ignoring `cache_control`). Test in Task 2.
4. **`pause_turn`** from web search continues the turn instead of ending it. Test in Task 2.
5. **An unknown tool or a malformed `ask_user_question` input.** It becomes an error `tool_result` and the loop continues; nothing crashes. Test in Task 2.

---

### Task 1: Prompt and context assembly

**Files:**
- Create: `prompts/app-appendix.md`, `src/server/prompt.ts`, `src/server/context.ts`
- Modify: `src/server/config.ts` (`WEB_SEARCH_MAX_USES`), `02-agent.md` (Context assembly and the phase-tools rule now match Global Constraints)
- Test: `src/server/context.test.ts`

**Interfaces:**
- Produces:
  - `systemPrompt(): string` returns the teaching skill without its frontmatter, then `\n\n`, then the appendix. It's read once and memoized.
  - `fileBlocks(db, projectId): Anthropic.Beta.BetaContentBlockParam[]`
    - PDF: `{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: name }`.
    - Image: `{ type: 'image', source: { type: 'base64', media_type: mediaType(file), data } }`.
    - Text and URL files: `{ type: 'text', text: '<file name="…">\n…\n</file>' }`.
    - Files come in upload order.
  - `studyStateText(db, studyId, nodeId: string | null, allowedTools: string[]): string` returns a `<study_state>` block with lines `Goal: …`, `Phase: …`, `Thread: main` (or `Thread: node <id>`), and `Tools allowed now: a, b`. Components 5–6 add graph lines.
  - `buildRequest(db, studyId, nodeId, tools: Anthropic.Beta.BetaToolUnion[]): Anthropic.Beta.Messages.MessageStreamParams`, with every pinned parameter and breakpoint above
  - `threadMessages(db, studyId, nodeId): Anthropic.Beta.BetaMessageParam[]`: the stored rows in order, with content parsed

The appendix covers:
- The mapping table from 02-agent.md (the `researcher` subagent → the web search tool; mermaid → `propose_graph`; Obsidian → Markdown with KaTeX `$…$` / `$$…$$`; "him" → the current user).
- The `<study_state>` contract: the app writes it, the user neither sees nor wrote it, the newest one is current, and only the listed tools are accepted.
- Structured things go through tools, and chat text is explanation only.
- Probe items need `strand` and check items need `nodeId`.
- Settle the goal before the level quiz.
- The approach goes in `propose_graph.approach`.

- [ ] **Step 1: Write the failing tests**

```ts
test('system prompt drops the frontmatter and keeps the skill and appendix') // no '---\nname: teach'; contains '# Teaching' and '<study_state>'
test('system prompt is identical on every call')
test('file blocks: pdf as document, image with media type, text wrapped with its name') // upload 3 files via db insert
test('study state lists goal, phase, thread, and allowed tools')
test('request pins model, effort, thinking binding, fallbacks, tool choice, and web search cap')
test('breakpoints sit on system, the last file block, and the last message, all 1h')
test('no files means no leading file message')
```

- [ ] **Step 2: Run the tests to make sure they fail.** Run: `npm test -- context`. Expected: FAIL (missing module).

- [ ] **Step 3: Implement.** Read prompt files relative to the repo root with `new URL('../../prompts/…', import.meta.url)`. Clone each stored message before adding `cache_control`, so stored rows never change.

- [ ] **Step 4: Run the tests to make sure they pass.** Run: `npm test` and `npm run typecheck`. Expected: all pass, exit 0.

- [ ] **Step 5: Commit**: `feat: tutor prompt and context assembly`

### Task 2: Tool registry and the loop

**Files:**
- Create: `src/server/tools.ts`, `src/server/tutor.ts`
- Test: `src/server/tutor.test.ts`

**Interfaces:**
- Consumes: `buildRequest`, `studyStateText`, `threadMessages` from Task 1
- Produces:
  - `type StreamMessage = (params: MessageStreamParams, apiKey: string, onText: (delta: string) => void) => Promise<Anthropic.Beta.BetaMessage>`; the real one is in `anthropic.ts` (`clientFor(key).beta.messages.stream(params).on('text', onText).finalMessage()`)
  - `type Phase = 'probe' | 'plan' | 'teach' | 'done'`
  - `type ToolCtx = { db: DatabaseSync; studyId: string; nodeId: string | null }`
  - `type ClientTool = { kind: 'client'; def: Anthropic.Beta.BetaTool; phases: Phase[]; check(input: unknown, ctx: ToolCtx): string | null; card(input: unknown, ctx: ToolCtx): unknown; answer(input: unknown, answer: unknown, ctx: ToolCtx): { content: string } | { error: string } }`
  - `type ServerTool = { kind: 'server'; def: Anthropic.Beta.BetaTool; phases: Phase[]; run(input: unknown, ctx: ToolCtx): { content: string; isError?: boolean } }`
  - `TOOLS: (ClientTool | ServerTool)[]`, starting with `ask_user_question` (all phases). Its schema comes from 02-agent.md: 2–4 options and an optional `multiSelect`. `check` rejects empty or out-of-range option counts. `answer` takes `{ answers: string[] }` with at least one non-empty string and returns `JSON.stringify({ answers })`.
  - `type Emit = (event: 'text' | 'card' | 'error' | 'done', data: object) => void`
  - `runTurn(opts: { db; studyId; nodeId; apiKey; streamMessage: StreamMessage; emit: Emit }): Promise<void>`: runs from the thread's current state (its last row is a user message) until `end_turn`, a pause, an error, or `MAX_STEPS`
  - `appendUserMessage(db, studyId, nodeId, content: BetaContentBlockParam[]): void` appends the content plus the current `<study_state>` block
  - `pendingCard(db, studyId, nodeId): { messageId: string; toolUse: Anthropic.Beta.BetaToolUseBlock } | null`
- Loop rules:
  - **Each response:** store it as an assistant row.
  - **`end_turn`:** `done {awaiting:false}`.
  - **`pause_turn`:** call again.
  - **`refusal`:** `error 'The tutor declined to answer that. Try rephrasing.'`.
  - **`max_tokens`:** `error 'The reply was too long and got cut off.'`.
  - **`tool_use`:**
    - Unknown tool, or a tool this phase doesn't allow: append an error `tool_result` and call again. The copy is `` `<name>` isn't available in the <phase> phase. `` or `` Unknown tool `<name>`. ``.
    - Server tool: run it, append its result, and call again.
    - Client tool with a failing `check`: append an error `tool_result` with that message and call again.
    - Client tool that passes `check`: mark the row `pending = 1`, then emit `card {toolUseId, name, input: card(input)}` and `done {awaiting:true}`.
  - **Step cap:** after `MAX_STEPS`, `error 'The tutor took too many steps. Send a message to continue.'`.

- [ ] **Step 1: Write the failing tests** (a fake `streamMessage` pops scripted `BetaMessage`s and records `params`)

```ts
test('streams text and stores the assistant reply')            // fake calls onText('Hi'); emits text, done{awaiting:false}; 2 rows
test('history is append-only across turns')                    // turn 1 end_turn; append user msg; turn 2 → params2.messages starts with params1.messages (strip cache_control) + assistant reply
test('a valid ask_user_question pauses with a card')           // stop tool_use → row pending=1, card emitted, done{awaiting:true}, 1 model call
test('a malformed ask_user_question is returned as an error')  // 1 option → tool_result is_error with check message, then end_turn; 2 calls
test('an unknown tool becomes an error tool_result')
test('pause_turn continues the turn')                          // [pause_turn, end_turn] → 2 calls, one done
test('refusal ends the turn with an error')
test('stops after MAX_STEPS model calls')                      // fake always returns an unknown tool → 20 calls, error, done
test('every user message the server sends ends with study_state')
```

- [ ] **Step 2: Run the tests to make sure they fail.** Run: `npm test -- tutor`. Expected: FAIL (missing module).

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to make sure they pass.** Run: `npm test` and `npm run typecheck`. Expected: all pass, exit 0.

- [ ] **Step 5: Commit**: `feat: tutor tool loop with pause on client tools`

### Task 3: Study routes and SSE

**Files:**
- Create: `src/server/studies.ts`
- Modify: `src/server/app.ts` (`streamMessage?: StreamMessage` option, defaulting to the real one; register routes), `src/server/anthropic.ts` (`streamMessage`)
- Test: `src/server/studies.test.ts`

**Interfaces:**
- Consumes: `runTurn`, `appendUserMessage`, `pendingCard`, `TOOLS` from Task 2; `apiKey` and the error mapping from component 1
- Produces:
  - `GET /api/studies/:id` → `{ id, projectId, goal, phase, approach, nodes: [], edges: [] }`. The node and edge lists stay empty until component 5. Unknown id → 404 `Study not found.`
  - `GET /api/studies/:id/thread?nodeId=` returns the items for one thread:
    - `{ type: 'user', text, createdAt }` for user text blocks, not counting `<study_state>` blocks.
    - `{ type: 'assistant', text, createdAt }` for assistant text blocks.
    - `{ type: 'card', toolUseId, name, input, answer, pending, createdAt }` for client tool calls. `input` is `card(input)`; `answer` is the parsed `tool_result` content, or `null` when there isn't one.
  - `POST /api/studies/:id/messages { text, nodeId? }` streams SSE. Body: `text` 1–20000 chars.
  - `POST /api/studies/:id/tool-results { toolUseId, answer }` streams SSE. The answer becomes the `tool_result`, and the turn resumes.
  - These are checked before the stream starts, as plain JSON errors:
    - A missing key gives 401.
    - An unknown study gives 404.
    - A thread that's already running gives 409 `The tutor is still replying.`
    - `messages` while a card is pending gives 409 `Answer the card first.`
    - A `toolUseId` that isn't the pending card gives 404 `That card isn't waiting for an answer.`
    - A rejected `answer` gives 400 with the tool's error message.
  - Errors during the stream become SSE `error` events, mapped like the component 1 handler. A rejected key reads `Your Anthropic API key was rejected.`

- [ ] **Step 1: Write the failing tests** (parse `res.payload` into `{event, data}` pairs)

```ts
test('a message streams text and done, and the thread shows both turns')
test('a card pauses; answering resumes the turn and the thread shows the answer')
test('sending a message while a card is pending is a 409')
test('a second request while a turn runs is a 409')          // fake streamMessage awaits a promise the test resolves later
test('an unknown toolUseId is a 404 and a bad answer is a 400')
test('a rejected key mid-turn streams an error, then done')  // fake throws new Anthropic.AuthenticationError(401, …, …, new Headers())
test('requires a key and a known study')
test('study_state blocks never show in the thread view')
```

- [ ] **Step 2: Run the tests to make sure they fail.** Run: `npm test -- studies`. Expected: FAIL (missing module).

- [ ] **Step 3: Implement.** For SSE, do the pre-checks, then `reply.hijack()`, write headers `content-type: text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`, then write `event: <name>\ndata: <json>\n\n` for each event. Release the thread lock and end the response in `finally`. If the client disconnects, the turn keeps running so state stays consistent.

- [ ] **Step 4: Run the tests to make sure they pass.** Run: `npm test` and `npm run typecheck`. Expected: all pass, exit 0.

- [ ] **Step 5: Real-API check (only when `ANTHROPIC_API_KEY` is set).** Create a project and a study, then `curl -N` a message. Expected: `text` events, then `done`. Otherwise, record it as skipped.

- [ ] **Step 6: Commit**: `feat: study routes with SSE streaming`

# Frontend Support (Component 7b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The backend changes the frontend design needs: no quiz hints and no search cap, goal titles, project renaming and counts, goal deletion, `status` events, Stop, Retry, opening an untaught node, a key check, and a scripted fake tutor so the frontend can be built and tested without calling Claude.

**Architecture:** Small additions to the existing modules. The study routes' lock becomes a map of `AbortController`s so Stop can cancel a turn. `StreamMessage` gains an optional `{ onStatus, signal }` argument. `src/server/tutor/fake.ts` supplies every Claude seam (`streamMessage`, `summarize`, `htmlToMarkdown`, `checkKey`) with a deterministic script, switched on by `--fake`.

**Tech Stack:** TypeScript, Fastify, `node:sqlite`, `@anthropic-ai/sdk` 1.3.0 (`BetaMessageStream`: `on('streamEvent')`, `abort` via `signal`, `currentMessage`; `models.list`), Vitest.

**Spec:** [docs/superpowers/specs/2026-10-25-frontend-design.md](../specs/2026-10-25-frontend-design.md), section "Backend changes this design needs" (items 1–12) and "Process" (fake tutor)

## Global Constraints

- **Append-only history still holds.** Stop appends the text streamed so far as a new assistant message; Open appends an `[App: …]` note; nothing earlier is edited.
- **`tools` is one fixed list:** `[ask_user_question, quiz, propose_graph, focus_node, set_node_state, set_goal_title]` + `{ type: 'web_search_20260209', name: 'web_search' }` (no `max_uses`). The schema changes (drop `quiz_items.hint` and `studies.search_cap`, add `studies.title`) need a fresh dev database; there are no migrations.
- **One turn per study**, now `running: Map<studyId, AbortController>`. `messages`, `tool-results`, `retry`, `open`, and goal deletion all answer 409 `The tutor is still replying.` while a turn runs.
- **Every turn response ends with exactly one `done`**, including stopped turns.
- **No live Claude calls** in tests or in `--fake` mode.
- Commits carry no Claude attribution.

## Rulings

- **Stop keeps only streamed text.** The cut-off step's thinking and tool blocks are dropped; a text-only assistant turn is an append, and requests already set `drop_block`. Cost if wrong: the next turn 400s on that thread; then save nothing on stop instead.
- **Usage of a stopped call** is recorded from `stream.currentMessage.usage` when the stream reached `message_start` (input and cache tokens are known; output is partial).
- **Stop is idempotent:** 204 whether or not a turn is running.
- **No "stalled thread" flag.** The server can't tell a failed thread from one left on purpose by `focus_node` (both end on a user message), so Retry is offered only by the live page (spec revised).
- **Retry** needs the thread's last stored message to be a user message (text, `tool_result`, or app note) and no pending card; otherwise 409 `Nothing to retry.`
- **Open** answers 204 without a turn when the node's thread already has messages; 409 `Node threads open once the plan is approved.` in probe/plan.
- **`--fake` flag, not an env var**, so the npm script works in Windows shells. Fake mode uses `data/maptutor-fake.db` unless `DB_PATH` is set.
- **The fake tutor ignores the goal** and always teaches one small calculus graph, choosing each reply from the request's last message and newest `<study_state>`.

## Rulings made during the build

- **Tests that passed early (Task 1):** with the hint and cap assertions removed, `quiz.test` and `usage.test` passed before the change. Added a stray-hint assertion to the card test so it failed first. Cost if wrong: none.
- **Allowed tools in probe (Task 2):** `loop.test`'s "Tools allowed now" line gained `set_goal_title`. Cost if wrong: none.
- **Goal deletion drops its usage (Task 2):** `usage.study_id` cascades, so project totals fall when a goal is deleted. Kept the schema from 04. Cost if wrong: project usage under-reports spend; fix with `ON DELETE SET NULL`.
- **Stop keeps text-only (Task 3):** the claude-api docs confirm stripped thinking (text and tool_use kept) is an accepted history, and consecutive user turns merge. Cost if wrong: as in the plan's ruling.
- **Stopped text comes from the deltas (Task 3):** `runTurn` saves what `onText` streamed, so it works whether the stream rejects (fake) or resolves partial (SDK). A step that completed as Stop fired is processed normally; the loop-top check prevents the next call. Cost if wrong: none seen.
- **Open checks history before the lock (Task 3):** opening a node with history mid-turn is a harmless 204, not a 409. Cost if wrong: none; it starts nothing.
- **Extra fake tests (Task 4):** a wrong check repeats the question; chunked streaming and Stop rejection. Cost if wrong: none.
- **Fake pacing (Task 4):** `set_goal_title` step has no text; dev delay 1200 ms thinking, chunks every 300 ms. Cost if wrong: one number in `main.ts`.

**Review:** self-review (HANDOFF convention), no Critical or Important findings. Minors, deferred:
- Deleting a project mid-turn isn't locked; the turn then fails on a foreign key and only logs.
- Summaries for a goal deleted right after its turn fail and only log.

## Review Focus

1. **Stop between steps** (after a server tool ran, before the next model call): no further model call, one `done`. Test in Task 3.
2. **Stop before any text:** no assistant row is stored, and the next message still works (two user turns in a row are merged by the API). Test in Task 3.
3. **Retry, Open, or a message racing a running turn:** 409, never a second turn. Test in Task 3.
4. **Deleting a goal mid-turn:** 409, nothing deleted. Test in Task 2.
5. **Plan feedback in the fake flow** re-proposes, replaces the graph, and still reaches `done`. Test in Task 4.

---

### Task 1: Drop hints and the search cap; files-first and teach-inline rules

**Files:**
- Modify: `src/server/tutor/quiz.ts` (type, check, schema, card, insert), `src/server/core/db.ts` (drop `quiz_items.hint`, `studies.search_cap`), `src/server/core/config.ts` (drop `WEB_SEARCH_MAX_USES`), `src/server/tutor/context.ts` (no `max_uses`), `src/server/routes/projects.ts` and `src/server/routes/studies.ts` (no `searchCap`), `src/server/tutor/plan.ts` (label description), `prompts/app-appendix.md`, `02-agent.md`, `04-data-model.md`, `05-stack.md`, `ROADMAP.md` (the `quiz_items.hint` decision line)
- Test: `src/server/tutor/quiz.test.ts`, `src/server/core/db.test.ts`, `src/server/tutor/context.test.ts`, `src/server/core/usage.test.ts`

**Interfaces:**
- Produces: quiz card items `{ id, prompt, options }`, plus `correctOptionId` and `explanation` once answered. Study and project payloads have no `searchCap`; `POST …/studies` takes `{ goal }`. The web search tool is exactly `{ type: 'web_search_20260209', name: 'web_search' }`.

- [ ] **Step 1: Update the tests**

```ts
// quiz.test.ts: QUIZ items carry no hint; the card is { id: 'q1', prompt: 'Question q1', options } and the
// quiz_items SELECT drops `hint`.
// db.test.ts
test('creates every table without quiz_items.hint or studies.search_cap', () => { /* PRAGMA table_info: not.toContain('hint'), not.toContain('search_cap') */ })
// context.test.ts
expect(req.tools?.at(-1)).toEqual({ type: 'web_search_20260209', name: 'web_search' })
// usage.test.ts: delete 'the search cap is set per study at creation and sent as max_uses'; the raw studies INSERT drops search_cap.
```

- [ ] **Step 2: Run `npm test`.** Expected: the four files fail.
- [ ] **Step 3: Remove hints and the cap** everywhere listed under Files. `plan.ts` node `label` description becomes `'About 3 words; it sits inside a small circle on the map.'`
- [ ] **Step 4: Add the two prompt rules** to `## Rules of the app` in `prompts/app-appendix.md`, verbatim from the spec's item 9: the files-first paragraph, and "When teaching needs a new foundational fact that has no node, teach it inline in the current node's thread (motivate, establish, connect, quiz-check there). Nodes can't be added after approval."
- [ ] **Step 5: Run `npm test` and `npm run typecheck`.** Expected: all pass, typecheck clean.
- [ ] **Step 6: Update `02-agent.md`, `04-data-model.md`, `05-stack.md`, `ROADMAP.md`** (no hint, uncapped search, the two rules), then commit `feat: drop quiz hints and the search cap`.

### Task 2: Goal titles, project renaming and counts, goal deletion

**Files:**
- Modify: `src/server/core/db.ts` (`studies.title TEXT`), `src/server/tutor/tools.ts` (`set_goal_title`, appended to `TOOLS`), `src/server/routes/projects.ts` (counts, `PATCH`, `title` in the studies list), `src/server/routes/studies.ts` (`title` in `GET`, `DELETE`), `prompts/app-appendix.md` (goal-title rule), `02-agent.md`, `04-data-model.md`
- Test: `src/server/routes/projects.test.ts`, `src/server/routes/studies.test.ts`

**Interfaces:**
- `set_goal_title({ title })`, server tool, phases `['probe', 'plan']`. Stores the trimmed title. Error: `set_goal_title needs a title of 1–80 characters.` Success: `Goal title set to "<title>".`
- `GET /api/projects` → `[{ id, name, createdAt, goalCount, fileCount }]`.
- `PATCH /api/projects/:id { name }` → 200 `{ id, name, createdAt }`; blank → 400 `Name can't be blank.`; unknown → 404.
- `DELETE /api/studies/:id` → 204; unknown → 404; while a turn runs → 409 `The tutor is still replying.`
- `title: string | null` on `GET /api/studies/:id` and on each study in `GET /api/projects/:id`.

- [ ] **Step 1: Write the failing tests**

```ts
test('lists projects with goal and file counts')                          // 2 studies + 1 file → { goalCount: 2, fileCount: 1 }
test('renames a project; a blank name is a 400 and an unknown project a 404')
test('set_goal_title stores a short title that the study endpoints return') // scripted tool_use then text; GET study and project → title
test('set_goal_title rejects a blank or over-80-character title')          // the tool_result is_error with the message above
test('deleting a goal removes it and its threads; mid-turn it is a 409')   // Review Focus 4
```

- [ ] **Step 2: Run `npm test`.** Expected: the five tests fail.
- [ ] **Step 3: Implement** the column, tool, routes, and fields above. Counts come from correlated subqueries in the list query. `DELETE` takes the study lock for its check, so it can't race a turn.
- [ ] **Step 4: Add the goal-title rule** to the appendix: "Once the goal is concrete, call `set_goal_title` with a short title of about 2–6 words. The app shows it as the goal's name."
- [ ] **Step 5: Run `npm test` and `npm run typecheck`.** Expected: all pass.
- [ ] **Step 6: Update `02-agent.md` (tool) and `04-data-model.md` (column), then commit** `feat: goal titles, project renaming and counts, goal deletion`.

### Task 3: Turn control: status events, Stop, Retry, Open

**Files:**
- Modify: `src/server/core/anthropic.ts` (`streamMessage`, `statusOf`), `src/server/tutor/loop.ts` (`StreamMessage`, `Emit`, `runTurn`), `src/server/routes/studies.ts` (lock map, three routes), `prompts/app-appendix.md` (opened-node rule), `02-agent.md`, `HANDOFF.md` (API table)
- Test: `src/server/tutor/loop.test.ts`, `src/server/routes/studies.test.ts`, `src/server/core/anthropic.test.ts` (new)

**Interfaces:**
- `type Status = 'thinking' | 'searching'`
- `type StreamMessage = (params, apiKey: string, onText: (delta: string) => void, opts?: { onStatus?: (kind: Status) => void; signal?: AbortSignal }) => Promise<Anthropic.Beta.BetaMessage>`. When `signal` aborts, it resolves with the partial message if the stream reached `message_start`, else rejects.
- `statusOf(event: BetaMessageStreamEvent): Status | null` (the event type `streamEvent` passes) (in `anthropic.ts`): `content_block_start` of a `thinking` block → `'thinking'`; of a `server_tool_use` named `web_search` → `'searching'`; anything else → `null`. The real `streamMessage` passes `{ signal }` as the request option and wires `stream.on('streamEvent', e => …onStatus)`.
- `Emit` adds `status { kind }`. `runTurn` takes `signal?: AbortSignal`. When aborted, it stores the step's streamed text (if any) as `[{ type: 'text', text }]`, records any usage, makes no further model call, and emits `done { awaiting: false }`.
- `POST /api/studies/:id/stop` → 204 (aborts the running turn, if any); unknown study → 404.
- `POST /api/studies/:id/retry { nodeId? }` (key header) → SSE turn; 409 `Nothing to retry.` (see Rulings).
- `POST /api/studies/:id/open { nodeId }` (key header) → SSE turn after setting `focus_node_id` and appending `[App: The user opened "<label>". Teach it now.]` plus the state block; 204 if the thread has messages; 404 unknown node; 409 before approval.

- [ ] **Step 1: Write the failing tests**

```ts
// anthropic.test.ts
test('statusOf maps thinking and web search block starts')
// loop.test.ts
test('status events from the stream reach the client')
test('a stop mid-stream keeps the streamed text and ends with one done')
test('a stop before any text stores nothing and the next message still works')   // Review Focus 2
test('a stop between steps makes no further model call')                         // Review Focus 1
// studies.test.ts
test('stop is a 204 whether or not a turn is running')
test('retry re-runs a failed turn without a new user message; otherwise it is a 409')
test('open starts the lesson in an empty node thread; with history it is a 204; before approval a 409')
test('retry, open, and messages are 409 while a turn runs')                       // Review Focus 3
```

- [ ] **Step 2: Run `npm test`.** Expected: the new tests fail.
- [ ] **Step 3: Implement** `statusOf`, the `streamMessage` options, the `runTurn` abort path, the lock map, and the three routes. Retry and Open reuse `streamTurn`; Stop calls `running.get(id)?.abort()`.
- [ ] **Step 4: Add the opened-node rule** to the appendix: "A turn that starts with an app note saying the user opened a node is a request to teach that node now, from its beginning."
- [ ] **Step 5: Run `npm test` and `npm run typecheck`.** Expected: all pass.
- [ ] **Step 6: Update `02-agent.md` (status, stop, retry, open) and the HANDOFF API table, then commit** `feat: status events, stop, retry, and opening a node`.

### Task 4: Key check and the fake tutor

**Files:**
- Create: `src/server/tutor/fake.ts`
- Modify: `src/server/core/anthropic.ts` (`checkKey`), `src/server/app.ts` (`checkKey` seam, route), `src/server/main.ts` (`--fake`), `package.json` (`dev:fake`), `HANDOFF.md` (how to run), `ROADMAP.md` (row 7b)
- Test: `src/server/tutor/fake.test.ts`, `src/server/app.test.ts`

**Interfaces:**
- `type CheckKey = (key: string) => Promise<void>`. The real one is `await clientFor(key).models.list({ limit: 1 })`; a rejection flows through `anthropicError`.
- `POST /api/key/check` (key header) → 204 when accepted; 401 `Your Anthropic API key was rejected.` otherwise; no header → 401 as today.
- `buildApp` options add `checkKey?: CheckKey`.
- `fakeTutor(opts: { delayMs: number }): { streamMessage: StreamMessage; summarize: Summarize; htmlToMarkdown: HtmlToMarkdown; checkKey: CheckKey }`
  - `checkKey` accepts keys starting with `sk-ant-` and throws `httpError(401, 'Your Anthropic API key was rejected.')` otherwise.
  - `summarize` returns `Fake summary: <first line of the transcript>`. `htmlToMarkdown` strips tags.
  - `streamMessage` calls `onStatus('thinking')`, waits `delayMs`, then streams its text in chunks of about four words, `delayMs / 4` apart. It honours `signal` by rejecting. Usage is all zeros; `model` is `fake-tutor`.
- `npm run dev:fake` = `tsx watch src/server/main.ts --fake`; the server logs `Fake tutor: no Claude calls are made.`

**The script** (reply chosen from the last message of the request and its newest `<study_state>`):

| Last message | Reply |
|---|---|
| User text, phase probe, no `ask_user_question` yet in the thread | Text + `ask_user_question` "What do you want to be able to do by the end?" with options "Pass the midterm next week" ("Limits through the chain rule, exam-style problems"), "Really understand derivatives" ("Slower, from first principles"), "Catch up on what I missed" |
| `tool_result` for `ask_user_question` | `set_goal_title { title: 'Ace the calculus midterm' }` |
| `tool_result` for `set_goal_title` | `onStatus('searching')`, then text + a probe `quiz`: 3 items with strands `functions`, `limits`, `derivatives`; options `a`–`d`, correct `b` |
| `tool_result` for `quiz`, phase probe or plan | Text + `propose_graph`: roots `functions` (Functions) and `limits` (Limits); `slope` (Slope) after both; `derivative` (Derivative) after `slope`; goal `chain` (Chain rule) after `derivative`; strands from the probe; a short approach |
| `tool_result` for `propose_graph`, phase plan | Text "Revised." + the same `propose_graph` with an approach that quotes the feedback |
| `tool_result` for `propose_graph`, phase teach | Text + `focus_node` on the state's `Next node` |
| `[App: …]` note in a node thread | A short Markdown lesson with inline and display LaTeX + a one-item `quiz` with `nodeId` = this thread's node, correct `b` |
| `tool_result` for `quiz`, phase teach, all correct, `Next node` not `none` | Text + `focus_node` on `Next node` |
| `tool_result` for `quiz`, phase done | Text "That's the goal. Nicely done." |
| `tool_result` for `quiz`, any wrong | Text explaining + the same one-item `quiz` again |
| Anything else | Text `You said: <their text>` (or a generic line) |

- [ ] **Step 1: Write the failing tests**

```ts
// fake.test.ts (delayMs: 0, through buildApp + inject)
test('the fake tutor walks a goal from question to done')
// answers the probe with derivatives wrong, sends plan feedback once (Review Focus 5), approves, passes each
// quiz-check; expects title 'Ace the calculus midterm', phase 'done', every node known, and one status 'searching'.
test('the fake key check accepts sk-ant- keys only')
// app.test.ts
test('key check is a 204 for an accepted key and a 401 for a rejected one')   // injected checkKey
```

- [ ] **Step 2: Run `npm test`.** Expected: the new tests fail.
- [ ] **Step 3: Implement** `checkKey`, the route and seam, `fake.ts`, `main.ts`, and the script.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: all pass.
- [ ] **Step 5: Smoke-run** `npm run dev:fake`, then `curl -s -X POST localhost:3001/api/key/check -H "x-anthropic-key: sk-ant-x" -o /dev/null -w "%{http_code}"`. Expected: `204`. Stop the server (see HANDOFF for the Windows port note).
- [ ] **Step 6: Update `HANDOFF.md` (how to run `dev:fake`) and `ROADMAP.md` (component 7b, done), then commit** `feat: key check and a scripted fake tutor`.

## Not in this component

The frontend itself (components 8–11), and live calls against Claude (the user does the first live run later).

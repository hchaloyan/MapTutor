# Handoff: MapTutor backend, after component 4

You're picking up a build in progress. Read this file first, then [ROADMAP.md](ROADMAP.md), then the design docs (`README.md`, `01`–`05`). The design docs are the spec; this file covers what was built, what was decided along the way, and what comes next.

## Where things stand

- **Branch:** `backend`. Not merged to `main`, and there's no remote. All work is committed.
- **Done:** backend components 0–4 (server skeleton, projects & files API, graph engine, agent loop, probe/quiz). 96 tests pass, and `npm run typecheck` is clean.
- **Next:** component 5 (Plan), then 6 (Teach), then 7 (Usage). After that comes the frontend, 8–11.
- **Build order (the user's choice):** all backend first, then all frontend. There's no terminal chat client; the user is fine waiting until the frontend to talk to the tutor.
- **Mode:** the user asked to keep building and reviewing my own work until a real blocker. Don't stop to ask between components; stop only for the open questions below, or anything destructive or outward-facing.

## How to run

```bash
npm test            # vitest, all server tests
npm run typecheck   # tsc --noEmit (TypeScript 7)
npm run dev:server  # tsx watch, Fastify on 127.0.0.1:3001, DB at data/maptutor.db
```

- **Startup warning:** `ExperimentalWarning: SQLite …` is expected.
- **Leftover server on Windows:** the `tsx watch` child can outlive a killed `npm`. Free the port with `netstat -ano | grep :3001` and `taskkill //PID <pid> //T //F`.
- **No migrations:** after any schema change, delete `data/maptutor.db`.
- **No API key in this environment:** `ANTHROPIC_API_KEY` is unset and the `ant` CLI isn't installed. Every Claude call is behind an injectable seam (`htmlToMarkdown`, `streamMessage`), so tests use fakes. The real SDK path was checked once with a bogus key and returned the expected 401 → SSE error. **A successful live call has never run.** Do one when a key exists.

## Code map (`src/server/`)

Layout: `core/` is infrastructure (config, DB, HTTP errors, Claude client), `routes/` holds the Fastify route modules, and `tutor/` is the agent (prompt, context, tool loop, tools, graph engine). Tests sit next to the module they cover.

| File | Responsibility |
|---|---|
| `core/db.ts` | Schema (from 04-data-model, plus changes below), `openDb`, `LOCAL_USER_ID = 'local'`, `requireProject` |
| `app.ts` | `buildApp({ db, logStream?, htmlToMarkdown?, streamMessage? })`, error handler, route registration |
| `main.ts` | Entry point |
| `core/config.ts` | Model IDs (`claude-opus-5-5` tutor, `claude-haiku-5-5` side calls), size limits, `WEB_SEARCH_MAX_USES` |
| `core/http.ts` | `httpError(status, message)` |
| `core/anthropic.ts` | BYOK `apiKey(req)`, `clientFor(key)`, real `streamMessage`, `htmlToMarkdown`, `anthropicError` mapping |
| `routes/projects.ts` | Projects + studies CRUD, mastery counts |
| `routes/files.ts` | Uploads, URL import/refresh, file serving, size checks |
| `tutor/graph.ts` | Pure: `validateGraph`, `depths`, `initialState`, `afterQuizCheck`, `checkSetState`, `weakAncestors`, `nextNode` |
| `tutor/prompt.ts` | `systemPrompt()`: `prompts/teaching-skill.md` (frontmatter stripped) + `prompts/app-appendix.md` |
| `tutor/context.ts` | `buildRequest`, `fileBlocks`, `studyStateText`, `threadMessages` |
| `tutor/tools.ts` | Tool registry (`ClientTool` / `ServerTool`), `ask_user_question`, `allowedTools(phase)` |
| `tutor/quiz.ts` | `quiz` client tool (server grading), `probeStrands` |
| `tutor/loop.ts` | `runTurn` loop, `appendUserMessage`, `pendingCard`, `clearPending` |
| `routes/studies.ts` | Study routes and SSE: `GET /api/studies/:id`, `GET …/thread`, `POST …/messages`, `POST …/tool-results` |

Plans for each component are in `docs/superpowers/plans/`. Follow the same format for new ones.

## Decisions you must not undo

**Append-only history (the big one).** Opus 5.5 rejects a replayed thinking block if the `system` prompt, the `tools` array, or any earlier message changed since that block was made (enforced on accounts created on or after 2026-08-31). Everything in the agent loop follows from this:
- **Frozen system prompt.** `system` never carries state.
- **Full tool list, always.** `tools` is the whole set in a fixed order. The phase is enforced on the server: a tool the phase doesn't allow gets an error `tool_result`. **Never change `tools` between requests in a study.** That includes `max_uses` on web search, so the per-user search cap in component 7 must be fixed per study, e.g. a `studies.search_cap` column set at creation.
- **State on each new message.** Study state is a `<study_state>` text block appended to every user message the server sends, stored with it, and never rewritten. `studyStateText` is where components 5–6 add graph, summary, and weak-prerequisite lines.
- **`cache_control` only at request time.** Markers are added when the request is built and never stored.
- **`drop_block`.** Requests set `thinking.block_binding.prefix_mismatch_behavior: 'drop_block'`, because changing project files mid-study is the one unavoidable prefix change.

**Request parameters:**
- `effort: 'high'`, `max_tokens: 64000`
- `tool_choice: { type: 'auto', disable_parallel_tool_use: true }`: at most one tool per assistant message, so a pause never leaves half-finished sibling results
- Cache TTL `1h` on all three breakpoints (system, last file block, last message)
- `fallbacks: 'default'` with beta `server-side-fallback-2026-07-01`, since Opus 5.5's bio/cyber classifiers can misfire on biology or security study topics. **Tell the user this is on.**

**Other decisions:**
- **Database:** `node:sqlite` (Node 24 built-in), not better-sqlite3. File bytes are stored in SQLite (`files.data BLOB`, which replaced `storage_key`), so a project delete cascades.
- **Grading:** on the server only. Quiz cards hide `correctOptionId`, `explanation`, `strand`, and `nodeId` until the user answers. `quiz_items` rows are written at answer time, with id `<toolUseId>:<itemId>`.
- **Probe → Plan:** the server switches the phase when the tutor first makes a valid `propose_graph` call.
- **Tool names follow the teaching skill:** `ask_goal` became `ask_user_question`, allowed in every phase. Web search is on in every phase.
- **Graph validation** also enforces "goal is the single sink". `set_node_state → untested` is rejected. The prerequisite banner's "deepest weak ancestor" means the most foundational one (shallowest depth), which is `weakAncestors(...)[0]`.

## Next: component 5 (Plan)

Design worked out but not built:

1. **Schema change: node IDs are per-study.**
   - **Problem:** `nodes.id` is a global primary key, but the tutor picks short IDs (`limits`, `r1`) that will collide across studies.
   - **Fix:** `nodes PRIMARY KEY (study_id, id)`.
   - **Edges:** `PRIMARY KEY (study_id, from_node, to_node)`, with composite FKs `(study_id, from_node)` and `(study_id, to_node)` → `nodes(study_id, id) ON DELETE CASCADE`.
   - **`messages.node_id` and `quiz_items.node_id`:** composite FK `(study_id, node_id)` → `nodes(study_id, id) ON DELETE CASCADE`. A NULL `node_id` skips the check. Don't use SET NULL: it would also null `study_id`, which is NOT NULL.
   - **Keep `04-data-model.md` in sync.** Existing queries already filter `WHERE id = ? AND study_id = ?`.
2. **`onPause?(input, ctx)` hook on `ClientTool`.** `runTurn` calls it just before emitting the card. `check()` stays pure.
3. **`propose_graph` client tool** (phases `probe` and `plan`):
   - **`check`:** a non-empty `approach` plus `validateGraph(nodes, edges, probeStrands names)`, with the errors joined by `\n`.
   - **`onPause`:** set phase `plan`, then delete and reinsert the study's nodes and edges (safe, since no node threads exist yet). States come from `initialState` over the probe items; `ever_known` is 1 when the state starts `known`.
   - **`card`:** `{ approach }`. The graph renders from `GET /api/studies/:id`.
   - **`answer`:** `{ decision: 'approved' }` sets phase `teach` and stores `studies.approach`. `{ decision: 'feedback', text }` needs non-empty text and leaves the phase alone. The content is that JSON.
4. **`GET /api/studies/:id`** returns real `nodes` (`{ id, label, kind, description, strands, state, summary, evidence: { correct, total } }`) and `edges`.
   - **Evidence:** the probe items whose strand is in `node.strands`, plus check items with that `node_id`. Derived at read time, per 04.
5. **`studyStateText` graph lines**, once a graph exists: one line per node (`id [kind] "label" — state (correct/total); prerequisites: …`) and `Next node: <nextNode>`.

## Then: component 6 (Teach)

- **`focus_node` server tool** (teach and done). It sets a new `studies.focus_node_id` column, then hands the turn to the node's thread:
  - **Current thread:** the tool result goes there, as usual.
  - **Switch:** `runTurn` emits `focus { nodeId }` and appends a user message in the node's thread, such as `[The app opened this node's thread. Begin the lesson for <label>.]` plus the state block.
  - **Continue:** the loop then runs in the node's thread. A thread that ends on a `tool_result` user message is fine, because the API merges consecutive user messages.
- **Quiz-check transitions:** in `quizTool.answer` during teach/done, group the items by `nodeId`. Each node passes only if all its items in that call were correct, and `afterQuizCheck` gives the new state. Set `ever_known` when a node reaches `known`. When the goal becomes `known`, set phase `done`.
- **`set_node_state` server tool:** `checkSetState`, where `checks` are this node's check-item quiz calls grouped by `quiz_call_id` (`passed` = all correct; `at` = `answered_at`).
- **Summaries:** at the end of every turn (in the SSE `finally`, before release), generate summaries for nodes with `ever_known = 1 AND summary IS NULL` with one Haiku side call each, using the node's thread text. This catches both quiz-check passes and `set_node_state`.
- **Weak prerequisites:**
  - **Node threads:** their state block lists `weakAncestors`, so the tutor can adapt.
  - **Banner endpoint:** add `GET /api/studies/:id/nodes/:nodeId/prerequisites` → `{ weak: [{ id, state }] }`. The UI's "Go to" target is `weak[0]`.
- **Opening a node:** the UI opens an empty node thread by posting a normal message with `nodeId`.

## Then: component 7 (Usage)

- **Usage table:** a `usage` table recording `response.usage` per model call: input, output, cache read, cache write, web searches. Include side calls.
- **Totals:** shown per study on the study and project endpoints.
- **Search cap:** set per study at creation (see the `max_uses` warning above).

## Open questions for the user (ask when you reach them)

1. **New nodes during Teach** (before component 6): the teaching skill says a new foundational fact needed mid-lesson gets its own loop, but nothing can add a node after approval. The options are an `add_node` tool with validation, or teaching it inline without a node.
2. **Visual design** (before component 8): the repo has a Material 3 skill installed (`.agents/skills/material-3`). Ask whether they want that look.
3. **A real API key** for the first live run.

## Deferred minor issues

- **URL import can reach localhost or private addresses (SSRF).** Fine while local-only; block those ranges before any hosting.
- **HTML → Markdown conversion is paid for before the size check** that can reject the result.
- **No SSE keep-alive pings during long silent thinking.** Add `: ping` every 15s if a proxy drops idle streams.
- **The `data/` path is relative to the working directory.** Run the server from the repo root.

## Working conventions

- **TDD per task:** write the test, watch it fail, implement, watch it pass, then run `npm test` and `npm run typecheck`, then commit.
- **Plans:** one per component in `docs/superpowers/plans/`. Record each deviation from a plan as a "Ruling" (what, why, cost if wrong).
- **Review:** self-review each component against its plan's Review Focus. Fix Critical and Important findings test-first, and list minor ones.
- **Commits:** no `Co-Authored-By` trailer or other Claude attribution (the user's rule).
- **Untracked files:** `.claude/`, `.agents/`, and `skills-lock.json` belong to the user. Leave them uncommitted.
- **Windows/Git Bash quirks:** CRLF warnings on `git add` are harmless. Very long bash heredocs containing backticks have failed to parse; use the Write tool for whole files instead.
- **Claude API:** load the `claude-api` skill before writing new API code. The beta stream params type is imported from `@anthropic-ai/sdk/resources/beta/messages/messages` (`BetaMessageStreamParams`).

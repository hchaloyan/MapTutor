# Handoff: MapTutor backend, after component 7

You're picking up a build in progress. Read this file first, then [ROADMAP.md](ROADMAP.md), then the design docs (`README.md`, `01`–`05`). The design docs are the spec; this file covers what was built, what was decided along the way, and what comes next.

## Where things stand

- **Branch:** `backend`. Not merged to `main`, and there's no remote. All work is committed.
- **Done:** backend components 0–7 (server skeleton, projects & files API, graph engine, agent loop, probe/quiz, plan, teach, usage). 122 tests pass, and `npm run typecheck` is clean.
- **Not done in the backend:** new nodes during Teach (open question 1 below).
- **Next:** the frontend, components 8–11. Ask open question 2 (visual design) before starting.
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
- **No migrations:** after any schema change, the dev database has to go. Deleting it was blocked by the permission classifier this session, so the old one was moved to `data/maptutor.pre-component-5.db.bak` (the earlier smoke-test project only). The current `data/maptutor.db` holds one smoke-test project from this session. Both can be deleted.
- **No API key in this environment:** `ANTHROPIC_API_KEY` is unset and the `ant` CLI isn't installed. Every Claude call is behind an injectable seam (`htmlToMarkdown`, `streamMessage`, `summarize`), so tests use fakes. The real SDK path was checked with a bogus key and returned the expected 401 → SSE error. **A successful live call has never run**, including the Haiku summary call. Do one when a key exists.

## Code map (`src/server/`)

Layout: `core/` is infrastructure (config, DB, HTTP errors, Claude client, usage), `routes/` holds the Fastify route modules, and `tutor/` is the agent (prompt, context, tool loop, tools, graph engine). Tests sit next to the module they cover.

| File | Responsibility |
|---|---|
| `core/db.ts` | Schema (04-data-model, kept in sync), `openDb`, `transaction`, `LOCAL_USER_ID = 'local'`, `requireProject` |
| `core/config.ts` | Model IDs (`claude-opus-5-5` tutor, `claude-haiku-5-5` side calls), size limits, default `WEB_SEARCH_MAX_USES` |
| `core/http.ts` | `httpError(status, message)` |
| `core/anthropic.ts` | BYOK `apiKey(req)`, `clientFor(key)`, real `streamMessage`, `htmlToMarkdown`, `summarize`, `anthropicError` mapping |
| `core/usage.ts` | `recordUsage`, `usageByModel` |
| `app.ts` | `buildApp({ db, logStream?, htmlToMarkdown?, streamMessage?, summarize? })`, error handler, route registration |
| `main.ts` | Entry point |
| `routes/projects.ts` | Projects + studies CRUD, mastery counts, usage totals, `searchCap` |
| `routes/files.ts` | Uploads, URL import/refresh, file serving, size checks |
| `routes/studies.ts` | Study, thread, prerequisites, messages and tool-results (SSE), per-study lock, summaries after each turn |
| `tutor/graph.ts` | Pure: `validateGraph`, `depths`, `initialState`, `afterQuizCheck`, `checkSetState`, `weakAncestors`, `nextNode` |
| `tutor/prompt.ts` | `systemPrompt()`: `prompts/teaching-skill.md` (frontmatter stripped) + `prompts/app-appendix.md` |
| `tutor/context.ts` | `buildRequest`, `fileBlocks`, `studyStateText`, `threadMessages`, `isAppText` |
| `tutor/tools.ts` | Tool registry (`ClientTool` / `ServerTool`), `ask_user_question`, `allowedTools(phase)` |
| `tutor/quiz.ts` | `quiz` client tool (server grading, quiz-check transitions), `probeStrands` |
| `tutor/plan.ts` | `propose_graph` client tool, `loadGraph` (nodes with derived evidence) |
| `tutor/teach.ts` | `focus_node` and `set_node_state` server tools, `setNodeState`, `summarizeNew` |
| `tutor/loop.ts` | `runTurn` loop (thread switching, usage), `appendUserMessage`, `pendingCard`, `clearPending` |

Plans for each component are in `docs/superpowers/plans/`, each with its rulings. Follow the same format for new ones.

## API for the frontend

All JSON. Turn routes need the `x-anthropic-key` header and answer with SSE.

| Route | What it returns or does |
|---|---|
| `GET/POST /api/projects`, `GET/DELETE /api/projects/:id` | Project with `files`, `studies` (each with `counts` per state, `searchCap`, `usage`), and project-wide `usage` |
| `POST /api/projects/:id/files?name=…` (octet-stream), `POST /api/projects/:id/urls`, `POST /api/files/:id/refresh`, `GET /api/files/:id/content`, `DELETE /api/files/:id` | Context files |
| `POST /api/projects/:id/studies` `{ goal, searchCap? }` | `searchCap` is 1–10, default 3, fixed for the study |
| `GET /api/studies/:id` | `goal, phase, approach, focusNodeId, searchCap, nodes, edges, strands, usage`. Nodes: `{ id, label, kind, description, strands, state, everKnown, summary, evidence: { correct, total } }` |
| `GET /api/studies/:id/thread?nodeId=` | Thread items: `user`/`assistant` text and `card`s (`toolUseId, name, input, answer, pending`) |
| `GET /api/studies/:id/nodes/:nodeId/prerequisites` | `{ weak: [{ id, state }] }`; the banner's "Go to" target is `weak[0]` |
| `POST /api/studies/:id/messages` `{ text, nodeId? }` | Starts a turn. Posting to a node thread focuses that node. 409 if a turn is running in the study, a card is pending in that thread, or the study is still in probe/plan and `nodeId` is set |
| `POST /api/studies/:id/tool-results` `{ toolUseId, answer }` | Answers a card and resumes. Answers: `ask_user_question` `{ answers: string[] }`, `quiz` `{ choices: { [itemId]: optionId } }`, `propose_graph` `{ decision: 'approved' }` or `{ decision: 'feedback', text }` |

SSE events: `text { delta }`, `card { toolUseId, name, input }`, `focus { nodeId }` (the rest of the turn streams into that node's thread, so switch the chat to it), `error { message }`, `done { awaiting }`. Every response ends with exactly one `done`. Refetch the study after `done` to pick up phase, states, and the graph. The response stays open a few seconds after `done` while summaries are written; the client can stop reading at `done`.

## Decisions you must not undo

**Append-only history (the big one).** Opus 5.5 rejects a replayed thinking block if the `system` prompt, the `tools` array, or any earlier message changed since that block was made (enforced on accounts created on or after 2026-08-31). Everything in the agent loop follows from this:
- **Frozen system prompt.** `system` never carries state. (Editing `prompts/` changes it for existing studies; fine in development only.)
- **Full tool list, always.** `tools` is the whole set in a fixed order, and web search's `max_uses` is the study's `search_cap`, fixed at creation. The phase is enforced on the server: a tool the phase doesn't allow gets an error `tool_result`.
- **State on each new message.** Study state is a `<study_state>` text block appended to every user message the server sends, stored with it, and never rewritten. It carries the goal, phase, thread, allowed tools, strands (probe/plan), the graph with states and evidence and `Next node`, summaries (teach/done), and in node threads the node's description, weak prerequisites, and the approach.
- **Thread switches append, never edit.** `focus_node` appends its `tool_result` in the old thread and an `[App: …]` note plus state in the node's thread. App notes and state blocks are hidden from the thread view by their prefixes.
- **`cache_control` only at request time.** Markers are added when the request is built and never stored.
- **`drop_block`.** Requests set `thinking.block_binding.prefix_mismatch_behavior: 'drop_block'`, because changing project files mid-study is the one unavoidable prefix change.

**Request parameters:**
- `effort: 'high'`, `max_tokens: 64000`
- `tool_choice: { type: 'auto', disable_parallel_tool_use: true }`
- Cache TTL `1h` on all three breakpoints (system, last file block, last message)
- `fallbacks: 'default'` with beta `server-side-fallback-2026-07-01`, since Opus 5.5's bio/cyber classifiers can misfire on biology or security study topics. **Tell the user this is on.**
- Summary side call: Haiku 5.5, non-streaming, `max_tokens: 16000`, `effort: 'low'` (Haiku 5.5 defaults to `medium`).

**Other decisions:**
- **Database:** `node:sqlite` (Node 24 built-in). File bytes are stored in SQLite.
- **Node IDs are per-study:** `nodes PRIMARY KEY (study_id, id)`; edges, messages, and quiz items use composite foreign keys with `ON DELETE CASCADE`.
- **Node threads open only after approval** (409 before), which is what makes replacing the graph on re-proposal safe.
- **One turn per study** (in-memory lock), because a turn can move between threads.
- **Grading:** on the server only. Quiz cards hide `correctOptionId`, `explanation`, `strand`, and `nodeId` until the user answers.
- **States:** initial states are computed when `propose_graph` pauses (`onPause`, which runs before the card is stored). Quiz-checks group items by node within a call. `done` is set when the goal becomes known and is never undone.
- **Summaries** run after each turn, after the lock is released, for nodes that were known, have no summary, and have thread text. Failures are logged and retried next turn.
- **Usage:** one row per model call (tutor steps, summaries, URL imports), totaled per model. URL imports count for the project only.
- **Graph validation** enforces "goal is the single sink". `set_node_state → untested` is rejected.

## Open questions for the user

1. **New nodes during Teach:** the teaching skill says a new foundational fact needed mid-lesson gets its own loop, but nothing can add a node after approval. The options are an `add_node` tool with validation, or teaching it inline without a node.
2. **Visual design** (before component 8): the repo has a Material 3 skill installed (`.agents/skills/material-3`). Ask whether they want that look.
3. **A real API key** for the first live run.

## Deferred minor issues

- **URL import can reach localhost or private addresses (SSRF).** Fine while local-only; block those ranges before any hosting.
- **HTML → Markdown conversion is paid for before the size check** that can reject the result (it is recorded in usage).
- **No SSE keep-alive pings during long silent thinking.** Add `: ping` every 15s if a proxy drops idle streams.
- **The `data/` path is relative to the working directory.** Run the server from the repo root.
- **A rejected key makes every later turn retry pending summaries**, failing again until the key is fixed. Only logs; no user impact.
- **A user message that starts with `[App:`** is hidden from the thread view like an app note.
- **A server tool that throws** after its `tool_use` is stored would leave that thread without a `tool_result`. None of the current tools do anything that should throw.

## Working conventions

- **TDD per task:** write the test, watch it fail, implement, watch it pass, then run `npm test` and `npm run typecheck`, then commit.
- **Plans:** one per component in `docs/superpowers/plans/`. Record each deviation from a plan as a "Ruling" (what, why, cost if wrong).
- **Review:** self-review each component against its plan's Review Focus. Fix Critical and Important findings test-first, and list minor ones.
- **Commits:** no `Co-Authored-By` trailer or other Claude attribution (the user's rule).
- **Untracked files:** `.claude/`, `.agents/`, and `skills-lock.json` belong to the user. Leave them uncommitted.
- **Windows/Git Bash quirks:** CRLF warnings on `git add` are harmless. Bash heredocs containing backticks fail to parse, and `\\n` inside them can turn into real newlines; write scripts and whole files with the Write tool instead.
- **Claude API:** load the `claude-api` skill before writing new API code. The beta stream params type is imported from `@anthropic-ai/sdk/resources/beta/messages/messages` (`BetaMessageStreamParams`).

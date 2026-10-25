# Handoff: MapTutor, Agent SDK switch merged into main

Read this file first, then [the Agent SDK plan](docs/superpowers/plans/2026-10-25-agent-sdk.md) (it is the spec: its Rulings, including "Added after the spike", decide the design), then [ROADMAP.md](ROADMAP.md) and [the frontend design](docs/superpowers/specs/2026-10-25-frontend-design.md). Each component's plan in `docs/superpowers/plans/` holds its rulings. The design docs (`README.md`, `01`–`05`) describe the Agent SDK and subscription sign-in.

## Where things stand

- **Branch:** `main`. The `agent-sdk` branch (cut from `3161331`) was merged on 2026-10-25 and deleted. There's no remote.
- **Done (2026-10-25):** all 7 tasks of the plan, the live smoke run, and a self-review of the whole branch.
  - Tasks 1–5: spike, SQLite session store, seam types, the engine (`core/agent.ts`), cutover.
  - Task 6: no key flow in the frontend. No Welcome screen (the app opens on Projects), no top bar API key button or panel, errors are the plain "⚠ message" line plus Retry. `main.tsx` clears the old saved key on load.
  - Task 7: docs rewritten; live smoke run passed all 8 steps plus a live web search (details in the ledger).
  - Final review (a self-review, since subagents weren't authorized): one Important finding fixed (deleting a project left its goals' transcripts, project files included, in `agent_entries`).
- **State:** 199 tests pass, typecheck clean.
- **Next:** nothing planned; see the deferred minors below. The ledger workspace `.superpowers/sdd/2026-10-25-agent-sdk/` (git-ignored: rulings, spike raw logs) can be deleted when no longer wanted.
- **Ledger:** `.superpowers/sdd/2026-10-25-agent-sdk/progress.md` (git-ignored): every ruling with its cost if wrong, the smoke run, and the review.
- **Live run:** `CLAUDE_CODE_OAUTH_TOKEN` is set in the user's environment (user scope). A terminal opened before it was set won't see it; `shots/smoke.mts` drives the API for a live run.

## How to run

```bash
npm test             # vitest: server and web tests
npm run typecheck    # tsc --noEmit (TypeScript 7)
npm run dev:fake     # Fastify on 127.0.0.1:3001 with the simulated engine + scripted fake tutor, DB at data/maptutor-fake.db
npm run dev:web      # Vite on http://localhost:5173, proxies /api to :3001
npm run dev:server   # Fastify with the Agent SDK; needs CLAUDE_CODE_OAUTH_TOKEN (exits with instructions otherwise), DB at data/maptutor.db
npm run build:web    # production build into dist/
```

- **Sign-in:** `claude setup-token` prints a token; set it as `CLAUDE_CODE_OAUTH_TOKEN` (PowerShell: `setx CLAUDE_CODE_OAUTH_TOKEN "<token>"`, then a new terminal). The token is never written into the repo. `agentEnv` drops `ANTHROPIC_*` and inherited `CLAUDE*` variables, so a shell API key can't bill per token.
- **Fake tutor** (`src/server/tutor/fake.ts`, `--fake`):
  - `fakeModel` is a scripted `SimModel` run by `simEngine` (`tutor/sim.ts`). It ignores the goal and walks one calculus graph: question → `set_goal_title` → probe quiz (with a `searching` status) → plan (feedback re-proposes) → approval → per node a lesson with math and a one-item quiz-check (a wrong answer repeats it) → done.
  - A user message containing **`[fail]`** fails once ("Claude is overloaded…"), so the error line and Retry can be tried.
  - Pace: 1200 ms thinking, then text chunks every 300 ms.
- **Screenshots:** `npx tsx scripts/shot.ts <url> <out.png> [--dark] [--width] [--height]` drives the installed Chrome via `playwright-core`. Ad-hoc scripts and seeders live in `shots/` (git-ignored): `seed.mts` (wipes and seeds the fake DB), `seed-files.mts`, `seed-strands.mts`, `t*.mts` walkthroughs, and `agent-spike.ts` (the Task 1 spike; live calls, needs the token). Run them with `npx tsx shots/<name>`. Scripts must live inside the repo so they can import packages. The older seeders and `t*.mts` still set `maptutor.key`, which is harmless (the app clears it). `t6.mts` sends `[fail]` in a later message: a goal containing `[fail]` fails every Retry, because `<study_state>` echoes the goal.
- **Startup warning:** `ExperimentalWarning: SQLite …` is expected.
- **Leftover server on Windows:** the `tsx watch` child can outlive a killed `npm`. Free a port with `netstat -ano | grep :3001` (or `:5173`) and `taskkill //PID <pid> //T //F`.
- **No migrations:** after a schema change, move the dev database aside. The fake DB was recreated on the new schema on 2026-10-25; the old one is `data/maptutor-fake.pre-agent-sdk.db.bak`. No `data/maptutor.db` exists yet. The backups `data/*.db.bak` are deletable.
- **Agent dirs:** `data/agent` (empty cwd for Claude Code) and `data/claude` (its `CLAUDE_CONFIG_DIR`) are made at startup. Transcripts live in SQLite `agent_entries`; `data/claude` holds Claude Code's own local copies and settings fetched for the account.

## How the tutor runs now (Agent SDK)

- **Sessions:** one Agent SDK session per thread: `studies.session_id` for the main thread, `nodes.session_id` for each node thread.
  - A thread's first prompt carries the project files, the text and `<study_state>`; later prompts carry the text and state only.
  - Claude Code's `SessionStore` writes transcripts to `agent_entries` (`core/sessions.ts`, keyed by session id).
- **`messages` is a display mirror.** `threadView`, summaries and pending cards read it; the model's context is the session.
  - The prompt row is written when the session starts, assistant rows as they arrive (one per API response), tool results unless the route already stored that answer.
- **A hop** is one `query()` on one session (`core/agent.ts`). It runs until the model ends its turn, a card defers, or `focus_node` switches threads. `runTurn` (`tutor/loop.ts`) chains up to 20 hops; each hop allows 20 model calls.
- **Tools reach Claude Code over HTTP**, at `POST /mcp/:hop` on this same Fastify server.
  - Each hop has a random id; the route serves `TOOLS` (Zod `shape`s) with the MCP SDK's stateless transport.
  - In-process `createSdkMcpServer` tools aren't connected when a deferred call resumes (spike S4), hence the user's decision for HTTP.
  - Every query sets `MCP_CONNECTION_NONBLOCKING=false`.
- **Cards defer.**
  - `PreToolUse` calls `decide`. A valid card returns `defer`, the hop ends deferred, and `runTurn` runs the tool's `onPause` once, marks the row pending, and emits `card`.
  - Answering: the route grades or applies the answer and stores the `tool_result` row. It then resumes with **no prompt**: an empty prompt stream that stays open until the result.
  - The hook fires again for the same `tool_use_id`, `decide` finds the stored answer (before any phase check), and the handler returns it.
- **Batched calls:** a card batched with other calls can't defer. Its handler refuses ("Call `<name>` on its own…"). The prompt also says to call one tool per message.
- **Retry:**
  - The last row is a card answer → resume with no prompt.
  - If nothing is deferred any more, the engine returns `nothing_deferred` (checked against `agent_entries`), and `runTurn` sends `[App: Your last reply did not arrive. Reply to the thread as it stands.]`.
  - Anything else → that note.
- **Stop** calls `Query.interrupt()`; `abortController` doesn't stop generation (S7).
- **Usage:** one row per model per hop. It is `result.modelUsage` minus the session's totals before the hop (the last `cost-state` entry), because `modelUsage` is cumulative across resumes. An interrupted hop records none.
- **Side calls** (node summaries, HTML → Markdown): `sideCall` on Haiku 5.5, `effort: 'low'`, no tools, no session.
- **Errors:** `agentError` turns results and throws into plain words (not signed in, usage limit, overloaded, else `Claude error: …`). They reach the chat as the `error` event, or as a 502 for URL imports.

## Code map

### Server (`src/server/`)

| File | Responsibility |
|---|---|
| `core/db.ts` | Schema (`session_id` on studies and nodes, `agent_entries`), `openDb`, `transaction`, `LOCAL_USER_ID`, `requireProject` |
| `core/config.ts` | Model IDs (`TUTOR_MODEL` `claude-opus-5-5`, `SIDE_MODEL` `claude-haiku-5-5`), `AGENT_DIR`, `CLAUDE_HOME`, `MAX_TURNS`, size limits |
| `core/agent.ts` | The Agent SDK engine: `agentEnv`, `agentEngine(db, mcpBase)`, `mcpRoutes`, `hookOutput`, `hopResult`, `usageRows`, `agentError`/`AgentError`, `sideCall`, `summarize`, `htmlToMarkdown`, `statusOf` |
| `core/sessions.ts` | `sqliteSessionStore`, `deleteSessions`, `sessionUsage`, `hasDeferredCall` |
| `core/usage.ts` | `recordUsage(db, projectId, studyId, UsageRow)`, `usageByModel` |
| `app.ts` | `buildApp({ db, logStream?, runHop?, summarize?, htmlToMarkdown? })`; defaults to the Agent SDK at the app's own listening address; error handler |
| `main.ts` | Entry point; needs `CLAUDE_CODE_OAUTH_TOKEN` unless `--fake`; makes the agent dirs |
| `routes/projects.ts` | Projects (list with counts, rename), studies list with titles and mastery counts, usage totals |
| `routes/files.ts` | Uploads, URL import/refresh, file serving, size checks |
| `routes/studies.ts` | Study, thread, prerequisites, goal deletion (also deletes its transcripts); turn routes `messages`, `tool-results`, `retry`, `open` (SSE) and `stop`; lock map; summaries after each turn |
| `tutor/engine.ts` | The seam: `Hop`, `RunHop`, `Decision`, `ToolOutcome`, `Stop`, `UsageRow`, `Block`, `Status` |
| `tutor/sim.ts` | `simEngine(model)`: the SDK's hop semantics over a scripted model, sessions in memory (tests, `dev:fake`) |
| `tutor/scripted.ts` | Test helper: a scripted model on `simEngine` |
| `tutor/graph.ts` | Pure graph engine: validation, initial states, transitions, weak ancestors, next node |
| `tutor/prompt.ts`, `prompts/` | System prompt = teaching skill + app appendix (files-first, teach-inline, opened-node, goal-title, `mcp__tutor__` names, one tool per message) |
| `tutor/context.ts` | `fileBlocks`, `studyStateText`, `isAppText` |
| `tutor/tools.ts` | Tool registry (`def.shape` Zod raw shapes); `ask_user_question`, `set_goal_title`; `allowedTools(phase)` (lists `WebSearch`) |
| `tutor/quiz.ts`, `plan.ts`, `teach.ts` | `quiz`, `propose_graph`, `focus_node` / `set_node_state`, summaries |
| `tutor/loop.ts` | `runTurn` (hops, `decide`/`run`, mirror, endings), `retryPrompt`, `resultText`, `appendUserMessage`, `pendingCard`, `clearPending` |
| `tutor/fake.ts` | `fakeModel`, `fakeTutor` |

### Web (`src/web/`, Vite root)

| File | Responsibility |
|---|---|
| `main.tsx`, `App.tsx`, `styles.css` | Mount, Nunito, theme before first paint, clears the pre-switch saved key; routes; all tokens (light + `[data-theme="dark"]`) and component styles |
| `lib/api.ts` | `api()`, `ApiError`, types, `uploadAll` |
| `lib/app.tsx` | `useDismiss` for top bar popovers |
| `lib/router.ts`, `lib/theme.ts` | 20-line history router (`/`, `/projects/:id`, `/goals/:id`); theme follows OS until toggled |
| `lib/format.ts` | Labels, bytes, badges, mastery segments, `clampSplit`, model names and token figures for Usage |
| `lib/sse.ts`, `lib/turn.ts` | SSE over `fetch`; the turn reducer (live segments with absolute indexes, refetch/synced) and `errorView` |
| `lib/cards.ts`, `lib/graph.ts` | Quiz keys and summary, question answers; dagre layout, `layoutKey`, light relay timings, label size, prerequisite text |
| `pages/Projects.tsx`, `Goal.tsx` | The two screens; `Goal` owns study, open thread, turn, queue, Stop/Retry, card answers, prerequisite banner, `turnThread`, goal-complete confetti |
| `components/` | `TopBar`, `Sidebar`, `ProjectPage`, `Goals`, `Files`, `Dialog`, `MasteryBar`, `PhaseSteps`, `SplitPane`, `StrandPanel`, `Chat` (`banner`, `after` props), `Markdown`, `QuizCard`, `QuestionCard`, `PlanCard`, `Map`, `PrereqBanner`, `Usage` (stays: tokens only), `Confetti` |

## API for the frontend

All JSON. No key header any more. Turn routes answer with SSE.

| Route | What it returns or does |
|---|---|
| `GET /api/projects` | `[{ id, name, createdAt, goalCount, fileCount }]` |
| `POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` | Project with `files`, `studies` (each with `title`, `counts` per state, `usage`), and project-wide `usage`. `PATCH { name }` renames |
| `POST /api/projects/:id/files?name=…` (octet-stream), `POST /api/projects/:id/urls`, `POST /api/files/:id/refresh`, `GET /api/files/:id/content`, `DELETE /api/files/:id` | Context files |
| `POST /api/projects/:id/studies` `{ goal }` | Creates a goal in probe |
| `DELETE /api/studies/:id` | Deletes a goal, everything in it, and its transcripts; 409 while a turn runs |
| `GET /api/studies/:id` | `projectId, goal, title, phase, approach, focusNodeId, nodes, edges, strands, usage` |
| `GET /api/studies/:id/thread?nodeId=` | Thread items: `user`/`assistant` text and `card`s (`toolUseId, name, input, answer, pending`) |
| `GET /api/studies/:id/nodes/:nodeId/prerequisites` | `{ weak: [{ id, state }] }` |
| `POST /api/studies/:id/messages` `{ text, nodeId? }` | Starts a turn; 409 if a turn runs, a card is pending in that thread, or `nodeId` is set before approval |
| `POST /api/studies/:id/stop` | Interrupts the running turn (204 either way); streamed text is kept; the stream ends with `done` |
| `POST /api/studies/:id/retry` `{ nodeId? }` | Re-runs a thread whose last message got no reply; 409 `Nothing to retry.` otherwise |
| `POST /api/studies/:id/open` `{ nodeId }` | Starts the lesson in an empty node thread (SSE); 204 if it has history; 409 before approval |
| `POST /api/studies/:id/tool-results` `{ toolUseId, answer }` | Answers a card and resumes |
| `POST /mcp/:hop` | Internal: Claude Code's MCP calls for a running hop (404 for an unknown hop) |

SSE events: `text { delta }`, `status { kind }`, `card`, `focus { nodeId }`, `error { message }`, exactly one `done { awaiting }`.

## Decisions you must not undo

- **The plan's Rulings replace the old Messages API decisions** (the user's instruction for this branch): no explicit `cache_control`, no thinking-binding or server-side-fallback betas, no `disable_parallel_tool_use`, no BYOK key.
- **Personal use only.** Subscription auth is for the user's own ordinary use, never for serving others.
- **Isolation:**
  - Every query uses `settingSources: []`, `cwd: data/agent`, `CLAUDE_CONFIG_DIR = data/claude`, `strictMcpConfig`, `permissionMode: 'dontAsk'` and `verbatimPrompts`.
  - `tools` is `['WebSearch']` only.
  - The env is `agentEnv()`.
- **Tools over HTTP from this server** (the user's decision after S4), with `MCP_CONNECTION_NONBLOCKING=false`. The prompt stream stays open until the result.
- **Card answers:** answered in the route (grading, approval) exactly once, then resumed with no prompt. A stored answer is settled before the phase check.
- **Other:**
  - `node:sqlite`.
  - Per-study node ids with cascading composite keys.
  - Node threads only after approval.
  - One turn per study.
  - Grading on the server only.
  - `done` never undone.
  - Summaries after each turn.

## Deferred minor issues

- URL import can reach localhost or private addresses (SSRF). Fine while local-only.
- HTML → Markdown conversion is paid for before the size check that can reject it.
- No SSE keep-alive pings during long silent thinking.
- The `data/` path is relative to the working directory; run servers from the repo root.
- A user message starting with `[App:` is hidden like an app note.
- Deleting a goal cascades its usage rows, so project usage totals drop with it.
- Deleting a project mid-turn isn't locked; the turn then fails on a foreign key and only logs.
- The Usage popover lags the Haiku summary usage by one turn (summaries are written after `done`).
- The map re-adopts every React Flow node on each `Goal` render (each streamed chunk); fine at this graph size.
- Switching back to the running turn's thread mid-step can briefly show a stored step twice until the next refetch.
- Agent SDK branch (from the ledger, for the final list):
  - A hop that fails before Claude Code's `init` (e.g. the CLI can't start) doesn't store the user's message.
  - `data/agent` sits inside the git repo, so Claude Code finds the repo root's `.claude/skills` (unused, since there's no Skill tool).
  - Claude Code's local transcript copies in `data/claude/projects` (project files included) outlive goal and project deletion until its own 30-day sweep.
  - Transcript storage grows with project files × threads: every thread's first prompt carries all files, in `agent_entries` and in Claude Code's local copy.
  - A Stop that lands before Claude Code accepts `interrupt()` lets the hop run on; if it ends on a card, the card isn't shown (the next message drops the deferred call).
  - Web searches are recorded on the Haiku usage row: Claude Code runs `WebSearch` through its own Haiku call.
  - The tutor skipped the plan-phase scoping search in the smoke run (model behavior; searching works when asked).
  - Pre-existing: `tool-results` applies the answer before taking the turn lock; a 409 there leaves quiz items stored and the card unanswerable. The UI disables cards during a turn, so only two tabs can hit it.

## Working conventions

- **TDD per task:** test, watch it fail, implement, watch it pass, `npm test` and `npm run typecheck`, commit. UI is verified by screenshots (read the PNGs) after the logic tests pass.
- **Plans:** one per component in `docs/superpowers/plans/`. Deviations are "Rulings" (what, why, cost if wrong); the Agent SDK ones are in the ledger until the branch closes.
- **Review:** self-review against the plan's Review Focus.
- **Commits:** no `Co-Authored-By` trailer or other Claude attribution (the user's rule).
- **Untracked files:** `.claude/`, `.agents/`, and `skills-lock.json` belong to the user; leave them uncommitted. `shots/`, `data/` and `.superpowers/` are git-ignored scratch.
- **Windows/Git Bash quirks:**
  - CRLF warnings are harmless (pipe `git add` to `2>/dev/null`).
  - Bash heredocs with backticks fail, and Python heredocs mangle `\$`, `\n` and non-ASCII text such as `…` or `–`. Write such files, or Python edit scripts, with the Write/Edit tools (scripts go in the scratchpad).
- **Claude API / Agent SDK:** load the `claude-api` skill before writing new API code. The Agent SDK's own reference is its installed `sdk.d.ts` (0.3.310) and code.claude.com/docs/en/agent-sdk.

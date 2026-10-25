# Handoff: MapTutor, frontend built (components 0–11 done)

Read this file first, then [ROADMAP.md](ROADMAP.md) and **[the frontend design](docs/superpowers/specs/2026-10-25-frontend-design.md)**. Each component's plan in `docs/superpowers/plans/` holds its rulings. The older design docs (`README.md`, `01`–`05`) are up to date with the frontend; the frontend design wins where they disagree.

## Where things stand

- **Branch:** `main` (`backend` was fast-forwarded into it and deleted on 2026-10-25). There's no remote. All work is committed.
- **Done:** every component, 0–11. 176 tests pass, typecheck clean. The final whole-branch review was a self-review (the user chose no subagents); its deferred minors are under "Deferred minor issues".
- **Next (the user's call):**
  1. The user reviews the finished frontend and the **(my call)** items and rulings (listed for them at the end of the 2026-10-25 session).
  2. The first live run with their key.
  3. `docs/superpowers/plans/2026-10-25-agent-sdk.md` (untracked; the Agent SDK switch) when the user picks it.
- **Execution:** native, `superpowers:executing-plans`, no subagents unless the user asks.
- **No live Claude calls during the build.** Everything runs against the fake tutor; the first live run happens later, with the user.
- **Check-ins (the user's choice):** none mid-build. Stop only for a real blocker, or anything destructive or outward-facing.
- **Design questions:** the user owns every visual detail. Follow the design doc exactly; where it is silent, pick the option closest to its direction and record it as a ruling. Mockups are in `.superpowers/brainstorm/3844-1792904533/content/` (untracked); the doc wins over a mockup.

## How to run

```bash
npm test             # vitest: server and web tests
npm run typecheck    # tsc --noEmit (TypeScript 7)
npm run dev:fake     # Fastify on 127.0.0.1:3001 with the scripted fake tutor, DB at data/maptutor-fake.db
npm run dev:web      # Vite on http://localhost:5173, proxies /api to :3001
npm run dev:server   # Fastify with real Claude calls (needs a key in the UI), DB at data/maptutor.db
npm run build:web    # production build into dist/
```

- **Try the app:** run `dev:fake` and `dev:web` in two terminals, open `http://localhost:5173`, save any key starting `sk-ant-` (the fake key check accepts those).
- **Fake tutor** (`src/server/tutor/fake.ts`, `--fake`): ignores the goal and walks one calculus graph: question → `set_goal_title` → probe quiz (with a `searching` status) → plan (feedback re-proposes) → approval → per node a lesson with math and a one-item quiz-check (a wrong answer repeats it) → done. A user message containing **`[fail]`** fails once (529 overloaded), so the error line and Retry can be tried. Its pace is 1200 ms thinking, then text chunks every 300 ms.
- **Screenshots:** `npx tsx scripts/shot.ts <url> <out.png> [--dark] [--key <k>] [--width] [--height]` drives the installed Chrome via `playwright-core` (no browser download). Ad-hoc interaction scripts and seeders live in `shots/` (git-ignored, local only): `seed.mts` (wipes and seeds projects and goals in every phase into the fake DB), `seed-files.mts`, `seed-strands.mts`, and `t*.mts` walkthroughs. Run them with `npx tsx shots/<name>.mts` while both dev servers are up. Scripts must live inside the repo so they can import `playwright-core`.
- **Startup warning:** `ExperimentalWarning: SQLite …` is expected.
- **Leftover server on Windows:** the `tsx watch` child can outlive a killed `npm`. Free a port with `netstat -ano | grep :3001` (or `:5173`) and `taskkill //PID <pid> //T //F`.
- **No migrations:** after a schema change, move the dev database aside. Old ones: `data/maptutor.pre-component-5.db.bak`, `data/maptutor.pre-7b.db.bak` (both deletable). `data/maptutor-fake.db` holds the seeded demo data.
- **No API key in this environment.** Every Claude call is behind an injectable seam (`htmlToMarkdown`, `streamMessage`, `summarize`, `checkKey`). **A successful live call has never run**, including the Haiku summary call and `models.list` for the key check.

## Code map

### Server (`src/server/`)

| File | Responsibility |
|---|---|
| `core/db.ts` | Schema (kept in sync with 04-data-model), `openDb`, `transaction`, `LOCAL_USER_ID`, `requireProject` |
| `core/config.ts` | Model IDs (`claude-opus-5-5` tutor, `claude-haiku-5-5` side calls), size limits |
| `core/anthropic.ts` | BYOK `apiKey(req)`, `clientFor`, `checkKey` (models.list), real `streamMessage` (abort via `signal`, `onStatus` from `statusOf`), `htmlToMarkdown`, `summarize`, `anthropicError` (plain-word messages) |
| `core/usage.ts` | `recordUsage`, `usageByModel` |
| `app.ts` | `buildApp({ db, logStream?, htmlToMarkdown?, streamMessage?, summarize?, checkKey? })`, `POST /api/key/check`, error handler |
| `main.ts` | Entry point; `--fake` swaps in `fakeTutor` and the fake DB |
| `routes/projects.ts` | Projects (list with counts, rename), studies list with titles and mastery counts, usage totals |
| `routes/files.ts` | Uploads, URL import/refresh, file serving, size checks |
| `routes/studies.ts` | Study, thread, prerequisites, goal deletion; turn routes `messages`, `tool-results`, `retry`, `open` (SSE) and `stop`; lock map of `AbortController`s; summaries after each turn |
| `tutor/graph.ts` | Pure graph engine: validation, initial states, transitions, weak ancestors, next node |
| `tutor/prompt.ts`, `prompts/` | System prompt = teaching skill + app appendix (files-first, teach-inline, opened-node, goal-title rules) |
| `tutor/context.ts` | `buildRequest`, file blocks, `<study_state>`, thread messages |
| `tutor/tools.ts` | Tool registry; `ask_user_question`, `set_goal_title`; `allowedTools(phase)` |
| `tutor/quiz.ts`, `plan.ts`, `teach.ts` | `quiz`, `propose_graph`, `focus_node` / `set_node_state`, summaries |
| `tutor/loop.ts` | `runTurn` (status events, Stop keeps streamed text, thread switching, usage) |
| `tutor/fake.ts` | The scripted fake tutor |

### Web (`src/web/`, Vite root)

| File | Responsibility |
|---|---|
| `main.tsx`, `App.tsx`, `styles.css` | Mount, Nunito, theme before first paint; key context and welcome gate; routes; all tokens (light + `[data-theme="dark"]`) and component styles |
| `lib/api.ts` | `api()` with the saved key, `ApiError`, types, `uploadAll` |
| `lib/key.ts`, `lib/app.tsx` | Key in `localStorage`, `checkAndSave`, `maskKey`; `useApp()` (key, status, panel, `requireKey`); `useDismiss` for top bar popovers |
| `lib/router.ts`, `lib/theme.ts` | 20-line history router (`/`, `/projects/:id`, `/goals/:id`); theme follows OS until toggled |
| `lib/format.ts` | Labels, bytes, badges, mastery segments, `clampSplit`, model names and token figures for Usage |
| `lib/sse.ts`, `lib/turn.ts` | SSE over `fetch`; the turn reducer (live segments with absolute indexes, refetch/synced) and `errorView` |
| `lib/cards.ts`, `lib/graph.ts` | Quiz keys and summary, question answers; dagre layout, `layoutKey`, light relay timings, label size, prerequisite text |
| `pages/Welcome.tsx`, `Projects.tsx`, `Goal.tsx` | The three screens; `Goal` owns study, open thread, turn, queue, Stop/Retry, card answers |
| `components/` | `TopBar`, `KeyPanel`/`KeyField`, `Sidebar`, `ProjectPage`, `Goals`, `Files`, `Dialog`, `MasteryBar`, `PhaseSteps`, `SplitPane`, `StrandPanel`, `Chat`, `Markdown` (KaTeX; one-line `$$…$$` → display), `QuizCard`, `QuestionCard`, `PlanCard`, `Map` (`StudyMap`; explicit React Flow `handles`), `PrereqBanner`, `Usage` (`UsageButton`), `Confetti` |

## API for the frontend

All JSON. Turn routes need the `x-anthropic-key` header and answer with SSE.

| Route | What it returns or does |
|---|---|
| `POST /api/key/check` | 204 when Anthropic accepts the header's key, else 401 |
| `GET /api/projects` | `[{ id, name, createdAt, goalCount, fileCount }]` |
| `POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` | Project with `files`, `studies` (each with `title`, `counts` per state, `usage`), and project-wide `usage`. `PATCH { name }` renames |
| `POST /api/projects/:id/files?name=…` (octet-stream), `POST /api/projects/:id/urls`, `POST /api/files/:id/refresh`, `GET /api/files/:id/content`, `DELETE /api/files/:id` | Context files |
| `POST /api/projects/:id/studies` `{ goal }` | Creates a goal in probe |
| `DELETE /api/studies/:id` | Deletes a goal and everything in it; 409 while a turn runs |
| `GET /api/studies/:id` | `projectId, goal, title, phase, approach, focusNodeId, nodes, edges, strands, usage`. Nodes: `{ id, label, kind, description, strands, state, everKnown, summary, evidence: { correct, total } }` |
| `GET /api/studies/:id/thread?nodeId=` | Thread items: `user`/`assistant` text and `card`s (`toolUseId, name, input, answer, pending`) |
| `GET /api/studies/:id/nodes/:nodeId/prerequisites` | `{ weak: [{ id, state }] }`; the banner's "Go to" target is `weak[0]` |
| `POST /api/studies/:id/messages` `{ text, nodeId? }` | Starts a turn; posting to a node thread focuses it. 409 if a turn runs, a card is pending in that thread, or `nodeId` is set before approval |
| `POST /api/studies/:id/stop` | Aborts the running turn (204 either way); streamed text is kept; the turn's stream ends with `done` |
| `POST /api/studies/:id/retry` `{ nodeId? }` | Re-runs a thread whose last message got no reply; 409 `Nothing to retry.` otherwise |
| `POST /api/studies/:id/open` `{ nodeId }` | Starts the lesson in an empty node thread (SSE); 204 if it has history; 409 before approval |
| `POST /api/studies/:id/tool-results` `{ toolUseId, answer }` | Answers a card and resumes. `ask_user_question` `{ answers }`, `quiz` `{ choices }`, `propose_graph` `{ decision: 'approved' }` or `{ decision: 'feedback', text }` |

SSE events: `text { delta }`, `status { kind }`, `card`, `focus { nodeId }`, `error { message }`, exactly one `done { awaiting }`. The response stays open briefly after `done` while summaries are written; the client stops reading at `done`.

## Decisions you must not undo

**Append-only history (the big one).** Opus 5.5 rejects a replayed thinking block if `system`, `tools`, or any earlier message changed since it was made. So: a frozen system prompt; the full tool list in a fixed order every request (web search uncapped, no `max_uses`); study state as a `<study_state>` block appended to each new user message and never rewritten; thread switches and opened nodes append `[App: …]` notes; `cache_control` added only at request time; `drop_block` set because project files can change mid-study; Stop appends only the streamed text as a new assistant message.

**Request parameters:** `effort: 'high'`, `max_tokens: 64000`, `tool_choice: { type: 'auto', disable_parallel_tool_use: true }`, 1h cache TTL on three breakpoints, `fallbacks: 'default'` with beta `server-side-fallback-2026-07-01` (**tell the user this is on**). Summaries: Haiku 5.5, non-streaming, `max_tokens: 16000`, `effort: 'low'`.

**Other:** `node:sqlite`; per-study node ids with cascading composite keys; node threads only after approval; one turn per study; grading on the server only; `done` never undone; summaries after each turn; one usage row per model call.

## Showing the user (done 2026-10-25; repeat if asked)

List, as the design doc asks, every **(my call)** item from the design doc plus every ruling recorded in the plans (7b, 8, 9, 10, 11), and remind them that server-side fallbacks are on. Offer the two-terminal run (`dev:fake` + `dev:web`) and the `[fail]` trick. The first live run with their key is still open.

## Deferred minor issues

- URL import can reach localhost or private addresses (SSRF). Fine while local-only.
- HTML → Markdown conversion is paid for before the size check that can reject it.
- No SSE keep-alive pings during long silent thinking.
- The `data/` path is relative to the working directory; run servers from the repo root.
- A rejected key makes later turns retry pending summaries (logs only).
- A user message starting with `[App:` is hidden like an app note.
- A server tool that throws after its `tool_use` is stored would leave the thread without a `tool_result`.
- Deleting a goal cascades its usage rows, so project usage totals drop with it.
- Deleting a project mid-turn isn't locked; the turn then fails on a foreign key and only logs.
- A step with no thinking block can glue its text to the previous step's until `done` refetches.
- The Usage popover lags the Haiku summary usage by one turn (summaries are written after `done`).
- The map re-adopts every React Flow node on each `Goal` render (each streamed chunk); fine at this graph size.
- Switching back to the running turn's thread mid-step can briefly show a stored step twice until the next refetch.

## Working conventions

- **TDD per task:** test, watch it fail, implement, watch it pass, `npm test` and `npm run typecheck`, commit. UI is verified by screenshots (read the PNGs) after the logic tests pass.
- **Plans:** one per component in `docs/superpowers/plans/`; deviations are "Rulings" (what, why, cost if wrong), copied into the plan when the component closes.
- **Review:** self-review each component against its plan's Review Focus.
- **Commits:** no `Co-Authored-By` trailer or other Claude attribution (the user's rule).
- **Untracked files:** `.claude/`, `.agents/`, and `skills-lock.json` belong to the user; leave them uncommitted. `shots/` and `.superpowers/` are git-ignored scratch.
- **Windows/Git Bash quirks:** CRLF warnings are harmless (pipe `git add` to `2>/dev/null`). Bash heredocs with backticks fail, and Python heredocs mangle `\$` and `\n` in regexes; write such files with the Write/Edit tools.
- **Claude API:** load the `claude-api` skill before writing new API code.

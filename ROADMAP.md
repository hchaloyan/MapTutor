# Roadmap

Backend first, then frontend. Each component ends with something that runs and has tests. Component 2 has no dependencies and can be built at any point.

## Backend

| # | Component | What's in it | Needs | Status |
|---|---|---|---|---|
| 0 | Server skeleton | Fastify + SQLite, schema from [04](04-data-model.md), health route, key header never logged | — | Done: [plan](docs/superpowers/plans/2026-10-24-skeleton.md) |
| 1 | Projects & files API | Project CRUD, uploads (PDF, image, md/txt, URL → Markdown), URL refresh, size limits per file and per project | 0 | Done: [plan](docs/superpowers/plans/2026-10-24-projects-files.md) |
| 2 | Graph engine | Pure TS: `propose_graph` validation, initial states, transitions, `set_node_state` guards, weak-ancestor list, next-node selection | — | Done: [plan](docs/superpowers/plans/2026-10-24-graph-engine.md) |
| 3 | Agent loop | Context assembly with 2 cache breakpoints, tool loop with pause/resume on client tools, SSE, message persistence, tool-result route, `ask_user_question` | 0, 1 | |
| 4 | Probe | `quiz` tool, server-side grading, `quiz_items` with strands, Probe → Plan switch | 3 | |
| 5 | Plan | Scoping web search, `propose_graph` validation, approve/feedback, initial states, approve → Teach | 2, 4 | |
| 6 | Teach | Per-node threads, `focus_node`, quiz-check transitions, `set_node_state` guards, summaries side call, next node, prerequisite check | 5 | |
| 7 | Usage | Token and search usage per study, search cap setting | 3 | |

## Frontend

| # | Component | What's in it | Needs | Status |
|---|---|---|---|---|
| 8 | Shell + projects | Vite + React app, BYOK key panel, projects list, project page (uploads, studies with mastery bars) | 1 | |
| 9 | Study view | Split pane, chat with Markdown + KaTeX, goal / quiz / approval cards, strand placeholder | 3–5 | |
| 10 | Graph view | React Flow + dagre, state colors, current-node pulse, legend, tooltip, prerequisite banner, thread switching | 6 | |
| 11 | Polish | Usage display, URL refresh button, web-search cost note | 7 | |

## Decisions

- **Backend:** Fastify + `node:sqlite`, local only, no hosting (2026-10-24).
- **Build order:** all backend, then all frontend. No terminal client; the tutor is first used from the frontend (2026-10-24).
- **Grading:** on the server. Quiz items are saved when the tutor calls `quiz`; the client sends back only the chosen option IDs.
- **Probe → Plan:** the server switches the phase on the tutor's first `propose_graph` call. Revisit in component 5.
- **`quiz_items.hint`:** added to the schema.
- **Teaching skill:** stored verbatim in [prompts/teaching-skill.md](prompts/teaching-skill.md); frontmatter stripped when the prompt is built.
- **Tool names follow the skill:** `ask_goal` is now `ask_user_question` and is allowed in every phase, since the skill also uses it mid-lesson.
- **Web search in every phase:** the skill says to verify any uncertain fact, including in probe questions.

## Open

- **New nodes during Teach:** the skill says a new unconditional truth needed mid-session gets its own loop, but nothing in the app can add a node after approval. Decide before component 6.
- **Visual design:** decide before component 8 (the repo has a Material 3 skill installed).

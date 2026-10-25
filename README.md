# Tutor App: Design

A web app that runs a Claude tutor with a fixed teaching method:

1. Lock in unconditional truths first.
2. Make every step feel discovered ("how could I have discovered this?").

The flow:

1. The user creates a **project** and uploads context files (slides, notes, images, links).
2. The user starts a **study** by stating a goal.
3. The tutor screens them with an edge-finding quiz.
4. The tutor proposes a **dependency graph** of topics, colored by mastery, with missed topics in red.
5. Once the user approves the graph, the tutor teaches it node by node.

## Why

The teaching method only works if the tutor knows where the learner's edge is and teaches along explicit dependencies. The app makes both of those concrete. The screening quiz locates the edge, and the graph turns dependencies into something the user can see and navigate. All state lives in the app rather than in the model, because the model keeps nothing between requests.

## Decisions

| Area | Decision |
|---|---|
| After the graph | Full tutor loop. Any node can be revisited or taken out of order at any time |
| Users / billing | Me and friends, BYOK (bring your own API key). Keep the path to public open |
| Node states | Untested (gray), Missed (red), Frontier (amber), Known (green) |
| Uploads | PDFs / slide decks, Markdown / text notes, images, links |
| Out-of-order prerequisites | Warn, then allow |
| Plan checkpoint | Approve, or give feedback in chat and the tutor regenerates. No hand-editing |
| Layout | Split pane: graph on the left, chat on the right |
| Organization | Projects with shared context files. Each project holds multiple studies |
| Demotion | A known node that fails a later quiz-check drops to Frontier (amber), never to red |
| Teaching prompt | Fixed. Users cannot edit it |
| Fact verification | Claude web search, capped per request |

## Docs

- [01-user-flow.md](01-user-flow.md): screens, phases, and navigation
- [02-agent.md](02-agent.md): tutor tools, the tool loop, context assembly, and verification
- [03-graph.md](03-graph.md): node states, transitions, the prerequisite warning, and layout
- [04-data-model.md](04-data-model.md): schema
- [05-stack.md](05-stack.md): tech stack, BYOK, uploads, and caching
- [ROADMAP.md](ROADMAP.md): build order, decisions, and open questions

## Out of scope for v1

- Accounts, auth, and billing (BYOK makes these unnecessary for now)
- Editing the graph by hand
- Mobile layout
- Sharing projects between users

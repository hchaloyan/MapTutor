# Stack

## Why

- **Familiar tools.** The stack is TypeScript end to end and reuses tools already known from Leetboard and Recipe Storer.
- **The Claude Agent SDK on a Claude subscription.** The tutor runs inside Claude Code, signed in with the user's own subscription, so there's no API key and no per-token bill. This is for personal use only: subscription sign-in covers the subscriber's own use, never serving other people.
- **The loop stays on the server.** The tool loop, the state guards and the database writes run in the backend, where the client can't bypass them.
- **One session per thread.** Claude Code keeps each thread's transcript and caches its prefix (the system prompt, the project files, the earlier turns) on its own.

## Frontend

- **App:** React, Vite, and TypeScript.
- **Type:** Nunito, self-hosted (`@fontsource/nunito`) so the local app works offline.
- **Graph:** React Flow (`@xyflow/react`) with `dagre` for top-down layout.
- **Chat rendering:** `react-markdown` with `remark-math`, `rehype-katex`, and `remark-gfm`.
- **Cards:** custom components for quizzes, goal questions, and plan approval, each rendered from tool calls.
- **Streaming:** Server-Sent Events from the backend, consumed with `fetch` and a stream reader.

## Backend

**Fastify and SQLite**, with uploaded file bytes stored in SQLite. SQLite is Node's built-in `node:sqlite` (Node 24+), so nothing needs a native build. It runs locally only, with no hosting for now. Cloudflare Workers + D1 + R2 stays possible later, since the schema is SQLite-flavored.

The backend:

- runs the tool loop ([02-agent.md](02-agent.md#tool-loop))
- enforces phase and state guards
- serves files
- runs the tutor through the Agent SDK and serves its tools to Claude Code over MCP (`POST /mcp/:hop`)

## Claude sign-in

- **Token.** `claude setup-token` prints a long-lived token for the user's subscription. It's set as `CLAUDE_CODE_OAUTH_TOKEN` in the server's environment and never written to the repo, the database or the browser. `npm run dev:server` exits with instructions when it's missing.
- **No API key, ever.** The environment passed to Claude Code drops every `ANTHROPIC_*` variable and every inherited `CLAUDE*` variable except the token, so an API key set in the shell can't switch the app to per-token billing.
- **Isolation.** Every query ignores the user's own Claude Code setup: no settings files (`settingSources: []`), its own empty working directory (`data/agent`) and config directory (`data/claude`), only the tutor's MCP server (`strictMcpConfig`), `permissionMode: 'dontAsk'`, prompts sent verbatim, and `WebSearch` as the only built-in tool. No CLAUDE.md, memory, plugins or hooks reach the tutor.
- **Transcripts** live in SQLite (`agent_entries`, see [04-data-model.md](04-data-model.md)), so Claude Code's local cleanup or a moved repo loses nothing. Deleting a goal deletes its transcripts.
- **Errors** read as plain words in the chat: not signed in (with the command to fix it), the plan's usage limit, overloaded, or `Claude error: …`.

## Uploads

| Kind | Handling |
|---|---|
| PDF / slides | Stored as-is (bytes in SQLite) and sent to Claude as a native PDF document block. Slides from PowerPoint are exported to PDF first; the UI accepts `.pdf` |
| Images | Stored as-is (bytes in SQLite) and sent as image blocks (whiteboard photos, handwritten notes) |
| `.md` / `.txt` | Stored, with the text cached in `files.text_cache` |
| URL | Fetched server-side once at upload. A PDF link is stored as a PDF; plain text is stored as-is; HTML is converted to Markdown by the side model. Text goes in `text_cache`. A "Refresh" button refetches it |

Size limits: 5 MB per image (the API limit) and 20 MB per project in total, so the files fit the 32 MB request limit after base64. Both live in `src/server/core/config.ts`.

## Caching and cost

Use counts against the plan's usage limits, not a bill.

- **Caching** is Claude Code's own (no explicit `cache_control`). Each thread's session is append-only, so its prefix stays cached from hop to hop.
- **Small per-thread context:** per-node threads and Known-node summaries keep each session short.
- **Web search** is uncapped; the model decides how much to search, and the usage popover shows the count (see [02-agent.md](02-agent.md#verification)).
- **Usage display:** a **Usage** popover per goal and per project: total tokens, web searches, and each model's input, output, and cached tokens. Each hop records its `modelUsage` minus the session's totals before the hop, because Claude Code reports them cumulatively per session. Tokens only, no money.

## Model

- **Tutor:** a strong model, because teaching quality depends on it.
- **Side calls:** a cheaper model at low effort for node summaries and URL-to-Markdown cleanup, with no tools and no saved session.
- **Configuration:** both model names live in config. Check the Claude API docs for current model IDs.

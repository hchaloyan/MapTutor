# Stack

## Why

- **Familiar tools.** The stack is TypeScript end to end and reuses tools already known from Leetboard and Recipe Storer.
- **BYOK.** It removes billing and accounts while the users are a small group of friends.
- **Server-side proxy.** Proxying API calls through the backend keeps the tool loop and the state guards on the server, where the client can't bypass them. It's also where a server-owned key slots in if the app goes public.
- **Prompt caching.** It's the main cost lever, because every request resends the fixed prompt and the project files.

## Frontend

- **App:** React, Vite, and TypeScript.
- **Graph:** React Flow (`@xyflow/react`) with `dagre` for top-down layout.
- **Chat rendering:** `react-markdown` with `remark-math`, `rehype-katex`, and `remark-gfm`.
- **Cards:** custom components for quizzes, goal questions, and plan approval, each rendered from tool calls.
- **Streaming:** Server-Sent Events from the backend, consumed with `fetch` and a stream reader.

## Backend

**Fastify and SQLite**, with uploads on local disk. SQLite is Node's built-in `node:sqlite` (Node 24+), so nothing needs a native build. It runs locally only, with no hosting for now. Cloudflare Workers + D1 + R2 stays possible later, since the schema is SQLite-flavored.

The backend:

- runs the tool loop ([02-agent.md](02-agent.md#tool-loop))
- enforces phase and state guards
- serves files
- proxies Anthropic calls

## BYOK

- **Storage.** The user pastes their Anthropic key into a settings panel. It's kept in the browser's `localStorage` and never in the database.
- **Requests.** Each request sends the key in a header to the backend. The backend forwards it to the Anthropic API and drops it. Keys are never logged; logs are redacted.
- **Why proxy at all.** It keeps the tool loop, the guards, and the DB writes server-side. It's also the seam where a server-owned key and billing can be swapped in if this goes public later.

## Uploads

| Kind | Handling |
|---|---|
| PDF / slides | Stored as-is and sent to Claude as a native PDF document block. Slides from PowerPoint are exported to PDF first; the UI accepts `.pdf` |
| Images | Stored as-is and sent as image blocks (whiteboard photos, handwritten notes) |
| `.md` / `.txt` | Stored, with the text cached in `files.text_cache` |
| URL | Fetched server-side once at upload, converted to Markdown, and stored in `text_cache`. A "Refresh" button refetches it |

Size limits per file and per project should be enforced so the cached context stays within the model's window.

## Caching and cost

- **Two prompt-cache breakpoints:** one after the fixed system prompt, and one after the project files. Every turn reuses both, which is the biggest cost lever for BYOK users.
- **Small per-turn context:** per-node threads and Known-node summaries keep the uncached part small.
- **Web search** is capped per request with `max_uses` (see [02-agent.md](02-agent.md#verification)).
- **Usage display:** show token and search usage per study, taken from the API response's usage fields, so friends can see what they're spending.

## Model

- **Tutor:** a strong model, because teaching quality depends on it.
- **Side calls:** a cheaper model for node summaries and URL-to-Markdown cleanup.
- **Configuration:** both model names live in config. Check the Claude API docs for current model IDs.

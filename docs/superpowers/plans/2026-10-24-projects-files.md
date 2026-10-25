# Projects & Files API (Component 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HTTP API for projects, studies (create + list with mastery counts), and context files: uploads of PDF / image / text, URL import (PDF stored as PDF, HTML cleaned to Markdown by a cheap model), refresh, delete, and size limits.

**Architecture:** Routes split by resource: `projects.ts` (projects + studies), `files.ts` (uploads, URL import, file serving). File bytes live in SQLite (`files.data BLOB`), so project deletion cascades with no disk cleanup. The one Claude call (HTML → Markdown) sits behind an injectable `htmlToMarkdown` so tests never hit the API.

**Tech Stack:** Fastify 5, `node:sqlite`, `@anthropic-ai/sdk` 1.x, Vitest.

**Spec:** [01-user-flow.md](../../../01-user-flow.md) (Screens), [04-data-model.md](../../../04-data-model.md), [05-stack.md](../../../05-stack.md) (Uploads, Model, BYOK)

## Global Constraints

- All error responses are JSON with a `message` string (Fastify's default error shape satisfies this).
- JSON fields are camelCase (`createdAt`); DB columns stay snake_case.
- Models come from `src/server/config.ts`: `TUTOR_MODEL = process.env.TUTOR_MODEL ?? 'claude-opus-5-5'`, `SIDE_MODEL = process.env.SIDE_MODEL ?? 'claude-haiku-5-5'`.
- Limits, also in `config.ts`: `MAX_IMAGE_BYTES = 5 * 1024 * 1024` (API image limit), `MAX_PROJECT_BYTES = 20 * 1024 * 1024` (32 MB request limit after base64, with headroom). A text file counts its UTF-8 byte length.
- Accepted extensions (case-insensitive): `.pdf` → `pdf`; `.png .jpg .jpeg .gif .webp` → `image`; `.md .markdown .txt` → `text`.
- The API key arrives in `x-anthropic-key`; routes that need it answer 401 `Add your Anthropic API key in settings.` when it's missing or blank, before doing any work.
- Upload bodies are `application/octet-stream`; the file name is the `name` query parameter.

## Review Focus

1. **Upload to a project that doesn't exist** → 404, not a 500 from the foreign key. Test in Task 2.
2. **`.txt` that isn't valid UTF-8** → 415 and nothing stored. Test in Task 2.
3. **Project at its size limit** → 413 and nothing stored; deleting a file frees room again. Test in Task 2.
4. **URL with a non-http(s) scheme** (`file:///etc/passwd`) → 400 and no fetch. Test in Task 3.
5. **Page that answers 404** → 502 with the status in the message, nothing stored. Test in Task 3.

---

### Task 1: Projects and studies

**Files:**
- Create: `src/server/config.ts`, `src/server/projects.ts`
- Modify: `src/server/db.ts` (schema: replace `storage_key TEXT` with `data BLOB`), `src/server/app.ts`, `src/server/main.ts`, `src/server/app.test.ts`, `04-data-model.md` (same column change), `05-stack.md` (Uploads: "stored in SQLite")
- Test: `src/server/projects.test.ts`

**Interfaces:**
- Produces:
  - `buildApp(opts: { db: DatabaseSync; logStream?: { write(line: string): void }; htmlToMarkdown?: (html: string, apiKey: string) => Promise<string> }): FastifyInstance`, replacing the positional signature
  - `projectRoutes(app: FastifyInstance, db: DatabaseSync): void` in `projects.ts`
  - `GET /api/projects` → `[{ id, name, createdAt }]`, newest first
  - `POST /api/projects { name }` → 201 `{ id, name, createdAt }`; `name` is a trimmed non-empty string ≤ 200 chars, else 400
  - `GET /api/projects/:id` → `{ id, name, createdAt, files: FileInfo[], studies: StudyInfo[] }` or 404 `Project not found.`
  - `DELETE /api/projects/:id` → 204, or 404
  - `POST /api/projects/:id/studies { goal }` → 201 `StudyInfo`; `goal` non-empty ≤ 2000 chars; 404 for an unknown project
  - `StudyInfo = { id, goal, phase, createdAt, counts: { untested, missed, frontier, known } }`, newest first
  - `FileInfo = { id, kind, name, url: string | null, size: number, createdAt }` (`size` = bytes of `data`, or UTF-8 bytes of `text_cache`)

- [ ] **Step 1: Install and move `buildApp` to an options object**

Run: `npm i @anthropic-ai/sdk`. Update `app.test.ts` and `main.ts` to `buildApp({ db, logStream })`. Change the schema column, then delete `data/maptutor.db`.

- [ ] **Step 2: Write the failing tests** in `src/server/projects.test.ts`

```ts
// helper: const app = () => buildApp({ db: openDb(':memory:') })
test('creates a project and lists it newest first')        // two POSTs; GET list → [second, first]
test('rejects a blank project name')                        // POST { name: '   ' } → 400
test('returns 404 for an unknown project')                  // GET /api/projects/nope → 404, message 'Project not found.'
test('deleting a project removes it')                       // DELETE → 204; GET → 404
test('creates a study in probe phase with zero counts')     // POST studies { goal: 'midterm' } → 201, phase 'probe',
                                                            // counts { untested: 0, missed: 0, frontier: 0, known: 0 }
test('project page counts nodes per state for each study')  // insert 2 known + 1 missed nodes directly via db;
                                                            // GET project → studies[0].counts { known: 2, missed: 1, untested: 0, frontier: 0 }
test('creating a study in an unknown project is a 404')
```

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `npm test`
Expected: FAIL on `projects.test.ts`; `app.test.ts` and `db.test.ts` still pass.

- [ ] **Step 4: Implement `config.ts` and `projects.ts`, register `projectRoutes` in `buildApp`**

Validate bodies with Fastify route schemas (`minLength`/`maxLength`), and trim `name`/`goal` in the handler before a blank check. Use `crypto.randomUUID()` for IDs. Count states with `count(CASE WHEN n.state = 'known' THEN 1 END)` over a `LEFT JOIN nodes`, so studies with no nodes get zeros.

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `npm test` and `npm run typecheck`
Expected: 13 passed; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A src 04-data-model.md 05-stack.md package.json package-lock.json
git commit -m "feat: projects and studies API"
```

### Task 2: File uploads

**Files:**
- Create: `src/server/files.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/files.test.ts`

**Interfaces:**
- Consumes: `buildApp` options and `FileInfo` from Task 1
- Produces:
  - `fileRoutes(app: FastifyInstance, opts: { db: DatabaseSync; htmlToMarkdown: (html: string, apiKey: string) => Promise<string> }): void`
  - `kindFor(name: string): 'pdf' | 'image' | 'text' | null` and `mediaType(name: string): string`, exported for component 3's context assembly
  - `POST /api/projects/:id/files?name=<file name>` (octet-stream body) → 201 `FileInfo`
  - `GET /api/files/:id/content` → the bytes with `content-type` from `mediaType`, or `text/markdown; charset=utf-8` for text/url files
  - `DELETE /api/files/:id` → 204, or 404 `File not found.`
- Error copy:
  - 415 `Unsupported file type. Upload a PDF, an image (PNG, JPEG, GIF, WebP), or a .md/.txt file.`
  - 415 `This file isn't valid UTF-8 text.`
  - 413 `Images are limited to 5 MB.`
  - 413 `A project's files are limited to 20 MB in total.`

- [ ] **Step 1: Write the failing tests** in `src/server/files.test.ts`

```ts
// helper: upload(app, projectId, name, bytes) → inject POST with content-type application/octet-stream
test('stores a PDF and serves it back')                 // kind 'pdf', size = byte length; content route → same bytes, application/pdf
test('accepts an uppercase extension')                  // 'SCAN.PNG' → kind 'image'; content-type image/png
test('stores text as text_cache')                       // 'notes.md' with 'é' → kind 'text', size 3 (UTF-8 bytes); content → 'é'
test('rejects an unsupported type')                     // 'deck.pptx' → 415, project has no files
test('rejects text that is not UTF-8')                  // 'notes.txt' with Buffer [0xff, 0xfe] → 415, no file stored
test('rejects an image over 5 MB')                      // 413
test('enforces the project total and frees room on delete')
  // set MAX via two 6 MB PDFs + one 9 MB PDF → third is 413; delete one → third now 201
test('upload to an unknown project is a 404')
test('deleting a file removes it')                      // DELETE → 204; content route → 404
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm test`
Expected: FAIL on `files.test.ts` only.

- [ ] **Step 3: Implement `files.ts`**

- Register an `application/octet-stream` parser with `parseAs: 'buffer'` and `bodyLimit: MAX_PROJECT_BYTES`.
- Check the project exists before anything else.
- Decode text with `new TextDecoder('utf-8', { fatal: true })`.
- Compute the current project total in SQL with `sum(coalesce(length(data), length(CAST(text_cache AS BLOB))))`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test` and `npm run typecheck`
Expected: 22 passed; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/files.ts src/server/files.test.ts src/server/app.ts
git commit -m "feat: file uploads with size limits"
```

### Task 3: URL import and refresh

**Files:**
- Create: `src/server/anthropic.ts`
- Modify: `src/server/files.ts`, `src/server/app.ts`
- Test: `src/server/urls.test.ts`

**Interfaces:**
- Consumes: `fileRoutes` from Task 2
- Produces:
  - `apiKey(req: FastifyRequest): string`: the trimmed `x-anthropic-key`, or throws a 401 with the Global Constraints copy. Component 3 reuses it.
  - `htmlToMarkdown(html: string, apiKey: string): Promise<string>`: the real side call (below). It's the default for `buildApp`'s option.
  - `POST /api/projects/:id/urls { url }` → 201 `FileInfo`; `name` = the URL
  - `POST /api/files/:id/refresh` → 200 `FileInfo` with the new content; 400 `Only imported URLs can be refreshed.` for files without a `url`
  - An app error handler: `Anthropic.AuthenticationError` → 401 `Your Anthropic API key was rejected.`; any other `Anthropic.APIError` → 502 `Anthropic API error: <message>`. Component 3 relies on this.

- [ ] **Step 1: Write the failing tests** in `src/server/urls.test.ts`

Serve pages from a `node:http` server on port 0 in `beforeAll`: `/page` (HTML with a `<script>` and an `<h1>`), `/doc.pdf` (`application/pdf`), `/notes.txt` (`text/plain`), `/missing` (404). The fake `htmlToMarkdown` records its input and returns `'# Converted'`.

```ts
test('imports an HTML page through the converter')      // 201, kind 'url', content '# Converted';
                                                        // converter input contains '<h1>' and not '<script'; got apiKey 'sk-test'
test('imports a PDF link as a PDF without the converter')// kind 'pdf', url set; converter not called
test('stores plain text as-is')                          // kind 'url', content = the served text; converter not called
test('reports a failing page and stores nothing')        // /missing → 502, message contains '404'; project has no files
test('rejects a non-http URL')                           // 'file:///etc/passwd' → 400
test('requires an API key')                              // no header → 401 'Add your Anthropic API key in settings.'
test('refresh re-imports the page')                      // change what /page serves (converter returns '# New'); refresh → content '# New', same id
test('refusing to refresh an uploaded file')             // refresh a .md upload → 400
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm test`
Expected: FAIL on `urls.test.ts` only.

- [ ] **Step 3: Implement**

- **Fetch** with `fetch(url, { signal: AbortSignal.timeout(15_000) })`.
- **Branch on the `content-type` base type:**
  - `application/pdf`: store as kind `pdf` with `data`.
  - `text/plain` and `text/markdown`: store as kind `url` with `text_cache`.
  - `text/html`: strip `<script>`, `<style>`, `<noscript>`, `<svg>` elements and HTML comments with regexes, then call `htmlToMarkdown`.
  - Anything else: 415 `Unsupported page type: <type>.`
- **Failed fetch:** a non-OK status gives 502 `Fetching the page failed with status <n>.`, and a network error gives 502 `Couldn't reach that URL.`
- **Size limits:** the same checks as uploads. Refresh excludes the file's own current size from the project total.
- **`htmlToMarkdown`:** `new Anthropic({ apiKey }).messages.stream({ model: SIDE_MODEL, max_tokens: 64000, output_config: { effort: 'low' }, system, messages: [{ role: 'user', content: html }] }).finalMessage()`.
  - `system`: `Convert the HTML the user sends into clean Markdown of the page's main content. Keep headings, lists, tables, code, and math (as LaTeX). Drop navigation, ads, and footers. Reply with the Markdown only.`
  - A `stop_reason` other than `end_turn` throws a 502 `Converting the page failed (<stop_reason>).`
  - Join the text blocks for the result.
- Mark the regex stripping and the missing content-length cap with `// ponytail:` comments.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test` and `npm run typecheck`
Expected: 30 passed; typecheck exits 0.

- [ ] **Step 5: Real-API check (only when a key is available in `ANTHROPIC_API_KEY`)**

Run the server, then `curl -X POST -H "x-anthropic-key: $ANTHROPIC_API_KEY" -H 'content-type: application/json' -d '{"url":"https://en.wikipedia.org/wiki/Derivative"}' http://127.0.0.1:3001/api/projects/<id>/urls`
Expected: 201; `GET /api/files/<id>/content` is Markdown beginning with a heading. With no key, record that this check was skipped.

- [ ] **Step 6: Commit**

```bash
git add src/server
git commit -m "feat: URL import and refresh"
```

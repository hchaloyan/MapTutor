# Shell + Projects (Component 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web client's shell and projects screens: theme, welcome page, API key panel, projects sidebar, and the project page with goals and files.

**Architecture:** A Vite + React app in `src/web/`, served on 5173 with `/api` proxied to the Fastify server on 3001. Pure logic (formatting, theme choice, key masking, the API client) lives in `src/web/lib/` with Vitest tests; screens are verified by screenshots taken with `playwright-core` driving the installed Chrome. No router or state library: a 20-line `history` router and React state, refetching after each mutation.

**Tech Stack:** React 19, Vite 8, TypeScript 7, `@fontsource/nunito`, `playwright-core` (screenshots only), Vitest.

**Spec:** [docs/superpowers/specs/2026-10-25-frontend-design.md](../specs/2026-10-25-frontend-design.md): Vocabulary, Visual system, Screens (Welcome, Projects screen), Panels and dialogs (API key panel, Dialogs)

## Global Constraints

- The UI says **Goal** for a study ("3 goals", "Add a new goal", "Delete this goal?"); code and API keep `study`.
- Tokens are CSS custom properties on `:root`, dark values under `[data-theme="dark"]`; the theme follows the OS until the ☾/☀ toggle sets `localStorage['maptutor.theme']`.
- Nunito 400/600/700/800 from `@fontsource/nunito`, nothing loaded from the network.
- The key lives only in `localStorage['maptutor.key']` and goes out as `x-anthropic-key`; nothing else stores it.
- No dimming or blur over content; dialogs use the light wash `rgba(236,239,243,.55)` (dark: `rgba(26,28,33,.55)`).
- Anything that calls Claude without a saved key opens the API key panel instead (Start, add link, Refresh).
- Commits carry no Claude attribution.

## Rulings

- **Mockup values fill gaps the doc leaves:** surface radius 14px, sidebar row radius 8px, field border `#D9DDE3`, row separators `#F0F1F4`, badge colors PDF `#E5484D`, MD/TXT `#7C66DC`, IMG `#2BA5A0`, URL `#2F7DF6` (from `project-page-v2.html`, `key-v4.html`, `newproj.html`).
- **Dark values (my call, doc allows):** `accent-tint rgba(76,141,255,.16)`, `danger #FF6369`, `error-text #FF6B70`, `ok-text #3FC383`, separators `rgba(255,255,255,.06)`, field border `rgba(255,255,255,.14)`.
- **Welcome dismissal is remembered** in `localStorage['maptutor.welcomeDismissed']` (my call; the doc says "dismisses it").
- **`/` opens the newest project** when there is one (my call).
- **Dialog copy for goals and files (my call):** "Delete this goal?" / "This removes its map and chats. It can't be undone." and "Delete <name>?" / "This removes it from <project>. It can't be undone."
- **Errors on the project page** (upload too big, link import failed, goal mid-turn) show as one `danger` line under the box they came from (my call).
- **Usage button** arrives in component 11.
- **Start** creates the goal, then navigates to `/goals/:id` with `history.state.firstMessage` = the goal text; the goal screen (component 9) sends it.

## Rulings made during the build

- **Key status (Task 2):** the panel re-checks a saved key the first time it opens per page load (a free call), so its status row says something true; other failures show their message there. Cost if wrong: one free request per load.
- **`navigate(path, state?, replace?)` (Task 3):** redirects from `/` and after deleting the open project replace the history entry.
- **New-goal box (Task 3):** Enter starts, Shift+Enter is a new line, matching the composer. Rename and new-project fields cancel on blur when untouched or when the name is unchanged.
- **Badges (Task 4):** `fileBadge` returns CSS variables holding the mockup colors. Link rows show size and **Refresh** (the spec says "also"; the mockup dropped the size).

**Review:** self-review; Review Focus 1 and 3 have tests, 2, 4 and 5 were checked by screenshot. No Critical or Important findings.

## Review Focus

1. **A saved key Anthropic later rejects:** the panel shows "✗ Anthropic rejected this key" after a failed check and keeps the old key until a new one passes. Test in Task 2 (`checkAndSave`).
2. **A project name or file name with HTML or quotes** renders as text. React escapes it; verified by a screenshot with the name `<b>"Calc"</b>` in Task 3.
3. **Dropping several files where one is too big:** the others upload, one error line names the failed file. Test in Task 4 (`uploadAll`).
4. **Deleting the open project** lands on the next project or the first-run screen, never a 404 page. Verified in Task 3.
5. **Long names** (project, goal, file) ellipsize on one line and never push the ✕ or bar off the row. Verified by screenshot in Tasks 3–4.

---

### Task 1: Scaffold, theme, and the screenshot tool

**Files:**
- Create: `vite.config.ts`, `vitest.config.ts`, `src/web/index.html`, `src/web/main.tsx`, `src/web/App.tsx`, `src/web/styles.css`, `src/web/lib/theme.ts`, `src/web/lib/router.ts`, `src/web/components/TopBar.tsx`, `scripts/shot.ts`
- Modify: `package.json` (deps; scripts `dev:web` = `vite`, `build:web` = `vite build`), `tsconfig.json` (`lib: ["es2023", "dom", "dom.iterable"]`, `jsx: "react-jsx"`, `types: ["node", "vite/client"]`)
- Test: `src/web/lib/theme.test.ts`, `src/web/lib/router.test.ts`

**Interfaces:**
- `type Theme = 'light' | 'dark'`; `resolveTheme(stored: string | null, prefersDark: boolean): Theme`; `useTheme(): [Theme, () => void]` (toggle writes `localStorage['maptutor.theme']` and `document.documentElement.dataset.theme`).
- `type Route = { name: 'projects'; projectId: string | null } | { name: 'goal'; goalId: string }`; `matchRoute(path: string): Route` (`/` and unknown → projects with `null`; `/projects/:id`; `/goals/:id`); `navigate(path: string, state?: object): void`; `useRoute(): Route`.
- `scripts/shot.ts`: `tsx scripts/shot.ts <url> <out.png> [--dark] [--width 1280] [--height 800]` with Chrome via `chromium.launch({ channel: 'chrome' })`; `--dark` sets `colorScheme: 'dark'`.
- `vitest.config.ts` keeps tests rooted at the repo (Vite's `root` is `src/web`).

- [ ] **Step 1: Write the failing tests**

```ts
test('the theme follows the OS until the user picks one', () => {
  expect(resolveTheme(null, false)).toBe('light')
  expect(resolveTheme(null, true)).toBe('dark')
  expect(resolveTheme('light', true)).toBe('light')
  expect(resolveTheme('nonsense', true)).toBe('dark')
})
test('routes match projects and goals', () => {
  expect(matchRoute('/')).toEqual({ name: 'projects', projectId: null })
  expect(matchRoute('/projects/p1')).toEqual({ name: 'projects', projectId: 'p1' })
  expect(matchRoute('/goals/g1')).toEqual({ name: 'goal', goalId: 'g1' })
  expect(matchRoute('/nope/x')).toEqual({ name: 'projects', projectId: null })
})
```

- [ ] **Step 2: Run `npm test`.** Expected: both fail (modules missing).
- [ ] **Step 3: Install** `react react-dom @fontsource/nunito` and dev `vite @vitejs/plugin-react @types/react @types/react-dom playwright-core`; write the configs, `styles.css` (every token in the spec's two theme tables plus the Rulings' dark values; primary, secondary and danger-text buttons; surface card), `theme.ts`, `router.ts`, and an `App` that renders the `TopBar` (wordmark left, theme toggle right) over the routed page.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: all pass.
- [ ] **Step 5: Screenshot** with `npm run dev:fake` and `npm run dev:web` running: `npx tsx scripts/shot.ts http://localhost:5173/ shots/shell.png` and with `--dark`. Expected: `bg` page, Nunito wordmark, ☾ (light) / ☀ (dark). `shots/` is git-ignored.
- [ ] **Step 6: Commit** `feat: web app shell with theme`.

### Task 2: API client, welcome page, and the API key panel

**Files:**
- Create: `src/web/lib/api.ts`, `src/web/lib/key.ts`, `src/web/pages/Welcome.tsx`, `src/web/components/KeyPanel.tsx`, `src/web/components/KeyField.tsx`
- Modify: `src/web/App.tsx` (welcome gate, key context), `src/web/components/TopBar.tsx` (⚙ API key)
- Test: `src/web/lib/api.test.ts`, `src/web/lib/key.test.ts`

**Interfaces:**
- `class ApiError extends Error { status: number }`; `api<T>(path: string, init?: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> }): Promise<T>`: sends the saved key as `x-anthropic-key` when there is one, JSON-encodes `json`, returns `undefined` for 204, and throws `ApiError(status, body.message ?? 'Something went wrong.')`.
- `getKey(): string | null`, `saveKey(key: string)`, `removeKey()`, `maskKey(key: string): string` (`sk-ant-` + `•••••••` + last 4).
- `checkAndSave(key: string): Promise<boolean>`: `POST /api/key/check` with that key; saves only on 204.
- `useApp(): { key: string | null; setKey(k: string | null): void; openKeyPanel(): void }` (React context from `App`).

- [ ] **Step 1: Write the failing tests** (`fetch` stubbed with `vi.stubGlobal`, `localStorage` with a `Map`-backed stub)

```ts
test('api sends the saved key and maps server errors')     // header present; 409 { message: 'The tutor is still replying.' } → ApiError(409, that)
test('api returns undefined for 204')
test('maskKey keeps the prefix and the last four')         // 'sk-ant-api03-abcdefa1B2' → 'sk-ant-•••••••a1B2'
test('checkAndSave keeps the old key when the new one is rejected') // Review Focus 1: 401 → false, getKey() unchanged
```

- [ ] **Step 2: Run `npm test`.** Expected: the four fail.
- [ ] **Step 3: Implement** the modules, then the screens from the spec text: Welcome (title, body, **Get a key →** to `https://console.anthropic.com/settings/keys`, monospace field with Show/Hide inside, **Look around first** / **Save**, rejected message in the footer's left slot), and the popover under ⚙ API key (title row with **Remove**, masked field editable in place, status row with **Save** only after an edit). Save runs `checkAndSave`. Popover closes on outside click and Esc.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: all pass.
- [ ] **Step 5: Screenshot** the welcome page (fresh profile) and the panel open with a saved key, light and dark. Expected: matches the spec text; no blur behind.
- [ ] **Step 6: Commit** `feat: welcome page and API key panel`.

### Task 3: Projects sidebar, project page, goals, and dialogs

**Files:**
- Create: `src/web/lib/format.ts`, `src/web/pages/Projects.tsx`, `src/web/components/Sidebar.tsx`, `src/web/components/ProjectPage.tsx`, `src/web/components/Goals.tsx`, `src/web/components/MasteryBar.tsx`, `src/web/components/Dialog.tsx`
- Test: `src/web/lib/format.test.ts`

**Interfaces:**
- `countLabel(n: number, noun: 'goal' | 'file'): string` → `no files`, `1 goal`, `3 goals`.
- `goalName(s: { title: string | null; goal: string }): string` → title, else goal.
- `phaseLabel(phase): { text: string; done: boolean }` → `Probe` / `Plan` / `Teach` / `Done ✓`.
- `masterySegments(counts: Record<State, number>): { state: State; count: number }[]` in order known, frontier, missed, untested, zero counts dropped.
- `ConfirmDialog({ title, body, onCancel, onConfirm, error? })`: Cancel (secondary), Delete (danger pill).
- `MasteryBar({ counts, width })`: segments with 2px gaps, rounded, 6px high (empty gray track when all zero); component 10 reuses it at 7px for the legend.

- [ ] **Step 1: Write the failing tests**

```ts
test('count labels', () => expect([countLabel(0, 'file'), countLabel(1, 'goal'), countLabel(3, 'goal')]).toEqual(['no files', '1 goal', '3 goals']))
test('goal names fall back to the typed goal')
test('phase labels mark done')
test('mastery segments are ordered and skip empty states') // { untested: 3, missed: 1, frontier: 1, known: 2 } → known 2, frontier 1, missed 1, untested 3
```

- [ ] **Step 2: Run `npm test`.** Expected: the four fail.
- [ ] **Step 3: Implement** the sidebar (header row, **+ New** inline field with "Enter to create · Esc to cancel", rows with counts, raised open row), first-run state, title rename in place ("Enter to save · Esc to cancel"), **Delete project** → dialog with the spec's copy (counts filled in), `ADD A NEW GOAL` box with **Start**, `GOALS` list (name 800 with ellipsis, phase label, 150px bar, ✕ on hover → dialog, click opens `/goals/:id`), "No goals yet. Add one above." After deleting the open project, navigate to the next one in the list or `/`.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: all pass.
- [ ] **Step 5: Screenshot** with seeded data (a script in the scratchpad creates projects through the API, including the name `<b>"Calc"</b>` and an 80-character goal): first run, a project page with goals in every phase, the delete dialog; light and dark. Expected: Review Focus 2, 4, 5 hold.
- [ ] **Step 6: Commit** `feat: projects sidebar and project page`.

### Task 4: Files

**Files:**
- Create: `src/web/components/Files.tsx`
- Modify: `src/web/lib/format.ts`
- Test: `src/web/lib/format.test.ts`, `src/web/lib/api.test.ts`

**Interfaces:**
- `formatBytes(n: number): string` → `12 KB`, `4.2 MB` (KB rounded, MB one decimal; under 1 KB → `1 KB`).
- `fileBadge(f: { kind: 'pdf' | 'image' | 'text' | 'url'; name: string }): { label: 'PDF' | 'MD' | 'TXT' | 'IMG' | 'URL'; color: string }` (`text` → `TXT` for `.txt`, else `MD`).
- `usedLabel(bytes: number): string` → `5.4 of 20 MB used`.
- `uploadAll(projectId: string, files: File[]): Promise<string[]>` (in `api.ts`): uploads in order, returns one error line per failed file, `"<name>: <server message>"`.

- [ ] **Step 1: Write the failing tests**

```ts
test('bytes format as KB or MB')            // 900 → '1 KB', 12_000 → '12 KB', 4_400_000 → '4.2 MB'
test('file badges by kind and extension')    // notes.txt → TXT, notes.md → MD, x.pdf → PDF #E5484D
test('used label')                           // 5_662_310 → '5.4 of 20 MB used'
test('uploadAll keeps going after a failure') // Review Focus 3: second of three gets 413 → one error naming it, three requests made
```

- [ ] **Step 2: Run `npm test`.** Expected: the four fail.
- [ ] **Step 3: Implement** the `FILES` box: rows (badge, name with ellipsis, size; links get **Refresh**; ✕ → dialog), the last row "Drop files here or **browse** · **add link**" with the used label, drag-and-drop over the whole box (a 2px accent ring while dragging, my call), **add link** field with **Add** and **Cancel**, the empty state copy, and errors per the Rulings. `browse` accepts `.pdf,.md,.txt,image/png,image/jpeg,image/gif,image/webp`.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: all pass.
- [ ] **Step 5: Screenshot** a project with one file of each kind plus a long name, and the empty state; light and dark.
- [ ] **Step 6: Update ROADMAP (component 8 done; usage moves to 11) and commit** `feat: project files`.

## Not in this component

The goal screen (9), the map (10), the usage popover and goal-complete polish (11).

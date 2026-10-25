# Frontend design (components 8–11)

The visual and interaction design for MapTutor's web client, settled with the user screen by screen on 2026-10-24/25. Read with [README.md](../../../README.md), [01-user-flow.md](../../../01-user-flow.md), [03-graph.md](../../../03-graph.md) and [05-stack.md](../../../05-stack.md). Where this document and those disagree, this document wins; the "Doc updates" section lists what to change in them.

Mockups from the session live in `.superpowers/brainstorm/3844-1792904533/content/` (not committed). The most useful: `study-v2.html` (goal screen, light), `dark-v3.html` (dark direction, option A), `roadmap-summary.html`, `loop.html` (hover light), `quiz.html` / `quiz-results.html`, `ask-v2.html`, `approve.html`, `key-v4.html`, `usage.html`, `project-page-v2.html`, `newproj.html`, `details-v2.html`, `popout-v2.html`. Where a mockup and this text disagree, the text wins.

## Intent

A calm, friendly study tool for the user and a few friends. The map is the one loud thing on screen: chunky outlined circles in bright state colors, drawn like stickers. Everything around it (chat, panels, buttons) is quiet: white soft-shadow cards on a cool light gray. The user wants to own every visual detail; anything below marked **(my call)** was decided by the designer, not the user, and is open to change.

## Goals, non-goals, anti-goals

- **Goals:** the whole flow in 01-user-flow works from the browser: key setup, projects, files, goals, probe quiz, plan approval, teaching with the map, revisiting nodes, stopping a reply, usage.
- **Non-goals (v1):** mobile layout, accounts, sharing, editing the graph by hand, showing web sources, showing the tutor's thinking.
- **Anti-goals:** dimming or blur "filters" over content (the user rejected a dimmed hover state and a blurred backdrop); dashed or dotted lines on the map; a map that swirls or loops; light-mode-negative dark themes (thick near-white outlines and glaring fills).

## Vocabulary

- The UI calls a study a **Goal** ("3 goals", "Add a new goal", "Delete this goal?"). Code, API and database keep `study` **(my call: renaming code is churn with no user-visible effect)**.
- Phase names shown to the user stay **Probe → Plan → Teach**, plus **Done**.

## Visual system

### Type

Nunito everywhere (UI, graph labels, chat), weights 400/600/700/800. Math uses KaTeX's own fonts. Self-host it (e.g. `@fontsource/nunito`) so the local app works offline **(my call)**.

### Light theme (default when the OS is light)

| Token | Value | Use |
|---|---|---|
| `bg` | `#ECEFF3` | Page, graph pane, chat pane, top bar |
| `surface` | `#FFFFFF` | Tutor messages, cards, buttons, composer, legend, zoom controls, hover card, popovers, dialogs |
| `ink` | `#25282E` | Text; graph outlines, lines, arrowheads, root rings; graph labels |
| `muted` | `#6B717C` | Secondary text (back link, inactive phase steps, meta lines) |
| `divider` | `rgba(37,40,46,.09)` | Top bar and chat header bottom borders, pane divider |
| `accent` | `#2F7DF6` | User bubbles, primary buttons (Send, Stop, Save, Start, Approve, Next/Submit, Create), current phase dot, links, focus |
| `accent-tint` | `#EAF2FE` | Selected option rows, chosen answer in an answered question card |
| `danger` | `#E5484D` | Delete buttons, "Remove", "Delete project", "✗ Anthropic rejected this key" |
| `error-text` | `#B4232A` | Errors in the chat |
| `ok-text` | `#1F9D5C` | "✓ Key accepted by Anthropic", "Done ✓" |
| Card shadow | `0 4px 16px rgba(37,40,46,.08)` | Messages, cards |
| Button shadow | `0 2px 8px rgba(37,40,46,.14)` | Secondary pill buttons |
| Popover shadow | `0 8px 30px rgba(37,40,46,.14)` | Hover card, usage and key popovers |

### Node state colors (identical in both themes)

| State | Fill |
|---|---|
| Known | `#3FC383` |
| Frontier | `#FFB020` |
| Missed | `#FF5A5F` |
| Untested | `#C5CBD3` |

Quiz result marks reuse Known green and Missed red (tints `#E6F7EE` / `#FFEBEC` behind the marked rows).

### Dark theme

Follows the OS by default; a ☾/☀ toggle in the top bar overrides it and is remembered in `localStorage`. The user chose the first dark attempt ("before") with gray graph lines, not the VS Code palettes.

| Token | Value |
|---|---|
| `bg` | `#1A1C21` |
| `surface` | `#262930` |
| `text` | `#E8EAEE` |
| `muted` | `rgba(232,234,238,.6)` |
| `divider` | `rgba(255,255,255,.09)` |
| `accent` | `#4C8DFF` |
| Graph outlines, lines, arrowheads, root rings | `#9A9DA3` |
| Shadows | `rgba(0,0,0,.35)` |
| Node fills | same as light |
| Node labels | `#FFFFFF` with a thin dark edge (`paint-order: stroke; stroke: rgba(0,0,0,.45); stroke-width: 3px`) |

Light-mode node labels stay charcoal (`ink`), no edge. Dark values for `accent-tint`, `danger`, `error-text` and `ok-text` are **(my call)**: pick lighter variants that pass contrast on `#1A1C21`/`#262930` (e.g. error `#FF6B70`, tint `rgba(76,141,255,.16)`).

### Buttons

- **Primary:** accent pill, white 800-weight text.
- **Secondary:** surface pill with the button shadow.
- **Danger text actions** ("Remove", "Delete project"): plain `danger` text, no pill, clickable.
- **Dialog destructive button:** `danger` pill.

## Screens

### Welcome (no key saved)

Its own page: `bg`, "MapTutor" wordmark top center, one centered surface card:

- Title **Bring your own key**
- Body: "MapTutor talks to Claude using your Anthropic API key. It's saved only in this browser and passed to Anthropic with each request, never stored on the server." + **Get a key →** (links to the Anthropic console)
- Key field (`sk-ant-…`, monospace) with a **Show / Hide** toggle inside it on the right
- Footer: **Look around first** (muted text, left) and **Save** (primary, right) **(my call: "Save", matching the key panel; the mockup said "Save key")**
- Saving runs the key check (see Backend changes). Rejected → "✗ Anthropic rejected this key" in the footer's left slot, key not saved. Accepted → saved to `localStorage`, go to the projects screen.
- **Look around first** dismisses it. Trying to send anything to the tutor without a key opens the API key panel.

### Projects screen (sidebar + project page)

Top bar: **MapTutor** wordmark left; **Usage** (project totals), **⚙ API key**, theme toggle right.

**Sidebar** (≈220px, left, divider on its right):

- Header row: `PROJECTS` (small caps, muted) and **+ New** (accent text).
- **+ New** puts a name field at the top of the list ("Enter to create · Esc to cancel"); Enter creates the project and opens it.
- Each item: project name, then "3 goals · 4 files" in muted text. The open project is a raised white row.

**Project page** (the rest), two columns (≈1.5 : 1):

- **Title row:** project name (22px, 800). Clicking it edits in place ("Enter to save · Esc to cancel"). **Delete project** (danger text) on the right → dialog.
- **Left column:**
  - `ADD A NEW GOAL` header, then a surface box with a textarea ("What do you want to learn? e.g. "help me study for the midterm"") and a **Start** button. No search setting. Start creates the goal and opens the goal screen; the goal text is sent as the first message so the tutor starts right away **(my call)**.
  - `GOALS` header, then a surface list. Each row: goal text (800), phase label (Probe / Plan / Teach in muted; **Done ✓** in `ok-text`), and a 150px mini mastery bar (segments in state colors, 2px gaps, rounded; an empty gray track before the graph exists). Hovering a row shows **✕** at its end → dialog. Clicking a row opens the goal.
- **Right column:** `FILES` header (level with `ADD A NEW GOAL`), then a surface list:
  - Rows: a colored kind badge (PDF red, MD/TXT purple, IMG teal, URL blue), name (ellipsis), size; link rows also get **Refresh** (accent text). **✕** deletes → dialog.
  - Last row: "Drop files here or **browse** · **add link**" with "5.4 of 20 MB used" under it. The whole box accepts dropped files.
  - **add link** opens a URL field in the box with **Add** (primary) and **Cancel**.
- **Empty states:** no goals: "No goals yet. Add one above." No files: "Drop slides, notes or images here, or **browse** · **add link**" and "PDF, images, .md, .txt, links · up to 20 MB per project".

**First run (no projects):** the page area centers "No projects yet" / "A project is a subject and its materials: slides, notes, links. Each one holds as many goals as you like." and a **+ New project** button that opens the sidebar's name field.

### Goal screen

The projects sidebar is hidden; the goal screen is full width.

**Top bar:** **← Calculus 101** (muted, back to the project page) and the goal text (17px, 800) on the left; phase steps in the middle; **Usage** (goal totals), **⚙ API key**, theme toggle on the right.

**Phase steps:** `Probe — Plan — Teach — Done` with short connector lines; past and future steps muted, the current one in `ink` with an accent dot. **(my call: Done is a fourth step that lights with ✓ when reached.)**

**Body:** graph pane left, chat pane right, starting 50/50, with a draggable divider whose position is remembered (`localStorage`).

## The map (graph pane)

### Layout

- dagre, **top to bottom**: roots at the top, goal at the bottom. Nodes in a rank sit in tidy rows, evenly spaced.
- Re-layout only when the graph is (re)proposed; state changes recolor in place.
- Opens fitted to the pane. Scroll or pinch to zoom, drag to pan, and **+ / − / fit** buttons stacked bottom right (surface, soft shadow).

### Nodes

- **Circles**, all the same size (radius ≈52 at 1:1), `ink` outline 4px, flat state fill.
- **Label inside**, Nunito 700 15px, centered. Long labels wrap to up to 3 lines at a smaller size (≈13px) and are cut with "…" after that; the full label is in the hover card.
- **Roots:** a second outline ring ≈9px outside the circle (3px stroke).
- **Goal:** larger (radius ≈64) with a 6px outline and a 17px label.
- **Being taught** (`focusNodeId`): ripples, two rings in the node's fill color expanding to ~1.7× and fading, 2.4s loop, staggered by half. Reduced motion: a still halo.
- **Open** (its chat is showing): **pops out toward you**. It scales to **1.2×** around its center with a springy overshoot (≈0.38s, `cubic-bezier(.34,1.56,.64,1)`), and a soft blurred shadow grows under it (`drop-shadow(0 12px 14px rgba(37,40,46,.28))`; a darker equivalent in dark mode). The node it replaces settles back the same way. No offset shadow. A node can be both rippling and popped out (the ripple scales with it). Reduced motion: the scale and shadow change instantly **(my call)**.
- **State change:** the fill fades to the new color over ~0.5s and the node does one small bounce.

### Lines

Solid, `ink` 4px, round caps, gentle bezier curves from the bottom of the prerequisite to the top of the dependent, small solid arrowheads at the dependent end. No dashes.

### Hover

- **Traveling light:** hovering a node sends a short white light along every line in its ancestor subgraph, toward the hovered node. It relays: lines nearest the roots run first, the lines into the hovered node run last, and then it starts over immediately (continuous, no pause). About **0.45s per line**. Branches of different lengths are timed so every branch reaches the hovered node together: a line whose end is *k* steps from the hovered node starts at `(L − 1 − k) × 0.45s` in an `L × 0.45s` cycle, where *L* is the longest chain. No glow, no dimming, nothing else changes. Reduced motion: no light **(my call)**.
- **Hover card** (soft style: white, no outline, blurred shadow, beside the node **(my call: placement)**): full label (800), description, "What you established" + summary when the node has one, and the quiz evidence as dots (green right, red wrong) + "3/4 correct". The node has no quiz yet → "No quiz yet" **(my call)**.

### Legend

Bottom left, surface card: a slim (≈7px) segmented progress bar in state colors sized by node counts, and under it one line of key: "● Known 2 ● Frontier 1 ● Missed 1 ● Untested 3".

### Clicking a node

Opens its thread in the chat (the node pops out). Before approval node threads don't exist; clicking does nothing but show the hover card **(my call)**. Just opening a thread doesn't move the ripple; it moves when the turn in that thread starts (the server sets `focusNodeId`).

**An untaught node starts itself (user's choice):** opening a node whose thread is empty (by clicking it, **Continue anyway**, or **Go to …**) starts a turn without a visible user message: the server appends a hidden `[App: …]` note telling the tutor the user opened this node, and the tutor begins the lesson. A node with history just shows its thread. See Backend changes #10.

**Which thread a goal opens on (my call):** in Teach/Done, the thread of `focusNodeId` if set, else the main chat. In Probe/Plan, the main chat.

**Prerequisite warning:** if the node has weak ancestors (`GET …/prerequisites`), the chat switches to that node and, in place of the conversation, shows a surface card: "**These prerequisites aren't solid yet:** Continuity (missed), Slope (frontier)." with **Go to Continuity** (primary, `weak[0]`) and **Continue anyway** (secondary), and "Derivative's chat opens when you continue." under it. The message box is paused while it shows.

### Before the graph exists

The pane shows, top left: **Finding your edge** / "Your map appears once the tutor proposes a plan." and one row per probed strand: name, a right/wrong bar (green for correct, red for wrong, proportional), and "2/4". Before the first quiz: "The tutor is settling your goal." **(my call: wording)**

### Goal complete

When the goal node turns Known: one burst of confetti (state colors and accent) over the graph, plus the "Goal complete" card in the chat.

## Chat (right pane)

- **Header:** the thread's name (the node's label, or **Main chat**), 16px 800; a **Main chat** secondary button on the right, hidden while in the main chat.
- **Tutor messages:** surface cards, left-aligned, rounded with a small bottom-left corner, card shadow. Markdown + KaTeX + GFM. Styling for headings, lists, code, and tables inside them is the builder's call within the tokens.
- **User messages:** accent bubbles, white text, right-aligned, small bottom-right corner.
- **Composer:** pinned at the bottom, surface, rounded, card shadow; placeholder "Message the tutor…"; Enter sends, Shift+Enter is a new line **(my call)**; **Send** (primary) on the right.
- **While the tutor works:** Send becomes **Stop** (primary, accent, with a small square icon). You can keep typing; a message sent meanwhile goes once the reply finishes.
- **Waiting indicator:** until the first text arrives, a tutor card shows a spinner and "Thinking · 14s" or "Searching the web · 22s", with a running timer. Text then streams in live.
- **While a card awaits an answer:** the composer is paused and reads "Answer the card above to continue".
- **Errors:** red `error-text` in plain words where the reply would have been, no bubble, ending with a **Retry** link (e.g. "⚠ Your Anthropic API key was rejected. Check it under API key." with "API key" opening the panel). Retry re-runs the reply from the thread as it stands; your message is never sent twice (Backend changes #11). The error and its Retry live only in the open page; after a reload the thread just ends with your message, and sending anything continues it **(my call, revised while planning: the server can't tell a failed thread from one the tutor left on purpose by switching nodes)**.
- **Node switch mid-reply** (`focus` event): the chat follows into that node's thread automatically and that node pops out on the graph.
- **Sources:** hidden. Thinking: never shown.
- Auto-scroll follows streaming text unless the user has scrolled up **(my call)**.

## Cards in the chat

All cards are surface cards with the card shadow, consistent with tutor messages.

### Quiz (`quiz`)

- **One question per page.** Header: "QUESTION 2 OF 3" (small caps, muted) and progress dots (accent for answered).
- Prompt (700), then **lettered rows**: outlined rows with an A–D circle badge; selected = 2px accent border, `accent-tint` fill, filled accent badge.
- **Back** (secondary) and **Next** (primary); picking does not advance. The last page shows **Submit answers**.
- Keys: A–D or 1–4 picks, Enter = Next/Submit, Backspace = Back.
- **No hints** (removed from the tool; see Backend changes).
- **After submitting:** the card becomes a summary list. Header "QUIZ · 2 OF 3 CORRECT" with dots (green/red). One row per question with a ✓/✗ mark and the prompt. **Misses open automatically**, showing the options with the right one green-tinted ("Correct") and the wrong pick red-tinted ("Your answer"), the rest faded, and a gray box "**Why:** explanation". Any row expands on click.
- Answered quizzes reload in this summary state.

### Question (`ask_user_question`)

- **Menu list:** the question (800, 16px), then rows of label (700) and optional description (muted), separated by thin dividers, no arrows and no letters. Rows highlight on hover.
- **Single choice:** clicking a row answers immediately.
- **Other:** always the last row, a text field ("Something else…"); a **Send** button appears once you type.
- **Multiple choice:** "Pick any" under the question, checkboxes on each row (Other included), one **Send** at the bottom.
- **After answering:** the card stays; chosen rows are `accent-tint`, the rest faded. A typed answer shows as a chosen row with its text.

### Plan approval (`propose_graph`)

- One card: "PROPOSED PLAN" label, the approach (Markdown), then **Suggest changes** (secondary) and **Approve plan** (primary).
- **Suggest changes** opens a text box inside the card with **Send**.
- After answering, the card stays, marked "Approved" or showing "You asked for changes: …" **(my call: exact wording)**.
- The proposed map shows in the graph pane at the same time.

### Goal complete

A card after the tutor's last message: "Goal complete" (17px, 800), "7 of 7 known", and a full green bar. Nothing else.

## Panels and dialogs

### API key panel (top bar ⚙ API key)

A popover under the button:

- Title row: **API key** (left), **Remove** (danger text, clickable) (right).
- The key field, masked (`sk-ant-•••••••a1B2`), with a **Show / Hide** toggle inside it on the right. You edit the key right in the field.
- Status row: on the left, "✓ Key accepted by Anthropic" (`ok-text`) or "✗ Anthropic rejected this key" (`danger`); on the right, **Save** (primary) **only after the field is edited**, otherwise nothing. No Replace button.

### Usage popover (top bar Usage)

"Usage for this goal" (or "for this project" on the projects screen):

- A big headline total ("1.30M tokens": input + output + cache read + cache write across all models) and "6 web searches" under it.
- One block per model: name, then Input, Output, Cached (read + write), Searches (only when non-zero), with rounded figures (48.2k, 1.20M).
- Tokens only, no money.
- Model names come from the model ID ("Opus 5.5", "Haiku 5.5"; unknown IDs as-is) **(my call; usage is grouped by model, not by purpose, so don't label Haiku as "Summaries" on the project view where it also covers link imports)**.

### Dialogs

Centered surface card over a light wash (`rgba(236,239,243,.55)` in light; a dark equivalent in dark), never a blur. Title, a sentence saying exactly what goes, **Cancel** (secondary) and **Delete** (danger). Used for deleting a project ("Delete Calculus 101? This removes its 3 goals, their maps and chats, and its 4 files. It can't be undone."), a goal, or a file.

## Backend changes this design needs

Each is small; do them test-first like the earlier components.

1. **Remove quiz hints:** the `hint` property from the `quiz` tool schema and its validation, the card output, the insert, the `quiz_items.hint` column, and the tests and docs that mention it.
2. **Remove the web search cap:** `studies.search_cap`, the `searchCap` request field and response field, `WEB_SEARCH_MAX_USES`, and `max_uses` on the web search tool (the model decides how much to search).
3. **Status events:** an SSE `status { kind: 'thinking' | 'searching' }` when a thinking block or a `web_search` server tool use starts streaming. The timer runs on the client.
4. **Stop:** `POST /api/studies/:id/stop` cancels the running turn (abort the SDK stream). Text streamed so far is saved as a text-only assistant message; the client gets `done`. Verify with the API docs (load the `claude-api` skill) that replaying an assistant turn without its thinking block is accepted; if not, drop the partial text instead. Usage for a stopped call is partial (whatever the stream reported); record what's available.
5. **Key check:** a route (e.g. `POST /api/key/check` with the `x-anthropic-key` header) that makes a free call (e.g. list models) and returns ok or 401.
6. **Delete a goal:** `DELETE /api/studies/:id` (cascades). Reject with 409 while a turn is running in it.
7. **Rename a project:** `PATCH /api/projects/:id { name }`.
8. **Project list counts:** `GET /api/projects` adds `goalCount` and `fileCount` per project.
9. **Prompt (app appendix):**
   - **Files first:** "The project files come first. The files at the start of the conversation are the user's own course material. Teach from them: use their definitions, notation, and scope, and treat what they cover as what the user needs. Before searching the web, check whether the files answer it. Search when they don't, or when you doubt a file is correct. If a file disagrees with a reliable source, tell the user rather than silently picking one."
   - **New foundational facts during Teach** are taught inline in the current node's thread (motivate → establish → connect → quiz-check there); there is no `add_node`.
   - **Opened node:** when the turn opens with an app note that the user opened a node, teach that node (focus it first if needed).
   - **Goal title:** once the goal is concrete, call `set_goal_title` with a short title (about 2–6 words).
   - **Short node labels:** `propose_graph`'s `label` description asks for about 3 words, since labels sit inside small circles. Nothing is rejected.
10. **Open an untaught node:** a route (e.g. `POST /api/studies/:id/open { nodeId }`) that, when the node's thread has no messages and no turn is running, sets `focus_node_id`, appends a hidden `[App: The user opened "<label>". Teach it now.]` note with the study state, and streams a turn like `/messages`. With history it does nothing (the client just shows the thread). 409 before approval, like node messages.
11. **Retry:** `POST /api/studies/:id/retry { nodeId? }` re-runs the turn when that thread's last message is a user message (text or tool_result) with no reply and no turn is running; otherwise 409. Same SSE response as `/messages`.
12. **Goal title:** a `studies.title` column (NULL until set) and a `set_goal_title({ title })` server tool allowed in Probe and Plan. The UI shows `title`, falling back to the typed goal text cut with "…". Returned by the study and project endpoints.

## Doc updates

- 01-user-flow: graph/chat split is 50/50 and draggable; Goal vocabulary in the UI; projects list is a sidebar.
- 02-agent: no `hint`; web search uncapped; files-first, teach-inline, opened-node and goal-title rules; `set_goal_title` tool; `status` SSE event; stop, open and retry routes.
- 03-graph: hover traveling light (no dimming); node visuals above.
- 04-data-model: drop `quiz_items.hint`, `studies.search_cap`; add `studies.title`.
- 05-stack: the per-request search cap and its setting are gone; the usage display is tokens only; Nunito.
- ROADMAP: visual design decided (this doc); add the backend changes above to the frontend components or as a component 7b.

## Process

The user wants to see the frontend at the end: build all of components 8–11 with the usual plan → TDD → self-review loop, then show it. No mid-build check-ins unless blocked.

**No live API calls during the build (user's choice).** Build a scripted fake tutor first: a fake `streamMessage` the server uses when an env var is set (e.g. `MAPTUTOR_FAKE_TUTOR=1`). It walks a real goal through `ask_user_question` → probe `quiz` → `propose_graph` → approval → `focus_node` → teaching text → quiz-check → goal Known, streaming text in chunks with delays and emitting the new `status` events, so every screen, card, transition, Stop and Retry can be exercised for free. The key check also needs a fake path in that mode. The first live run happens later, with the user.

## Left to the builder

Component structure, state management, routing, exact spacing and radii beyond the values above, Markdown element styling, focus rings, ARIA roles and keyboard focus order, animation easing details, how the SSE stream is parsed, and how `focus`/`done`/refetch are wired.

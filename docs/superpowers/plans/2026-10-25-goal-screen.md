# Goal Screen (Component 9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The goal screen minus the map: top bar with phase steps, the draggable split, the chat (streaming, Stop, Retry, queued messages, thread switching on `focus`), the quiz, question and plan cards, and the strand panel shown before the map exists.

**Architecture:** `lib/sse.ts` reads the server's SSE over `fetch`. A pure reducer (`lib/turn.ts`) turns SSE events into the live state of one turn; `pages/Goal.tsx` owns the study, the open thread and the turn, and refetches the thread and study at each `card`, `focus` and `done`. Cards are components fed the thread's `card` items; answering one posts `tool-results` and streams the resumed turn the same way a message does. The graph pane shows the strand panel until component 10 adds the map.

**Tech Stack:** React 19, `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex` + `katex`, Vitest, `playwright-core` screenshots against `npm run dev:fake`.

**Spec:** [docs/superpowers/specs/2026-10-25-frontend-design.md](../specs/2026-10-25-frontend-design.md): Goal screen, Before the graph exists, Chat (right pane), Cards in the chat

## Global Constraints

- Every turn route answers SSE and ends with exactly one `done`; the client stops reading at `done`, then refetches the thread and the study.
- Thread items come from `GET /api/studies/:id/thread?nodeId=`; the client never renders app notes or `<study_state>` (the server already hides them).
- Anything that starts a turn without a saved key calls `requireKey()` (opens the API key panel) instead.
- Quiz answers send only `{ choices: { [itemId]: optionId } }`; grading is the server's.
- No hints on quiz cards; sources and thinking are never shown.
- Commits carry no Claude attribution.

## Rulings

- **Live text across steps:** a `status` event that arrives after text has streamed starts a new tutor card (and refetches the thread), so step texts don't run together. A step with no thinking block can still glue until `done` refetches. Cost if wrong: brief visual join.
- **Waiting timer** counts from the start of the current waiting card, not per status (my call).
- **Queued message:** sent when the turn ends with `awaiting: false`; if a card is waiting, it goes back into the composer (my call).
- **Thread on open (spec's "my call"):** Teach/Done open `focusNodeId`'s thread when set, else the main chat; Probe/Plan open the main chat. A `focus` event switches the open thread.
- **First message:** `history.state.firstMessage` is sent once when the main thread is empty, then cleared with `replaceState`.
- **Errors** render as the spec says; `Your Anthropic API key was rejected.` becomes "⚠ Your Anthropic API key was rejected. Check it under **API key**." with the link opening the panel and also marks the key rejected in the panel's status.
- **Divider** position is a percentage in `localStorage['maptutor.split']`, clamped to 25–75 (my call).
- **Quiz card markdown:** prompts, options and explanations render through the same Markdown component (math in options is common).

## Rulings made during the build

- **Fake `[fail]` (Task 2):** a user message containing `[fail]` makes the fake tutor fail once (529 overloaded), so the error line and Retry can be tried without Claude. Dev-only, tested.
- **Plain-word API errors (Task 2):** `anthropicError` now says "Anthropic is overloaded right now…" / "…rate-limiting your key…" or the API's inner message, instead of the SDK's raw JSON.
- **Absolute segment indexes (Task 2):** the turn state gained `dropped` and `committed` so overlapping refetches each drop exactly what they saw stored.
- **Quiz keys (Task 3):** A–F / 1–6, since the tool allows six options.
- **One-line display math (Task 3):** a line holding only `$$…$$` is rewritten to block form before rendering; remark-math renders it inline otherwise. Its test was written after the code, then mutation-checked.
- **Plan outcome (Task 3):** "✓ Approved" in `ok-text`.

**Review:** self-review; each Review Focus line has a test. No Critical or Important findings.

## Review Focus

1. **Stop pressed before any text:** the waiting card disappears, no empty tutor card is left, Send returns. Test in Task 2 (`turnReducer` on `done` with no text).
2. **A turn that pauses on a card after streaming text:** the text stays above the card and the composer pauses. Test in Task 2 (card event refetch flag) and screenshot in Task 4.
3. **Pressing Enter twice fast on the composer:** one message is sent, the second press queues nothing empty. Test in Task 2 (`turnReducer` ignores `send` while starting); covered by the `running` guard.
4. **Keyboard quiz input while typing in the composer:** A–D keys go to the quiz only when focus isn't in a text field. Test in Task 3 (`quizKey` ignores events from inputs).
5. **A quiz reloaded after answering:** renders the summary from `answer.results` and the unlocked items, misses open. Test in Task 3 (`quizSummary`).

---

### Task 1: Goal screen frame: top bar, phase steps, split, strand panel

**Files:**
- Create: `src/web/pages/Goal.tsx`, `src/web/components/PhaseSteps.tsx`, `src/web/components/SplitPane.tsx`, `src/web/components/StrandPanel.tsx`
- Modify: `src/web/App.tsx` (goal route), `src/web/lib/api.ts` (types `Study`, `StudyNode`, `Edge`, `Strand`, `ThreadItem`, `Card`)
- Test: `src/web/lib/format.test.ts`

**Interfaces:**
- `type Study = { id; projectId; goal; title: string | null; phase: Phase; approach: string | null; focusNodeId: string | null; nodes: StudyNode[]; edges: { from: string; to: string }[]; strands: Strand[]; usage: Usage }`; `type StudyNode = { id; label; kind: 'root' | 'derived' | 'goal'; description; strands: string[]; state: NodeState; everKnown: boolean; summary: string | null; evidence: { correct: number; total: number } }`; `type Strand = { strand: string; correct: number; total: number }`.
- `type ThreadItem = { type: 'user' | 'assistant'; text: string; createdAt: number } | Card`; `type Card = { type: 'card'; toolUseId: string; name: 'quiz' | 'ask_user_question' | 'propose_graph'; input: any; answer: any; pending: boolean; createdAt: number }`.
- `clampSplit(pct: number): number` (in `format.ts`) → 25–75.
- `PhaseSteps({ phase })`: `Probe — Plan — Teach — Done`, current step in `ink` with an accent dot, Done shows ✓ when reached.

- [ ] **Step 1: Write the failing test** `test('split clamps to 25–75', () => expect([clampSplit(10), clampSplit(50), clampSplit(90)]).toEqual([25, 50, 75]))`
- [ ] **Step 2: Run `npm test`.** Expected: fails.
- [ ] **Step 3: Implement** the page (loads the study and the project's name; top bar with **← <project>**, goal name 17px 800 with ellipsis, steps centered), the split (50/50 default, draggable divider remembered), and the strand panel ("Finding your edge" / "Your map appears once the tutor proposes a plan.", one row per strand with a proportional green/red bar and "2/4"; "The tutor is settling your goal." before any quiz). The chat pane is an empty placeholder in this task.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Screenshot** a probe goal with strands and a plan goal, light and dark.
- [ ] **Step 6: Commit** `feat: goal screen frame`.

### Task 2: Chat: SSE, turns, Stop, Retry, queue, Markdown

**Files:**
- Create: `src/web/lib/sse.ts`, `src/web/lib/turn.ts`, `src/web/components/Chat.tsx`, `src/web/components/Markdown.tsx`
- Modify: `src/web/pages/Goal.tsx`
- Test: `src/web/lib/sse.test.ts`, `src/web/lib/turn.test.ts`

**Interfaces:**
- `parseSse(buffer: string): { events: { event: string; data: any }[]; rest: string }` (frames end with a blank line; a partial frame stays in `rest`).
- `postStream(path: string, json: unknown, onEvent: (e: { event: string; data: any }) => void): Promise<void>`: posts with the saved key; a non-2xx response throws `ApiError`; resolves after `done`.
- `type Turn = { running: boolean; segments: { text: string }[]; status: 'thinking' | 'searching'; waitingSince: number; error: string | null; refetch: number }`; `turnReducer(t: Turn, a: Action): Turn` with actions `start(now)`, `event({ event, data }, now)`, `fail(message)`, `clear()`. `text` appends to the last segment; `status` after text opens a new segment and bumps `refetch`; `card` and `focus` bump `refetch`; `done` sets `running: false` and drops empty segments; `error` sets `error`.
- `errorView(message: string): { text: string; keyLink: boolean }`.
- `Chat({ study, threadId, items, turn, onSend, onStop, onRetry, onMain, cardSlot })`.

- [ ] **Step 1: Write the failing tests**

```ts
test('parseSse handles frames split across chunks')        // 'event: text\ndata: {"delta":"Hi"}\n\nevent: do' → one event, rest 'event: do'
test('text streams into one segment until a status after text opens another')
test('done drops an empty waiting segment')                 // Review Focus 1
test('card and focus events ask for a refetch')             // Review Focus 2
test('a rejected key gets the API key link')                // errorView
```

- [ ] **Step 2: Run `npm test`.** Expected: the five fail.
- [ ] **Step 3: Implement** the modules and the chat pane: header (thread name, **Main chat** secondary button outside the main chat), tutor cards (surface, radius `14px 14px 14px 4px`, card shadow) and user bubbles (accent, radius `16px 16px 4px 16px`), Markdown with KaTeX and GFM (tables, code, lists styled within the tokens), the waiting card (spinner + "Thinking · 14s" / "Searching the web · 22s"), errors with **Retry**, the composer (placeholder "Message the tutor…", Enter sends, Shift+Enter new line, Send ⇄ Stop with a square icon, queued message per the Rulings, paused with "Answer the card above to continue" while a card waits), auto-scroll unless scrolled up, first message per the Rulings, and `focus` switching the open thread.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Smoke in Chrome** against `dev:fake`: send a message, watch the waiting card, text streaming, a question card arriving; press Stop mid-text on a second turn. Screenshot each, light and dark.
- [ ] **Step 6: Commit** `feat: chat with streaming, stop, and retry`.

### Task 3: Cards: quiz, question, plan approval

**Files:**
- Create: `src/web/lib/cards.ts`, `src/web/components/QuizCard.tsx`, `src/web/components/QuestionCard.tsx`, `src/web/components/PlanCard.tsx`
- Modify: `src/web/components/Chat.tsx`, `src/web/pages/Goal.tsx`
- Test: `src/web/lib/cards.test.ts`

**Interfaces:**
- `quizKey(e: { key: string; target: { tagName?: string; isContentEditable?: boolean } }, optionCount: number): number | 'next' | 'back' | null`: A–D / 1–4 → index (only below `optionCount`), Enter → `'next'`, Backspace → `'back'`; `null` when the target is an `INPUT`, `TEXTAREA` or editable.
- `quizSummary(card: Card): { correct: number; total: number; rows: { item; chosen: string; right: boolean }[] }`.
- `questionAnswer(labels: string[], other: string): { answers: string[] }` (trims, drops blanks, typed text last).
- Each card takes `{ card: Card; onAnswer(answer: unknown): void; disabled: boolean }`.

- [ ] **Step 1: Write the failing tests**

```ts
test('quiz keys pick, advance and go back, but not from text fields') // Review Focus 4
test('quiz summary counts results and pairs each item with its pick') // Review Focus 5
test('question answers keep labels and typed text')
```

- [ ] **Step 2: Run `npm test`.** Expected: the three fail.
- [ ] **Step 3: Implement** the three cards exactly as the spec's "Cards in the chat" section describes (quiz paging with "QUESTION 2 OF 3", dots, lettered rows, Back/Next/Submit answers, summary with misses open; question menu with single/multi/Other; plan card with **Suggest changes** / **Approve plan**, "Approved" or "You asked for changes: …" after). Answering calls `onAnswer`, which posts `tool-results` and streams.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Walk the fake flow in Chrome** to approval: question → quiz (pages, then summary with a miss) → plan (feedback, then approve). Screenshot each card pending and answered, light and dark.
- [ ] **Step 6: Update ROADMAP (component 9 done) and commit** `feat: quiz, question, and plan cards`.

## Not in this component

The map, node clicks, the prerequisite banner and opening untaught nodes (10); usage and goal-complete (11).

# User flow

## Why

- **Goal before the quiz.** Which strands are worth probing depends on what the user is trying to learn, so the goal is settled first.
- **Approval before teaching.** A wrong root or a wrong scope is cheap to fix before teaching starts and expensive to fix mid-lesson.
- **Free navigation with warnings.** The user stays in control, but weak prerequisites are made visible instead of silently skipped.
- **Split pane.** The graph is the map of the whole study. Keeping it visible next to the chat shows where the current lesson sits.

## Screens

The UI says **goal** for what the code and these docs call a study. The visual design is in [the frontend design](docs/superpowers/specs/2026-10-25-frontend-design.md).

1. **Projects screen.** A sidebar lists the projects (**+ New** creates one); the open project's page fills the rest.
   - Goals list: each goal's title (the tutor sets a short one; until then, the typed goal), its phase, and a mastery bar (count of nodes per state).
   - An "Add a new goal" box. This is where the user writes something like "help me study for the midterm"; **Start** opens the goal and sends the text as the first message.
   - Context files: upload or delete PDFs, slides, `.md`/`.txt`, images, and links (with Refresh).
2. **Goal screen.** A split pane, 50/50 at first and draggable.
   - **Left: the map.** Nodes are colored by state, and the node being taught ripples. Hovering a node shows its description, summary, and quiz evidence. Clicking a node opens its thread, and a light runs along the lines into it from its prerequisites.
   - **Right: the chat** for the selected thread. Quiz, question, and plan cards render inline.
   - **Top bar:** back to the project, the goal's title, the phase steps (Probe → Plan → Teach → Done), **Usage**, and the theme toggle. The chat header names the open thread.

Before the graph exists, the left pane shows the probe strands as they get explored.

## Phases

A study moves through `probe → plan → teach → done`. The phase is stored on the study, and the server enforces it: teaching tools are rejected before the plan is approved.

### 1. Probe

1. **Goal first.** The tutor calls `ask_user_question` until the goal is concrete. This comes first because the strands to probe depend on the goal.
2. **Draft strands.** The tutor drafts a rough list of prerequisite strands from the goal and the context files.
3. **Edge-finding quiz.** The tutor runs a `quiz` where every item is tagged with a strand.
   - For each strand it needs a floor (something answered correctly) and a ceiling (a miss or a "don't know").
   - When the user gets questions right, it escalates sharply. When the user misses, it narrows in to locate the edge.
   - A single miss is followed up to tell a slip apart from a misconception.
4. **Probe ends** when every strand the goal depends on has both a floor and a ceiling. The tutor then moves to Plan.

All probe messages live in the study's main thread (`nodeId = null`).

### 2. Plan

1. **Scoping search.** The tutor runs a web search to check the field's core concepts and real first principles (see [02-agent.md](02-agent.md#verification)).
2. **Graph proposal.** The tutor calls `propose_graph` with its approach in prose and the graph. The approach shows above the approval card, and the graph renders with initial states taken from the probe evidence (see [03-graph.md](03-graph.md#initial-states)).
3. **Approval.** An approval card appears in chat:
   - **Approve plan** moves the study to Teach.
   - **Suggest changes** lets the user type changes. The tutor revises and calls `propose_graph` again, which replaces the graph.

### 3. Teach

- **Default path.** The tutor picks the next node (see [03-graph.md](03-graph.md#next-node-selection)), calls `focus_node`, and runs the per-node loop in that node's thread:
  1. **Motivate:** why this node, and why now.
  2. **Establish:** state it plainly if it's an unconditional truth, or derive it with a motivated step, Socratic or expository.
  3. **Connect:** make the dependency edge explicit.
  4. **Quiz-check:** `quiz` items tagged with the `nodeId`. The result drives the node's state.
- **Free navigation.** Clicking any node opens its thread (node threads exist only after approval). If any ancestor isn't Known, a warning banner lists those ancestors with two buttons: **Go to <ancestor>** and **Continue anyway**. A node whose thread is empty starts its lesson by itself, with no visible user message.
- **Revisiting.** A Known node can be reopened at any time. Its thread continues where it left off, and the tutor can review the node or quiz it again.
- **Done.** The study is complete when the goal node is Known: a burst of confetti over the map and a "Goal complete" card. Every node stays reopenable after that.

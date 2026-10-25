# Graph

## Why

**Strands.** The screening quiz is written before the graph exists, so its questions can't reference node IDs. Without some link, a missed question can't be pinned to a node. Strands bridge that gap: they're temporary topic tags on probe questions, and they get mapped onto nodes when the graph is created. Strands are free text, so the mapping only works if names match exactly. The tutor could tag a question "closures" and later write "Closures" on a node, and that node would then wrongly show as untested. `propose_graph` therefore rejects any node strand that wasn't used in the probe.

**Demotion.** A slip on a revisit doesn't erase the fact that the node was learned, so a Known node drops to Frontier, never Missed.

**Guards.** The guards on `set_node_state` keep node colors tied to actual quiz evidence instead of the model's impressions.

## Structure

The graph is a DAG.

- **Roots** are unconditional truths. "Axiom" is reserved for true roots, meaning facts that follow from nothing else.
- **The goal** is the single sink.
- An edge `from → to` means `from` is a prerequisite of `to`.

The graph is stored in the database and is the source of truth. The chat transcript is not.

## States

| State | Color | Meaning |
|---|---|---|
| `untested` | Gray | No evidence yet |
| `missed` | Red | Failed in the probe, or not yet learned after a failed quiz-check |
| `frontier` | Amber | Partial: the edge of understanding is here, or the node slipped after being Known |
| `known` | Green | Passed a quiz-check, or solidly correct in the probe |

Each node keeps an `evidence` list of quiz-item IDs, which the hover tooltip displays.

## Initial states

Initial states are computed by the app when `propose_graph` is approved. For each node, the app pools the probe items whose `strand` is in `node.strands`:

| Probe evidence | Initial state |
|---|---|
| No items | `untested` |
| All items correct | `known` |
| Mix of correct and wrong (the edge was bracketed) | `frontier` |
| All items wrong | `missed` |

The `goal` node always starts as `untested`, unless the probe somehow showed it as fully Known.

Strand names must match the probe tags exactly. `propose_graph` validation enforces this (see [02-agent.md](02-agent.md#validation-on-propose_graph)), so no node can silently end up with zero evidence because of a naming mismatch.

## Transitions during Teach

These are driven by quiz-check results on items tagged with the node's `nodeId`. "Pass" means every item in that quiz call was correct.

| From | Event | To |
|---|---|---|
| `untested`, `missed`, or `frontier` | quiz-check pass | `known` |
| `untested` or `frontier` (never Known before) | quiz-check fail | `missed` |
| `missed` | quiz-check fail | `missed` |
| `known` | quiz-check fail (revisit) | `frontier` (**never red**) |
| `frontier` that was Known before | quiz-check fail | `frontier` |

A node is "Known before" if `node.everKnown = true`. That flag is set the first time the node reaches `known` and is never cleared.

### Guards on `set_node_state`

The tutor may call `set_node_state` to adjust states, for example to mark a node as `frontier` after a conversation shows a gap. The server enforces these rules:

- `→ known` requires a passed quiz-check on that node, newer than its last failure.
- `→ missed` is rejected if `everKnown` is true. Use `frontier` instead.
- Any rejection is returned to the tutor as an error `tool_result`.

## Prerequisite warning

When the user clicks a node `N`:

1. Collect `ancestors(N)` with a reverse BFS over the edges.
2. Filter to ancestors whose state is not `known`.
3. If the list is empty, open the thread.
4. Otherwise, show a banner: "These prerequisites aren't solid yet: A (missed), B (untested)…". It has two buttons:
   - **Continue anyway** opens `N`'s thread. The tutor's context includes the weak ancestors so it can adapt.
   - **Go to <ancestor>** opens the deepest weak ancestor first.

## Next-node selection

The default path, used when the tutor or the user asks "what's next":

1. Candidates are nodes that are not `known` and whose prerequisites are all `known`.
2. Prefer `missed` over `frontier` over `untested`, then shallower depth.
3. The goal node is chosen last.

## Layout and rendering

- **Library:** React Flow with dagre, laid out top to bottom. Roots sit at the top and the goal at the bottom.
- **Re-layout:** only on `propose_graph`. State changes recolor nodes without moving them.
- **Node card:** a short label and a colored fill. Roots get a distinct border so they read as foundations.
- **Current node:** a pulsing outline (respecting `prefers-reduced-motion`).
- **Legend:** a small legend sits in the corner of the pane.
- **Hover tooltip:** description, summary (if Known), and evidence as "3/4 correct".

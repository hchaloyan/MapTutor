# Graph Engine (Component 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pure functions for everything the graph spec decides: `propose_graph` validation, initial states from probe evidence, quiz-check transitions, `set_node_state` guards, the weak-ancestor list for the prerequisite warning, and next-node selection.

**Architecture:** One module, `src/server/graph.ts`, with no DB or HTTP access. Components 5 and 6 load rows, call these functions, and write the results.

**Tech Stack:** TypeScript, Vitest.

**Spec:** [03-graph.md](../../../03-graph.md), [02-agent.md](../../../02-agent.md#validation-on-propose_graph)

## Global Constraints

- An edge `{ from, to }` means `from` is a prerequisite of `to`.
- Depth is the longest path from any root, so every node is deeper than all of its prerequisites. Roots have depth 0.
- Validation error strings go back to the tutor verbatim as the `tool_result` error, so each one names the node or edge it's about.

## Review Focus

1. **Graph with a cycle.** Depth and reachability must not loop forever: validation reports the cycle and skips the other checks. Test in Task 1.
2. **Strand differs only in case** (`Closures` vs `closures`): it's rejected, since the match is exact. Test in Task 1.
3. **Probe items for strands no node uses.** They're ignored, not counted against a node. Test in Task 2.
4. **Weak ancestors reached by two paths.** Each is listed once. Test in Task 2.
5. **Every non-goal node is Known.** The goal is the next node, and `nextNode` returns it. Test in Task 2.

---

### Task 1: Validation and depth

**Files:**
- Create: `src/server/graph.ts`
- Test: `src/server/graph.test.ts`

**Interfaces:**
- Produces:
  - `type NodeKind = 'root' | 'derived' | 'goal'`, `type NodeState = 'untested' | 'missed' | 'frontier' | 'known'`
  - `type GraphNode = { id: string; label: string; kind: NodeKind; description: string; strands: string[] }`, `type Edge = { from: string; to: string }`
  - `validateGraph(nodes: GraphNode[], edges: Edge[], probeStrands: string[]): string[]` returns `[]` when the graph is valid
  - `depths(nodes: { id: string }[], edges: Edge[]): Map<string, number>` (callers guarantee a DAG)
- Error copy, one string per problem:
  - `Duplicate node id "<id>".`
  - `Edge <from> → <to> refers to an unknown node.`
  - `The edges form a cycle through: <ids, comma-separated>.` (validation stops here)
  - `There must be exactly one goal node; found <n>.`
  - `Root "<id>" has a prerequisite; roots can't depend on anything.`
  - `The goal "<id>" can't be a prerequisite of anything.`
  - `Node "<id>" leads nowhere; every node except the goal needs an outgoing edge.`
  - `Node "<id>" is unreachable from every root.`
  - `Node "<id>" uses strand "<s>", which no probe question used. Valid strands: <sorted, comma-separated>.`

- [ ] **Step 1: Write the failing tests**

```ts
// fixture: roots r1, r2 → d1 → goal g; r2 → g. Strands: r1 ['scope'], d1 ['closures'].
test('accepts a valid graph')                         // validateGraph(...) → []
test('reports a cycle and stops')                     // add d2; edges d1→d2, d2→d1 → exactly one error, matching /^The edges form a cycle through: /
test('requires exactly one goal')                     // two goals → 'There must be exactly one goal node; found 2.'
test('rejects a root with a prerequisite')            // edge r1→r2 → includes 'Root "r2" has a prerequisite; roots can\'t depend on anything.'
test('rejects an unreachable node')                   // derived x with only x→g → includes 'Node "x" is unreachable from every root.'
test('rejects a dead end and an outgoing goal edge')  // derived y with r1→y only → 'Node "y" leads nowhere…'; edge g→d1 → goal error (also a cycle? no: use a new derived z, g→z, z→… keep acyclic)
test('rejects unknown nodes and duplicate ids')
test('matches strands exactly and lists the valid ones')
  // probe strands ['closures', 'scope']; d1 strands ['Closures'] →
  // 'Node "d1" uses strand "Closures", which no probe question used. Valid strands: closures, scope.'
test('depth is the longest path from a root')         // r1→a→b, r1→b: depth b = 2
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm test -- graph`
Expected: FAIL, because `./graph` cannot be resolved.

- [ ] **Step 3: Implement**

Use Kahn's algorithm for the topological order. Nodes left over after it runs are the cycle members. Check reachability with a forward BFS from all roots.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test` and `npm run typecheck`
Expected: all pass; typecheck exits 0.

- [ ] **Step 5: Commit**: `feat: graph validation and depth`

### Task 2: States, guards, ancestors, next node

**Files:**
- Modify: `src/server/graph.ts`
- Test: `src/server/graph.test.ts`

**Interfaces:**
- Consumes: `NodeState`, `Edge`, `depths` from Task 1
- Produces:
  - `initialState(node: { kind: NodeKind; strands: string[] }, probe: { strand: string; correct: boolean }[]): NodeState`
    - Pool the items whose strand is in `node.strands`.
    - None → `untested`. All correct → `known`. All wrong → `missed`. A mix → `frontier`.
    - The goal is `known` only when its pooled items are all correct; otherwise it's `untested`.
  - `afterQuizCheck(state: NodeState, everKnown: boolean, passed: boolean): NodeState`
    - A pass gives `known`.
    - A fail gives `frontier` if `everKnown`, else `missed`. That's the whole transition table: Known never goes red.
  - `checkSetState(node: { state: NodeState; everKnown: boolean }, target: NodeState, checks: { passed: boolean; at: number }[]): string | null` returns an error string, or `null` when allowed. `checks` are this node's quiz-check calls.
    - `→ known` without a pass newer than the newest fail: `A node can only become known after a passed quiz-check that is newer than its last failure.`
    - `→ missed` when `everKnown`: `This node was known before, so it can't go back to missed; use frontier.`
    - `→ untested`: `Untested means no evidence, so it can't be set.`
  - `weakAncestors(nodeId: string, nodes: { id: string; state: NodeState }[], edges: Edge[]): { id: string; state: NodeState }[]`
    - Ancestors (reverse BFS) that aren't `known`, each listed once.
    - Sorted shallowest depth first, so `[0]` is the "Go to" target (the most foundational weak prerequisite).
  - `nextNode(nodes: { id: string; kind: NodeKind; state: NodeState }[], edges: Edge[]): string | null`
    - Candidates are non-`known` nodes whose prerequisites are all `known`.
    - Rank by state (missed < frontier < untested), then by depth, then by input order.
    - The goal is picked only when no other candidate exists. Returns `null` when every node is known.

- [ ] **Step 1: Write the failing tests**

```ts
test.each([
  [[], 'untested'], [[true, true], 'known'], [[true, false], 'frontier'], [[false, false], 'missed'],
])('initial state from probe evidence %j → %s')
test('the goal starts untested unless fully correct')    // goal + [true,false] → 'untested'; goal + [true] → 'known'
test('ignores probe items for other strands')            // node strands ['a']; items strand 'b' wrong → 'untested'
test.each([
  ['untested', false, true, 'known'], ['missed', false, true, 'known'], ['frontier', true, true, 'known'],
  ['untested', false, false, 'missed'], ['frontier', false, false, 'missed'], ['missed', false, false, 'missed'],
  ['known', true, false, 'frontier'], ['frontier', true, false, 'frontier'],
])('%s (everKnown %s) after a check that passed=%s → %s')
test('known needs a pass newer than the last failure')   // [] → error; [{pass,1},{fail,2}] → error; [{fail,1},{pass,2}] → null
test('a node that was known can never be set to missed') // everKnown → missed error; frontier → null
test('untested cannot be set')
test('weak ancestors are deduplicated and most foundational first')
  // r(known) → a(missed) → c ; r → b(untested) → c ; a → b ; target N with c(frontier) → N
  // → [{a, missed}, {b, untested}, {c, frontier}]
test('no weak ancestors when every prerequisite is known')
test('next node prefers missed, then frontier, then untested') // three ready nodes → missed one
test('next node prefers shallower nodes within a state')
test('next node skips nodes with prerequisites that are not known')
test('the goal comes last, and null when everything is known')
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm test -- graph`
Expected: the new tests FAIL on missing exports; the Task 1 tests still pass.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test` and `npm run typecheck`
Expected: all pass; typecheck exits 0.

- [ ] **Step 5: Commit**: `feat: graph states, guards, ancestors, next node`

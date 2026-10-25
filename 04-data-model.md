# Data model

The schema is SQLite-flavored. IDs are text UUIDs. JSON columns hold small structured blobs.

## Why

The model's conversation is not where state lives, so the database is the single source of truth for the graph, node states, and quiz evidence. Three schema choices follow from that:

- **Per-node threads.** `messages.node_id` puts each node's conversation in its own thread, so a request can load one node's history without the others.
- **Probe-to-node mapping.** `quiz_items.strand` and `nodes.strands` carry the link between probe questions and nodes.
- **Evidence derived at read time.** Node evidence is computed from `quiz_items` when it's read, so it can never drift out of sync with the quiz results.

```sql
-- Single implicit user in v1. The table exists so accounts can slot in later.
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE files (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('pdf','image','text','url')),
  name        TEXT NOT NULL,
  data        BLOB,          -- file bytes (pdf/image); NULL for text/url
  url         TEXT,          -- source URL for imported files
  text_cache  TEXT,          -- extracted text for text/url; NULL for pdf/image (sent natively)
  created_at  INTEGER NOT NULL
);

CREATE TABLE studies (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  goal        TEXT NOT NULL,             -- what the user typed
  title       TEXT,                      -- short name from set_goal_title; NULL until set
  phase       TEXT NOT NULL CHECK (phase IN ('probe','plan','teach','done')),
  approach    TEXT,                      -- prose plan from the approved propose_graph
  focus_node_id TEXT,                    -- the node being taught; set by focus_node or by opening its thread
  session_id  TEXT,                      -- Agent SDK session of the main thread; NULL until its first hop
  created_at  INTEGER NOT NULL
);

CREATE TABLE nodes (
  id          TEXT NOT NULL,             -- chosen by the tutor, unique within the study
  study_id    TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('root','derived','goal')),
  description TEXT NOT NULL,
  strands     TEXT NOT NULL DEFAULT '[]',   -- JSON string[] of probe strands
  state       TEXT NOT NULL CHECK (state IN ('untested','missed','frontier','known')),
  ever_known  INTEGER NOT NULL DEFAULT 0,   -- set once, never cleared
  summary     TEXT,                         -- written when first Known
  session_id  TEXT,                         -- Agent SDK session of this node's thread; NULL until its first hop
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (study_id, id)
);

CREATE TABLE edges (
  study_id    TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  from_node   TEXT NOT NULL,             -- prerequisite
  to_node     TEXT NOT NULL,
  PRIMARY KEY (study_id, from_node, to_node),
  FOREIGN KEY (study_id, from_node) REFERENCES nodes(study_id, id) ON DELETE CASCADE,
  FOREIGN KEY (study_id, to_node) REFERENCES nodes(study_id, id) ON DELETE CASCADE
);

CREATE TABLE quiz_items (
  id                TEXT PRIMARY KEY,
  study_id          TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  quiz_call_id      TEXT NOT NULL,          -- groups the items of one quiz tool call
  phase             TEXT NOT NULL CHECK (phase IN ('probe','check')),
  strand            TEXT,                   -- set for probe items
  node_id           TEXT,                   -- set for check items
  prompt            TEXT NOT NULL,
  options           TEXT NOT NULL,          -- JSON {id, text}[]
  correct_option_id TEXT NOT NULL,
  explanation       TEXT NOT NULL,
  chosen_option_id  TEXT,                   -- NULL until answered
  answered_at       INTEGER,
  FOREIGN KEY (study_id, node_id) REFERENCES nodes(study_id, id) ON DELETE CASCADE
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  study_id    TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  node_id     TEXT,                       -- NULL = main probe/plan thread
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,              -- JSON content blocks, mirrored from the thread's Agent SDK session for display
  pending     INTEGER NOT NULL DEFAULT 0, -- 1 = assistant tool_use awaiting a user response
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (study_id, node_id) REFERENCES nodes(study_id, id) ON DELETE CASCADE
);

-- One row per model per hop, and per side call. study_id is NULL for project-level calls (URL import).
CREATE TABLE usage (
  id                 INTEGER PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  study_id           TEXT REFERENCES studies(id) ON DELETE CASCADE,
  model              TEXT NOT NULL,             -- the model that served the call
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  web_searches       INTEGER NOT NULL,
  created_at         INTEGER NOT NULL
);

-- Agent SDK session transcripts (SessionStore), one row per entry in append order.
CREATE TABLE agent_entries (
  seq        INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  subpath    TEXT NOT NULL DEFAULT '',
  uuid       TEXT,
  entry      TEXT NOT NULL,             -- one JSON transcript entry
  UNIQUE (session_id, subpath, uuid)
);

CREATE INDEX idx_messages_thread ON messages(study_id, node_id, created_at);
CREATE INDEX idx_quiz_node ON quiz_items(study_id, node_id);
```

## Notes

- **Node IDs** are short names the tutor picks (`limits`, `r1`), so they're unique only within a study. Every reference to a node carries `study_id` as well, through composite foreign keys.
- **Replacing the graph.** When `propose_graph` is re-proposed during Plan, the app deletes the study's nodes and edges and inserts the new set. That's safe because no node threads exist before approval.
- **Node evidence** is derived at read time, not stored: `SELECT … FROM quiz_items WHERE node_id = ? OR strand IN (node.strands)`.
- **Sessions.** `studies.session_id` and `nodes.session_id` name each thread's Agent SDK session; `agent_entries` holds its transcript, keyed by session id only. `messages` is a display mirror; the model's context is the session. Deleting a goal deletes its transcripts.
- **No API keys** anywhere: Claude Code signs in with a token from the server's environment (see [05-stack.md](05-stack.md#claude-sign-in)).

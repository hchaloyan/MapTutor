import { DatabaseSync } from 'node:sqlite'
import { httpError } from './http'

export const LOCAL_USER_ID = 'local'

// ponytail: no migrations; after a schema change in development, delete data/maptutor.db
const SCHEMA = `
-- Single implicit user in v1. The table exists so accounts can slot in later.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('pdf','image','text','url')),
  name        TEXT NOT NULL,
  data        BLOB,          -- file bytes (pdf/image); NULL for text/url
  url         TEXT,          -- source URL for imported files
  text_cache  TEXT,          -- extracted text for text/url; NULL for pdf/image (sent natively)
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS studies (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  goal        TEXT NOT NULL,             -- refined during probe
  phase       TEXT NOT NULL CHECK (phase IN ('probe','plan','teach','done')),
  approach    TEXT,                      -- prose plan from the approved propose_graph
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  study_id    TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('root','derived','goal')),
  description TEXT NOT NULL,
  strands     TEXT NOT NULL DEFAULT '[]',   -- JSON string[] of probe strands
  state       TEXT NOT NULL CHECK (state IN ('untested','missed','frontier','known')),
  ever_known  INTEGER NOT NULL DEFAULT 0,   -- set once, never cleared
  summary     TEXT,                         -- written when first Known
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  study_id    TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  from_node   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,  -- prerequisite
  to_node     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (from_node, to_node)
);

CREATE TABLE IF NOT EXISTS quiz_items (
  id                TEXT PRIMARY KEY,
  study_id          TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  quiz_call_id      TEXT NOT NULL,          -- groups the items of one quiz tool call
  phase             TEXT NOT NULL CHECK (phase IN ('probe','check')),
  strand            TEXT,                   -- set for probe items
  node_id           TEXT REFERENCES nodes(id) ON DELETE SET NULL,  -- set for check items
  prompt            TEXT NOT NULL,
  options           TEXT NOT NULL,          -- JSON {id, text}[]
  correct_option_id TEXT NOT NULL,
  explanation       TEXT NOT NULL,
  hint              TEXT,
  chosen_option_id  TEXT,                   -- NULL until answered
  answered_at       INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  study_id    TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  node_id     TEXT REFERENCES nodes(id) ON DELETE CASCADE,  -- NULL = main probe/plan thread
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,              -- JSON content blocks, as sent to and received from the API
  pending     INTEGER NOT NULL DEFAULT 0, -- 1 = assistant tool_use awaiting a user response
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(study_id, node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quiz_node ON quiz_items(node_id);
`

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  db.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(LOCAL_USER_ID, Date.now())
  return db
}

export function requireProject(db: DatabaseSync, id: string) {
  const project = db.prepare('SELECT id, name, created_at AS createdAt FROM projects WHERE id = ?').get(id)
  if (!project) throw httpError(404, 'Project not found.')
  return project
}

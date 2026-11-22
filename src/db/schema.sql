-- Muninn Engine Database Schema
-- Version 2.0.0 (user_version = 2)

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  uid TEXT,
  name TEXT NOT NULL,
  git_remote TEXT,
  git_remotes TEXT,
  kind TEXT CHECK(kind IN ('git', 'directory')) DEFAULT 'directory',
  aliases TEXT,
  root_path TEXT NOT NULL UNIQUE,
  last_seen_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_root_path ON projects(root_path);
-- idx_projects_uid is created by the v2 migration, after older databases gain
-- the uid column (a partial index cannot be created before the column exists).

-- Observations table
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  category TEXT CHECK(category IN ('decision', 'convention', 'discovery', 'bugfix', 'architecture')) NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  topic_key TEXT,
  status TEXT CHECK(status IN ('active', 'superseded')) NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  scope TEXT CHECK(scope IN ('project', 'global')) DEFAULT 'project',
  agent TEXT,
  session_id TEXT,
  tags TEXT,
  files TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_observations_project_id ON observations(project_id);
CREATE INDEX IF NOT EXISTS idx_observations_updated_at ON observations(updated_at);
CREATE INDEX IF NOT EXISTS idx_observations_project_updated ON observations(project_id, updated_at DESC, created_at DESC);

-- Observations FTS5 virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title,
  content,
  topic_key,
  content='observations',
  content_rowid='rowid'
);

-- Triggers for automatic FTS5 synchronization
CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, content, topic_key)
  VALUES (new.rowid, new.title, new.content, new.topic_key);
END;

CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, topic_key)
  VALUES ('delete', old.rowid, old.title, old.content, old.topic_key);
END;

CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, topic_key)
  VALUES ('delete', old.rowid, old.title, old.content, old.topic_key);
  INSERT INTO observations_fts(rowid, title, content, topic_key)
  VALUES (new.rowid, new.title, new.content, new.topic_key);
END;

-- Entities table
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entity_type TEXT CHECK(entity_type IN ('file', 'function', 'class', 'interface', 'module')) NOT NULL,
  identifier TEXT NOT NULL,
  file_path TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entities_project_id ON entities(project_id);
CREATE INDEX IF NOT EXISTS idx_entities_identifier ON entities(identifier);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_project_identifier ON entities(project_id, identifier);

-- Observation Entities join table
CREATE TABLE IF NOT EXISTS observation_entities (
  observation_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY(observation_id, entity_id),
  FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE,
  FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_observation_entities_entity_id ON observation_entities(entity_id);

-- Entity Dependencies table
-- Relaciones topológicas entre símbolos (A llama/importa a B, o A implementa a B)
CREATE TABLE IF NOT EXISTS entity_dependencies (
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  relation_type TEXT CHECK(relation_type IN ('imports', 'calls', 'implements', 'extends', 'references')) NOT NULL,
  PRIMARY KEY(source_entity_id, target_entity_id, relation_type),
  FOREIGN KEY(source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY(target_entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entity_deps_source ON entity_dependencies(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_deps_target ON entity_dependencies(target_entity_id);
-- Observation metadata (v3): provenance and applicability.
-- Session handoffs (v3): the "where we left off" record.
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  state TEXT NOT NULL,
  status TEXT CHECK(status IN ('active', 'superseded', 'closed')) NOT NULL DEFAULT 'active',
  agent TEXT,
  session_id TEXT,
  branch TEXT,
  files_touched TEXT,
  open_questions TEXT,
  next_steps TEXT,
  decisions TEXT,
  blockers TEXT,
  superseded_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_handoffs_project_status ON handoffs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_handoffs_project_updated ON handoffs(project_id, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS handoffs_fts USING fts5(
  goal,
  state,
  open_questions,
  next_steps,
  content='handoffs',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS handoffs_ai AFTER INSERT ON handoffs BEGIN
  INSERT INTO handoffs_fts(rowid, goal, state, open_questions, next_steps)
  VALUES (new.rowid, new.goal, new.state, new.open_questions, new.next_steps);
END;

CREATE TRIGGER IF NOT EXISTS handoffs_ad AFTER DELETE ON handoffs BEGIN
  INSERT INTO handoffs_fts(handoffs_fts, rowid, goal, state, open_questions, next_steps)
  VALUES ('delete', old.rowid, old.goal, old.state, old.open_questions, old.next_steps);
END;

CREATE TRIGGER IF NOT EXISTS handoffs_au AFTER UPDATE ON handoffs BEGIN
  INSERT INTO handoffs_fts(handoffs_fts, rowid, goal, state, open_questions, next_steps)
  VALUES ('delete', old.rowid, old.goal, old.state, old.open_questions, old.next_steps);
  INSERT INTO handoffs_fts(rowid, goal, state, open_questions, next_steps)
  VALUES (new.rowid, new.goal, new.state, new.open_questions, new.next_steps);
END;

-- Code graph (v4): files, symbols and the edges between them.
CREATE TABLE IF NOT EXISTS code_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  index_root TEXT NOT NULL,
  path TEXT NOT NULL,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  bytes INTEGER,
  lines INTEGER,
  mtime_ms INTEGER,
  is_test INTEGER NOT NULL DEFAULT 0,
  is_generated INTEGER NOT NULL DEFAULT 0,
  indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, index_root, path)
);

CREATE INDEX IF NOT EXISTS idx_code_files_project ON code_files(project_id, index_root);

CREATE TABLE IF NOT EXISTS code_symbols (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_col INTEGER,
  signature TEXT,
  doc TEXT,
  visibility TEXT,
  is_exported INTEGER NOT NULL DEFAULT 0,
  parent_symbol_id TEXT,
  language TEXT,
  UNIQUE(project_id, qualified_name)
);

CREATE INDEX IF NOT EXISTS idx_code_symbols_project_name ON code_symbols(project_id, name);
CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(file_id);

CREATE TABLE IF NOT EXISTS code_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  src_id TEXT,
  dst_id TEXT,
  kind TEXT NOT NULL,
  line INTEGER,
  confidence TEXT NOT NULL DEFAULT 'heuristic',
  resolution TEXT NOT NULL DEFAULT 'resolved',
  target_name TEXT,
  UNIQUE(project_id, src_id, dst_id, kind, line)
);

CREATE INDEX IF NOT EXISTS idx_code_edges_src ON code_edges(project_id, src_id, kind);
CREATE INDEX IF NOT EXISTS idx_code_edges_dst ON code_edges(project_id, dst_id, kind);

CREATE TABLE IF NOT EXISTS code_index_state (
  project_id TEXT NOT NULL,
  index_root TEXT NOT NULL,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  indexed_at DATETIME,
  indexer_version INTEGER,
  PRIMARY KEY(project_id, index_root, path)
);

CREATE VIRTUAL TABLE IF NOT EXISTS code_symbols_fts USING fts5(
  name,
  qualified_name,
  signature,
  doc,
  content='code_symbols',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS code_symbols_ai AFTER INSERT ON code_symbols BEGIN
  INSERT INTO code_symbols_fts(rowid, name, qualified_name, signature, doc)
  VALUES (new.rowid, new.name, new.qualified_name, new.signature, new.doc);
END;

CREATE TRIGGER IF NOT EXISTS code_symbols_ad AFTER DELETE ON code_symbols BEGIN
  INSERT INTO code_symbols_fts(code_symbols_fts, rowid, name, qualified_name, signature, doc)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.signature, old.doc);
END;

CREATE TRIGGER IF NOT EXISTS code_symbols_au AFTER UPDATE ON code_symbols BEGIN
  INSERT INTO code_symbols_fts(code_symbols_fts, rowid, name, qualified_name, signature, doc)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.signature, old.doc);
  INSERT INTO code_symbols_fts(rowid, name, qualified_name, signature, doc)
  VALUES (new.rowid, new.name, new.qualified_name, new.signature, new.doc);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS code_files_fts USING fts5(
  path,
  content='code_files',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS code_files_ai AFTER INSERT ON code_files BEGIN
  INSERT INTO code_files_fts(rowid, path) VALUES (new.rowid, new.path);
END;

CREATE TRIGGER IF NOT EXISTS code_files_ad AFTER DELETE ON code_files BEGIN
  INSERT INTO code_files_fts(code_files_fts, rowid, path)
  VALUES ('delete', old.rowid, old.path);
END;

CREATE TRIGGER IF NOT EXISTS code_files_au AFTER UPDATE ON code_files BEGIN
  INSERT INTO code_files_fts(code_files_fts, rowid, path)
  VALUES ('delete', old.rowid, old.path);
  INSERT INTO code_files_fts(rowid, path) VALUES (new.rowid, new.path);
END;

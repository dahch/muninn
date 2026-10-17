-- Muninn Engine Database Schema
-- Version 1.0.0

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  git_remote TEXT,
  root_path TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_root_path ON projects(root_path);

-- Observations table
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  category TEXT CHECK(category IN ('decision', 'convention', 'discovery', 'bugfix', 'architecture')) NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  topic_key TEXT,
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


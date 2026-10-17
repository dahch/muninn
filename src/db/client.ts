import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { assertDocPath } from "../util/path-safety.js";

export type ObservationCategory =
  | "decision"
  | "convention"
  | "discovery"
  | "bugfix"
  | "architecture";

export interface Project {
  id: string;
  name: string;
  git_remote: string | null;
  root_path: string;
  created_at: string;
}

export interface Observation {
  id: string;
  project_id: string;
  category: ObservationCategory;
  title: string;
  content: string;
  topic_key: string | null;
  created_at: string;
  updated_at: string;
}

export type EntityType =
  | "file"
  | "function"
  | "class"
  | "interface"
  | "module";

export interface Entity {
  id: string;
  project_id: string;
  entity_type: EntityType;
  identifier: string;
  file_path: string;
}

export interface ObservationEntity {
  observation_id: string;
  entity_id: string;
}

export type DependencyRelationType =
  | "imports"
  | "calls"
  | "implements"
  | "extends"
  | "references";

export interface EntityDependency {
  source_entity_id: string;
  target_entity_id: string;
  relation_type: DependencyRelationType;
}

export interface EnsureProjectOptions {
  rootPath?: string;
  name?: string;
  gitRemote?: string;
  /**
   * Start directory for the git-root **fallback** when no `rootPath` is given.
   * Callers that also choose the database path pass the same directory, so the
   * database file and the project record can never be resolved from two different
   * roots (ADR-49).
   */
  startDir?: string;
}

export const SCHEMA_SQL = `-- Muninn Engine Database Schema
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
`;

/**
 * Robustly load schema SQL from disk if available, otherwise fallback to embedded SCHEMA_SQL.
 */
export function loadSchemaSql(): string {
  try {
    const currentDir =
      typeof __dirname !== "undefined"
        ? __dirname
        : path.dirname(fileURLToPath(import.meta.url));
    const schemaFile = path.join(currentDir, "schema.sql");
    if (fs.existsSync(schemaFile)) {
      return fs.readFileSync(schemaFile, "utf-8");
    }
  } catch {
    // Ignore and fallback to embedded schema
  }
  return SCHEMA_SQL;
}

/**
 * Strips embedded basic auth credentials (e.g. https://user:pass@host/... -> https://host/...)
 * from a git remote URL before saving git_remote.
 */
export function sanitizeGitRemote(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      if (parsed.protocol === "ssh:" && !parsed.password) {
        return rawUrl;
      }
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    return rawUrl;
  } catch {
    // Regex fallback for non-standard URLs or git SCP-like syntax
    return rawUrl.replace(/^([a-zA-Z+-]+:\/\/)[^/@]+@/, "$1");
  }
}

/**
 * Searches upward from startDir for the nearest directory or parent containing a .git folder or file.
 */
export function findGitRoot(startDir: string = process.cwd()): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

/**
 * Inspects a git repository root to extract the default origin remote URL if present.
 */
export function tryGetGitRemote(gitRoot: string): string | null {
  try {
    const configPath = path.join(gitRoot, ".git", "config");
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      const match = content.match(/\[remote "origin"\][^\[]*url\s*=\s*([^\n\r]+)/);
      if (match && match[1]) {
        return sanitizeGitRemote(match[1].trim());
      }
    }
  } catch {
    // Ignore error
  }
  return null;
}

/**
 * Resolves the database path for Muninn.
 * - If customPath is given, return it (e.g. ':memory:' or specific path).
 * - Check if cwd (or startDir) or any parent directory has .git. If so, resolve to `<git_root>/.huginn/muninn.db`.
 * - Fallback to `join(homedir(), '.huginn', 'muninn.db')`.
 */
export function resolveDatabasePath(
  customPath?: string,
  startDir: string = process.cwd()
): string {
  if (customPath !== undefined && customPath !== "") {
    return customPath;
  }
  const gitRoot = findGitRoot(startDir);
  if (gitRoot) {
    return path.join(gitRoot, ".huginn", "muninn.db");
  }
  return path.join(os.homedir(), ".huginn", "muninn.db");
}

/**
 * Initializes and returns a SQLite database instance using better-sqlite3.
 * Configures foreign_keys = ON, journal_mode = WAL, busy_timeout = 5000, recursive_triggers = ON, and executes schema.sql DDL.
 */
export function getDatabase(dbPath?: string, startDir?: string): Database.Database {
  // The database and the project record must come from ONE root (ADR-49): the
  // caller passes the same directory it hands to `ensureProject`.
  const resolvedPath = resolveDatabasePath(dbPath, startDir);

  if (resolvedPath !== ":memory:") {
    // A cloned repository can ship `.huginn` — or the database file itself — as a
    // symlink and redirect the SQLite write outside the project (SEC-005). The
    // path is screened exactly like the harness state, the receipts and the
    // promotion backup; the lexical path is kept for the open so callers see the
    // path they named.
    assertDocPath(resolvedPath, {
      projectPath: findGitRoot(startDir ?? process.cwd()) ?? undefined,
      label: "the Muninn database",
      action: "write",
    });

    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  const db = new Database(resolvedPath, { timeout: 5000 });
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("recursive_triggers = ON");

    const schema = loadSchemaSql();
    db.exec(schema);
  } catch (err) {
    db.close();
    throw err;
  }

  return db;
}

/**
 * Finds an existing project by root_path or creates a new project record idempotently.
 */
export function ensureProject(
  db: Database.Database,
  options?: EnsureProjectOptions
): Project {
  // Same fallback root as the database resolution (ADR-49): when no explicit
  // root is given, both derive from `startDir` (or the process cwd).
  const base = options?.startDir ? path.resolve(options.startDir) : process.cwd();
  const rootPath = options?.rootPath ? path.resolve(options.rootPath) : (findGitRoot(base) ?? base);

  const existing = db
    .prepare<[string], Project>(
      "SELECT id, name, git_remote, root_path, created_at FROM projects WHERE root_path = ?"
    )
    .get(rootPath);

  if (existing) {
    return existing;
  }

  const name = options?.name ?? (path.basename(rootPath) || "project");
  const rawRemote = options?.gitRemote ?? tryGetGitRemote(rootPath) ?? null;
  const gitRemote = rawRemote ? sanitizeGitRemote(rawRemote) : null;
  const id = crypto.randomUUID();

  db.prepare(
    "INSERT INTO projects (id, name, git_remote, root_path) VALUES (?, ?, ?, ?)"
  ).run(id, name, gitRemote, rootPath);

  const created = db
    .prepare<[string], Project>(
      "SELECT id, name, git_remote, root_path, created_at FROM projects WHERE id = ?"
    )
    .get(id);

  if (!created) {
    throw new Error(`Failed to create project record for rootPath: ${rootPath}`);
  }

  return created;
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { assertDocPath } from "../util/path-safety.js";
import { symbolSearchTokens } from "../util/text.js";
import {
  deriveProjectUid,
  findGitCommonRoot,
  memoryDbPath,
  projectStorageDir,
  readGitRemote,
  resolveProjectContext,
  sanitizeGitRemote,
} from "../project/identity.js";

export { sanitizeGitRemote };

export type ObservationCategory =
  | "decision"
  | "convention"
  | "discovery"
  | "bugfix"
  | "architecture";

export interface Project {
  id: string;
  /** Stable identity shared by every path and machine a project is seen at. */
  uid?: string | null;
  name: string;
  git_remote: string | null;
  /** Extra remotes seen for the same project (JSON-encoded in storage). */
  git_remotes?: string | null;
  /** `git` when the project lives in a repository, `directory` otherwise. */
  kind?: string | null;
  /** Alias paths (JSON-encoded in storage). */
  aliases?: string | null;
  root_path: string;
  last_seen_at?: string | null;
  created_at: string;
}

export type ObservationStatus = "active" | "superseded";

export interface Observation {
  id: string;
  project_id: string;
  category: ObservationCategory;
  title: string;
  content: string;
  topic_key: string | null;
  status: ObservationStatus;
  superseded_by: string | null;
  /** `project` (default) or `global` for cross-project preferences. */
  scope?: string | null;
  /** Agent that wrote the observation, when the caller supplied one. */
  agent?: string | null;
  /** Session/handoff correlation id. */
  session_id?: string | null;
  /** JSON-encoded array of tags. */
  tags?: string | null;
  /** JSON-encoded array of file paths the observation refers to. */
  files?: string | null;
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
  /** Stable project identity resolved by the `src/project` layer. */
  uid?: string;
  /** `git` or `directory`. */
  kind?: "git" | "directory";
  /** Additional remotes seen for the same project. */
  gitRemotes?: string[];
  /** Alias paths (a moved project, a subdirectory used as a project root). */
  aliases?: string[];
  /**
   * Start directory for the git-root **fallback** when no `rootPath` is given.
   * Callers that also choose the database path pass the same directory, so the
   * database file and the project record can never be resolved from two different
   * roots (ADR-49).
   */
  startDir?: string;
}

export const SCHEMA_SQL = `-- Muninn Engine Database Schema
-- Version 5 (user_version = 5)

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

-- Observations FTS5 virtual table.
-- Porter stemming with diacritic folding: "verifying" matches "verify" and
-- "sesion" matches "sesión". Substring recovery lives in observations_trigram
-- so ranking keeps an exact tokenizer.
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title,
  content,
  topic_key,
  content='observations',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
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


-- Substring recovery (trigram) used only when the stemmed tokenizer finds
-- nothing. FTS5 trigram matches any substring of three characters or more.
CREATE VIRTUAL TABLE IF NOT EXISTS observations_trigram USING fts5(
  title,
  content,
  content='observations',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS obs_tri_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_trigram(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS obs_tri_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_trigram(observations_trigram, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS obs_tri_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_trigram(observations_trigram, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO observations_trigram(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
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
  ctime_ms INTEGER,
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
  -- Subword tokens (camelCase and snake_case split) so a search for "contract"
  -- finds verifyTypeScriptContracts. Filled by the indexer.
  search_tokens TEXT,
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

-- One row per indexed worktree root: the cheap freshness fingerprint.
CREATE TABLE IF NOT EXISTS code_index_roots (
  project_id TEXT NOT NULL,
  index_root TEXT NOT NULL,
  head_sha TEXT,
  indexed_at DATETIME,
  indexer_version INTEGER,
  files INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, index_root)
);

CREATE VIRTUAL TABLE IF NOT EXISTS code_symbols_fts USING fts5(
  name,
  qualified_name,
  signature,
  doc,
  search_tokens,
  content='code_symbols',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS code_symbols_ai AFTER INSERT ON code_symbols BEGIN
  INSERT INTO code_symbols_fts(rowid, name, qualified_name, signature, doc, search_tokens)
  VALUES (new.rowid, new.name, new.qualified_name, new.signature, new.doc, new.search_tokens);
END;

CREATE TRIGGER IF NOT EXISTS code_symbols_ad AFTER DELETE ON code_symbols BEGIN
  INSERT INTO code_symbols_fts(code_symbols_fts, rowid, name, qualified_name, signature, doc, search_tokens)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.signature, old.doc, old.search_tokens);
END;

CREATE TRIGGER IF NOT EXISTS code_symbols_au AFTER UPDATE ON code_symbols BEGIN
  INSERT INTO code_symbols_fts(code_symbols_fts, rowid, name, qualified_name, signature, doc, search_tokens)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.signature, old.doc, old.search_tokens);
  INSERT INTO code_symbols_fts(rowid, name, qualified_name, signature, doc, search_tokens)
  VALUES (new.rowid, new.name, new.qualified_name, new.signature, new.doc, new.search_tokens);
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
 *
 * - An explicit `customPath` always wins (a file path or `:memory:`).
 * - Otherwise the project context decides: `$MUNINN_HOME/projects/<uid>/memory.db`,
 *   where the uid comes from the committed `.muninn/project.json` marker, the Git
 *   remote, or the resolved path. Every project — Git or not, worktree or clone —
 *   therefore gets its own file.
 * - `MUNINN_LEGACY_STORAGE=1` restores the pre-0.3 resolution
 *   (`<git-root>/.huginn/muninn.db` / `~/.huginn/muninn.db`) for migration work.
 */
export function resolveDatabasePath(
  customPath?: string,
  startDir: string = process.cwd()
): string {
  if (customPath !== undefined && customPath !== "") {
    return customPath;
  }
  if (process.env.MUNINN_LEGACY_STORAGE === "1") {
    const gitRoot = findGitRoot(startDir);
    if (gitRoot) {
      return path.join(gitRoot, ".huginn", "muninn.db");
    }
    return path.join(os.homedir(), ".huginn", "muninn.db");
  }
  const context = resolveProjectContext({ startDir, explicitRoot: startDir });
  return memoryDbPath(context.uid);
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
    migrateDatabase(db);
  } catch (err) {
    db.close();
    throw err;
  }

  return db;
}

/** Current schema version tracked in `PRAGMA user_version`. */
export const SCHEMA_VERSION = 5;

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all();
  return new Set(rows.map((column) => column.name));
}

/**
 * Applies every idempotent migration up to {@link SCHEMA_VERSION}.
 *
 * The DDL in `schema.sql` already creates the current shape for a fresh
 * database; this function covers databases created by earlier versions. Each
 * step is guarded by `PRAGMA table_info`, so reopening a migrated database is a
 * no-op and never rewrites a row, index or trigger.
 */
export function migrateDatabase(db: Database.Database): number {
  const current = Number(db.pragma("user_version", { simple: true }) ?? 0);
  if (current >= SCHEMA_VERSION) return current;

  db.transaction(() => {
    // v1 → v2: decision supersession columns (idempotent for very old databases).
    const observationColumns = tableColumns(db, "observations");
    if (!observationColumns.has("status")) {
      db.exec(
        "ALTER TABLE observations ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'superseded'))"
      );
    }
    if (!observationColumns.has("superseded_by")) {
      db.exec("ALTER TABLE observations ADD COLUMN superseded_by TEXT");
    }

    // v1 → v2: portable project identity.
    const projectColumns = tableColumns(db, "projects");
    const additions: Array<[string, string]> = [
      ["uid", "TEXT"],
      ["git_remotes", "TEXT"],
      ["kind", "TEXT DEFAULT 'directory'"],
      ["aliases", "TEXT"],
      ["last_seen_at", "DATETIME"],
    ];
    for (const [column, type] of additions) {
      if (!projectColumns.has(column)) {
        db.exec(`ALTER TABLE projects ADD COLUMN ${column} ${type}`);
      }
    }
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_uid ON projects(uid) WHERE uid IS NOT NULL"
    );

    const unbackfilled = db
      .prepare<[], { id: string }>("SELECT id FROM projects WHERE uid IS NULL")
      .all();
    if (unbackfilled.length > 0) {
      const update = db.prepare("UPDATE projects SET uid = ? WHERE id = ?");
      for (const row of unbackfilled) {
        const digest = crypto
          .createHash("sha256")
          .update(`legacy:${row.id}`)
          .digest("hex")
          .slice(0, 20);
        update.run(`p-${digest}`, row.id);
      }
    }
    db.exec(
      "UPDATE projects SET last_seen_at = COALESCE(last_seen_at, created_at) WHERE last_seen_at IS NULL"
    );

    // v2 → v3: observation provenance/applicability. The handoffs table and its
    // FTS index are created by `schema.sql` (`CREATE TABLE IF NOT EXISTS`), so
    // this step only backfills the columns of an older `observations` table.
    const v3ObservationColumns = tableColumns(db, "observations");
    const observationAdditions: Array<[string, string]> = [
      ["scope", "TEXT DEFAULT 'project'"],
      ["agent", "TEXT"],
      ["session_id", "TEXT"],
      ["tags", "TEXT"],
      ["files", "TEXT"],
    ];
    for (const [column, type] of observationAdditions) {
      if (!v3ObservationColumns.has(column)) {
        db.exec(`ALTER TABLE observations ADD COLUMN ${column} ${type}`);
      }
    }
    db.exec(
      "UPDATE observations SET scope = 'project' WHERE scope IS NULL"
    );

    // v4 → v5: lexical index v2. SQLite cannot change a tokenizer in place, so a
    // table whose stored SQL predates the change is dropped and rebuilt. Both a
    // fresh schema.sql and a migrated database end with the same table shape.
    const ftsTableSql = (name: string): string | null => {
      const row = db
        .prepare<[string], { sql: string | null }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get(name);
      return row?.sql ?? null;
    };

    const observationsFtsSql = ftsTableSql("observations_fts");
    if (observationsFtsSql === null || !observationsFtsSql.includes("porter")) {
      db.exec(`
        DROP TRIGGER IF EXISTS obs_ai;
        DROP TRIGGER IF EXISTS obs_ad;
        DROP TRIGGER IF EXISTS obs_au;
        DROP TABLE IF EXISTS observations_fts;
        CREATE VIRTUAL TABLE observations_fts USING fts5(
          title,
          content,
          topic_key,
          content='observations',
          content_rowid='rowid',
          tokenize='porter unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER obs_ai AFTER INSERT ON observations BEGIN
          INSERT INTO observations_fts(rowid, title, content, topic_key)
          VALUES (new.rowid, new.title, new.content, new.topic_key);
        END;
        CREATE TRIGGER obs_ad AFTER DELETE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, content, topic_key)
          VALUES ('delete', old.rowid, old.title, old.content, old.topic_key);
        END;
        CREATE TRIGGER obs_au AFTER UPDATE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, content, topic_key)
          VALUES ('delete', old.rowid, old.title, old.content, old.topic_key);
          INSERT INTO observations_fts(rowid, title, content, topic_key)
          VALUES (new.rowid, new.title, new.content, new.topic_key);
        END;
      `);
      db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
    }

    // Trigram recovery is created by schema.sql for both paths; the rebuild makes
    // it consistent with rows an earlier version wrote without the trigger.
    if (ftsTableSql("observations_trigram") !== null) {
      db.exec(
        "INSERT INTO observations_trigram(observations_trigram) VALUES('rebuild')"
      );
    }

    if (!tableColumns(db, "code_symbols").has("search_tokens")) {
      db.exec("ALTER TABLE code_symbols ADD COLUMN search_tokens TEXT DEFAULT ''");
    }
    if (!tableColumns(db, "code_files").has("ctime_ms")) {
      db.exec("ALTER TABLE code_files ADD COLUMN ctime_ms INTEGER");
    }
    const symbolsFtsSql = ftsTableSql("code_symbols_fts");
    const rebuildSymbols =
      symbolsFtsSql === null || !symbolsFtsSql.includes("search_tokens");
    if (rebuildSymbols) {
      // Drop the old triggers and index first: a backfill UPDATE must not emit
      // FTS "delete" commands against an index that is being replaced, because a
      // mismatched delete is reported as SQLITE_CORRUPT_VTAB.
      db.exec(`
        DROP TRIGGER IF EXISTS code_symbols_ai;
        DROP TRIGGER IF EXISTS code_symbols_ad;
        DROP TRIGGER IF EXISTS code_symbols_au;
        DROP TABLE IF EXISTS code_symbols_fts;
      `);
    }

    // Backfill subword tokens for symbols an earlier version indexed.
    const untokenized = db
      .prepare<[], { id: string; name: string; qualified_name: string }>(
        "SELECT id, name, qualified_name FROM code_symbols WHERE search_tokens IS NULL OR search_tokens = ''"
      )
      .all();
    if (untokenized.length > 0) {
      const updateTokens = db.prepare(
        "UPDATE code_symbols SET search_tokens = ? WHERE id = ?"
      );
      for (const row of untokenized) {
        updateTokens.run(
          symbolSearchTokens(row.name, row.qualified_name),
          row.id
        );
      }
    }

    if (rebuildSymbols) {
      db.exec(`
        CREATE VIRTUAL TABLE code_symbols_fts USING fts5(
          name,
          qualified_name,
          signature,
          doc,
          search_tokens,
          content='code_symbols',
          content_rowid='rowid',
          tokenize='porter unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER code_symbols_ai AFTER INSERT ON code_symbols BEGIN
          INSERT INTO code_symbols_fts(rowid, name, qualified_name, signature, doc, search_tokens)
          VALUES (new.rowid, new.name, new.qualified_name, new.signature, new.doc, new.search_tokens);
        END;
        CREATE TRIGGER code_symbols_ad AFTER DELETE ON code_symbols BEGIN
          INSERT INTO code_symbols_fts(code_symbols_fts, rowid, name, qualified_name, signature, doc, search_tokens)
          VALUES ('delete', old.rowid, old.name, old.qualified_name, old.signature, old.doc, old.search_tokens);
        END;
        CREATE TRIGGER code_symbols_au AFTER UPDATE ON code_symbols BEGIN
          INSERT INTO code_symbols_fts(code_symbols_fts, rowid, name, qualified_name, signature, doc, search_tokens)
          VALUES ('delete', old.rowid, old.name, old.qualified_name, old.signature, old.doc, old.search_tokens);
          INSERT INTO code_symbols_fts(rowid, name, qualified_name, signature, doc, search_tokens)
          VALUES (new.rowid, new.name, new.qualified_name, new.signature, new.doc, new.search_tokens);
        END;
      `);
      db.exec("INSERT INTO code_symbols_fts(code_symbols_fts) VALUES('rebuild')");
    }

    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();

  return SCHEMA_VERSION;
}

/**
 * Opens an **existing** Muninn database without any initialization side effects.
 *
 * This is the access path for read-only bootstrap: it resolves the same default
 * location as {@link getDatabase}, but never creates a directory or file, never
 * applies write-capable pragmas, never runs schema DDL/migrations and never
 * inserts a project row. Opening a missing, inaccessible or corrupt file fails
 * with the underlying SQLite error; callers that must fail open catch it and
 * return an empty session brief with a note.
 */
export function getReadOnlyDatabase(
  dbPath?: string,
  startDir?: string
): Database.Database {
  const resolvedPath = resolveDatabasePath(dbPath, startDir);
  if (resolvedPath === ":memory:") {
    throw new Error(
      "A read-only session brief requires an existing database file, not :memory:."
    );
  }

  // Bootstrap must not follow a repository-shipped symlink either. The screen
  // does not write anything; a refused path simply becomes an unavailable brief.
  assertDocPath(resolvedPath, {
    projectPath: findGitRoot(startDir ?? process.cwd()) ?? undefined,
    label: "the Muninn database",
    action: "read",
  });

  const db = new Database(resolvedPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5000,
  });
  try {
    // A connection-local pragma only; it does not write to the database file.
    db.pragma("busy_timeout = 5000");
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** Alias kept explicit for callers that prefer the `open…` naming convention. */
export const openReadOnlyDatabase = getReadOnlyDatabase;

/**
 * Finds an existing project by root_path or creates a new project record
 * idempotently.
 *
 * Identity is triple-keyed so a project survives moves and clones:
 *
 * 1. `root_path` — the exact directory (the original behaviour);
 * 2. `uid` — the stable identity from `.muninn/project.json`, the Git remote or
 *    the resolved path. When a known uid shows up at a new root (a moved folder,
 *    a second machine) the existing row is adopted instead of duplicated;
 * 3. a derived remote, so two clones of the same repository share memory.
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
      "SELECT id, uid, name, git_remote, root_path, kind, created_at, last_seen_at FROM projects WHERE root_path = ?"
    )
    .get(rootPath);

  const gitRoot = findGitCommonRoot(rootPath) ?? findGitRoot(rootPath);
  const rawRemote =
    options?.gitRemote ??
    (gitRoot ? readGitRemote(gitRoot) : null) ??
    tryGetGitRemote(rootPath) ??
    null;
  const gitRemote = rawRemote ? sanitizeGitRemote(rawRemote) : null;
  const uid = options?.uid ?? deriveProjectUid({ gitRemote, rootPath });
  const kind = options?.kind ?? (gitRoot ? "git" : "directory");
  const gitRemotesJson = options?.gitRemotes?.length
    ? JSON.stringify([...new Set(options.gitRemotes)])
    : null;
  const aliasesJson = options?.aliases?.length
    ? JSON.stringify([...new Set(options.aliases.map((item) => path.resolve(item)))])
    : null;

  if (existing) {
    // Adopt a marker/remote-derived uid on a row created before identity existed,
    // unless another row already owns it.
    const shouldAdoptUid = uid !== existing.uid && uid.length > 0;
    const conflict = shouldAdoptUid
      ? db
          .prepare<[string, string], { id: string }>(
            "SELECT id FROM projects WHERE uid = ? AND id != ?"
          )
          .get(uid, existing.id)
      : undefined;
    if (shouldAdoptUid && !conflict) {
      db.prepare(
        `UPDATE projects
         SET uid = ?, kind = COALESCE(?, kind), last_seen_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(uid, kind, existing.id);
    } else {
      db.prepare(
        "UPDATE projects SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(existing.id);
    }
    const refreshed = db
      .prepare<[string], Project>(
        "SELECT id, uid, name, git_remote, root_path, kind, created_at, last_seen_at FROM projects WHERE id = ?"
      )
      .get(existing.id);
    return refreshed ?? existing;
  }

  const byUid = db
    .prepare<[string], Project>(
      "SELECT id, uid, name, git_remote, root_path, kind, created_at, last_seen_at FROM projects WHERE uid = ?"
    )
    .get(uid);
  if (byUid && byUid.root_path !== rootPath) {
    // The same project seen at a new path: adopt it instead of duplicating.
    db.prepare(
      `UPDATE projects
       SET root_path = ?, name = COALESCE(?, name), git_remote = COALESCE(?, git_remote),
           kind = COALESCE(?, kind), last_seen_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(rootPath, options?.name ?? null, gitRemote, kind, byUid.id);
    const adopted = db
      .prepare<[string], Project>(
        "SELECT id, uid, name, git_remote, root_path, kind, created_at, last_seen_at FROM projects WHERE id = ?"
      )
      .get(byUid.id);
    return adopted ?? byUid;
  }

  const name = options?.name ?? (path.basename(rootPath) || "project");
  const id = crypto.randomUUID();

  db.prepare(
    `INSERT INTO projects (id, uid, name, git_remote, git_remotes, kind, aliases, root_path, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(id, uid, name, gitRemote, gitRemotesJson, kind, aliasesJson, rootPath);

  const created = db
    .prepare<[string], Project>(
      "SELECT id, name, git_remote, root_path, created_at FROM projects WHERE id = ?"
    )
    .get(id);

  if (!created) {
    throw new Error(`Failed to create project record for rootPath: ${rootPath}`);
  }

  return {
    ...created,
    uid,
    kind,
    last_seen_at: new Date().toISOString(),
  };
}

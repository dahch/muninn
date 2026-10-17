import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import {
  getDatabase,
  resolveDatabasePath,
  ensureProject,
  findGitRoot,
  tryGetGitRemote,
  loadSchemaSql,
  sanitizeGitRemote,
  SCHEMA_SQL,
  type Project,
  type Observation,
  type Entity,
  type ObservationCategory,
  type EntityType,
} from "../src/db/client.js";


describe("Muninn Database Layer & SQLite FTS5 Schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = getDatabase(":memory:");
  });

  afterEach(() => {
    if (db && db.open) {
      db.close();
    }
  });

  describe("resolveDatabasePath", () => {
    it("returns customPath directly when provided", () => {
      expect(resolveDatabasePath(":memory:")).toBe(":memory:");
      expect(resolveDatabasePath("/custom/path/memory.db")).toBe(
        "/custom/path/memory.db"
      );
    });

    it("resolves to <git_root>/.huginn/muninn.db when inside a git repository", () => {
      const gitRoot = findGitRoot(process.cwd());
      expect(gitRoot).not.toBeNull();
      const resolved = resolveDatabasePath(undefined, process.cwd());
      expect(resolved).toBe(path.join(gitRoot!, ".huginn", "muninn.db"));
    });

    it("resolves to <git_root>/.huginn/muninn.db from subdirectories of a git repository", () => {
      const gitRoot = findGitRoot(process.cwd());
      const subDir = path.join(process.cwd(), "src", "db");
      const resolved = resolveDatabasePath(undefined, subDir);
      expect(resolved).toBe(path.join(gitRoot!, ".huginn", "muninn.db"));
    });

    it("falls back to ~/.huginn/muninn.db when no .git is found", () => {
      const tempNonGit = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-no-git-"));
      try {
        const resolved = resolveDatabasePath(undefined, tempNonGit);
        expect(resolved).toBe(path.join(os.homedir(), ".huginn", "muninn.db"));
      } finally {
        fs.rmdirSync(tempNonGit);
      }
    });

    it("findGitRoot returns null when directory has no .git in hierarchy", () => {
      const tempNonGit = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-git-test-"));
      try {
        expect(findGitRoot(tempNonGit)).toBeNull();
      } finally {
        fs.rmdirSync(tempNonGit);
      }
    });

    it("findGitRoot locates .git when created in a directory", () => {
      const tempGit = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-git-found-"));
      const fakeGit = path.join(tempGit, ".git");
      const nested = path.join(tempGit, "a", "b", "c");
      try {
        fs.mkdirSync(fakeGit);
        fs.mkdirSync(nested, { recursive: true });
        expect(findGitRoot(nested)).toBe(tempGit);
      } finally {
        fs.rmSync(tempGit, { recursive: true, force: true });
      }
    });

    it("treats empty string '' as unprovided and falls back to git root or homedir", () => {
      const gitRoot = findGitRoot(process.cwd());
      expect(gitRoot).not.toBeNull();
      const resolved = resolveDatabasePath("", process.cwd());
      expect(resolved).toBe(path.join(gitRoot!, ".huginn", "muninn.db"));
    });
  });

  describe("getDatabase initialization", () => {
    it("creates all required relational and virtual tables", () => {
      const rows = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
        )
        .all();
      const tableNames = rows.map((r) => r.name);

      expect(tableNames).toContain("projects");
      expect(tableNames).toContain("observations");
      expect(tableNames).toContain("observations_fts");
      expect(tableNames).toContain("entities");
      expect(tableNames).toContain("observation_entities");
    });

    it("creates all required relational indexes including idx_observations_project_updated (REV-008)", () => {
      const indexes = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index'"
        )
        .all();
      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain("idx_observations_project_id");
      expect(indexNames).toContain("idx_observations_updated_at");
      expect(indexNames).toContain("idx_observations_project_updated");
      expect(indexNames).toContain("idx_projects_root_path");
      expect(indexNames).toContain("idx_entities_project_id");
      expect(indexNames).toContain("idx_entities_identifier");
      expect(indexNames).toContain("idx_entities_project_identifier");
      expect(indexNames).toContain("idx_observation_entities_entity_id");
    });

    it("creates all required FTS5 triggers", () => {
      const triggers = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger'"
        )
        .all();
      const triggerNames = triggers.map((t) => t.name);

      expect(triggerNames).toContain("obs_ai");
      expect(triggerNames).toContain("obs_ad");
      expect(triggerNames).toContain("obs_au");
    });

    it("enables foreign keys and sets journal mode", () => {
      const fk = db.pragma("foreign_keys", { simple: true });
      expect(fk).toBe(1);

      const jm = db.pragma("journal_mode", { simple: true });
      // In-memory databases return 'memory' for journal_mode; file dbs return 'wal'
      expect(["memory", "wal"]).toContain(jm);
    });

    it("enables recursive_triggers and sets busy_timeout", () => {
      const recursiveTriggers = db.pragma("recursive_triggers", { simple: true });
      expect(recursiveTriggers).toBe(1);

      const busyTimeout = db.pragma("busy_timeout", { simple: true });
      expect(busyTimeout).toBe(5000);
    });

    it("is idempotent when re-executing schema", () => {
      const schema = loadSchemaSql();
      expect(() => db.exec(schema)).not.toThrow();

      const tables = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'"
        )
        .all();
      expect(tables.length).toBe(1);
    });

    it("creates parent directory recursively with mode 0o700 when path is not :memory:", () => {
      const tempDir = path.join(os.tmpdir(), "muninn-dir-test-" + Date.now());
      const subDir = path.join(tempDir, "nested", "sub");
      const dbFile = path.join(subDir, "test.db");

      try {
        expect(fs.existsSync(subDir)).toBe(false);
        const fileDb = getDatabase(dbFile);
        expect(fs.existsSync(dbFile)).toBe(true);
        expect(fileDb.open).toBe(true);
        const jm = fileDb.pragma("journal_mode", { simple: true });
        expect(jm).toBe("wal");
        const stat = fs.statSync(subDir);
        expect(stat.mode & 0o777).toBe(0o700);
        fileDb.close();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("closes database handle if initialization fails during pragma execution", () => {
      let closedHandle: Database.Database | null = null;
      const originalClose = Database.prototype.close;
      const closeSpy = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
        closedHandle = this;
        return originalClose.apply(this);
      });

      const pragmaSpy = vi.spyOn(Database.prototype, "pragma").mockImplementationOnce(() => {
        throw new Error("Simulated pragma failure");
      });

      try {
        expect(() => getDatabase(":memory:")).toThrow("Simulated pragma failure");
        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(closedHandle).not.toBeNull();
        expect((closedHandle as any)?.open).toBe(false);
      } finally {
        closeSpy.mockRestore();
        pragmaSpy.mockRestore();
      }
    });

    it("closes database handle if initialization fails during schema execution", () => {
      let closedHandle: Database.Database | null = null;
      const originalClose = Database.prototype.close;
      const closeSpy = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
        closedHandle = this;
        return originalClose.apply(this);
      });

      const execSpy = vi.spyOn(Database.prototype, "exec").mockImplementationOnce(() => {
        throw new Error("Simulated DDL syntax failure");
      });

      try {
        expect(() => getDatabase(":memory:")).toThrow("Simulated DDL syntax failure");
        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(closedHandle).not.toBeNull();
        expect((closedHandle as any)?.open).toBe(false);
      } finally {
        closeSpy.mockRestore();
        execSpy.mockRestore();
      }
    });

    it("loads schema from disk or falls back to embedded SCHEMA_SQL", () => {
      expect(loadSchemaSql().trim()).toBe(SCHEMA_SQL.trim());
    });

    it("falls back to embedded SCHEMA_SQL when schema.sql does not exist on disk", () => {
      const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (typeof p === "string" && p.endsWith("schema.sql")) {
          return false;
        }
        return true;
      });
      try {
        const schema = loadSchemaSql();
        expect(schema).toBe(SCHEMA_SQL);
      } finally {
        existsSpy.mockRestore();
      }
    });

    it("falls back to embedded SCHEMA_SQL when reading schema.sql throws an error", () => {
      const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
        if (typeof p === "string" && p.endsWith("schema.sql")) {
          throw new Error("Disk I/O error");
        }
        return "";
      });
      try {
        const schema = loadSchemaSql();
        expect(schema).toBe(SCHEMA_SQL);
      } finally {
        readSpy.mockRestore();
      }
    });
  });

  describe("FTS5 automatic synchronization", () => {
    let project: Project;

    beforeEach(() => {
      project = ensureProject(db, {
        rootPath: "/test/repo",
        name: "test-repo",
      });
    });

    it("automatically indexes new observations on INSERT (obs_ai)", () => {
      db.prepare(
        "INSERT INTO observations (id, project_id, category, title, content, topic_key) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        "obs-1",
        project.id,
        "decision",
        "Adopt SQLite FTS5 for local search",
        "We choose SQLite FTS5 because it is fast, embedded, and zero-config.",
        "storage"
      );

      // Search by title keyword
      const byTitle = db
        .prepare<[string], { title: string; content: string }>(
          "SELECT title, content FROM observations_fts WHERE observations_fts MATCH ?"
        )
        .all("Adopt");
      expect(byTitle).toHaveLength(1);
      expect(byTitle[0].title).toBe("Adopt SQLite FTS5 for local search");

      // Search by content keyword
      const byContent = db
        .prepare<[string], { title: string }>(
          "SELECT title FROM observations_fts WHERE observations_fts MATCH ?"
        )
        .all("embedded");
      expect(byContent).toHaveLength(1);

      // Search by topic_key
      const byTopic = db
        .prepare<[string], { title: string }>(
          "SELECT title FROM observations_fts WHERE observations_fts MATCH ?"
        )
        .all("storage");
      expect(byTopic).toHaveLength(1);
    });

    it("automatically updates FTS index on UPDATE (obs_au)", () => {
      db.prepare(
        "INSERT INTO observations (id, project_id, category, title, content, topic_key) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        "obs-2",
        project.id,
        "architecture",
        "Monolith Architecture",
        "Initial monolithic architecture design for speed.",
        "arch"
      );

      // Verify initial match
      const initialMatch = db
        .prepare<[string], { title: string }>(
          "SELECT title FROM observations_fts WHERE observations_fts MATCH ?"
        )
        .all("Monolith");
      expect(initialMatch).toHaveLength(1);

      // Update observation
      db.prepare(
        "UPDATE observations SET title = ?, content = ?, topic_key = ? WHERE id = ?"
      ).run(
        "Microservices Architecture",
        "Transitioned to microservices architecture design.",
        "distributed",
        "obs-2"
      );

      // Old terms must no longer match
      const oldMatch = db
        .prepare<[string], { title: string }>(
          "SELECT title FROM observations_fts WHERE observations_fts MATCH ?"
        )
        .all("Monolith");
      expect(oldMatch).toHaveLength(0);

      // New terms must match
      const newMatch = db
        .prepare<[string], { title: string; topic_key: string }>(
          "SELECT title, topic_key FROM observations_fts WHERE observations_fts MATCH ?"
        )
        .all("Microservices");
      expect(newMatch).toHaveLength(1);
      expect(newMatch[0].title).toBe("Microservices Architecture");
      expect(newMatch[0].topic_key).toBe("distributed");
    });

    it("automatically cleans up FTS index on DELETE (obs_ad)", () => {
      db.prepare(
        "INSERT INTO observations (id, project_id, category, title, content, topic_key) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        "obs-3",
        project.id,
        "bugfix",
        "Fix concurrency race condition",
        "Resolved mutex deadlock on worker shutdown.",
        "concurrency"
      );

      // Verify indexed
      const beforeDelete = db
        .prepare<[string], { title: string }>(
          "SELECT title FROM observations_fts WHERE observations_fts MATCH ?"
        )
        .all("deadlock");
      expect(beforeDelete).toHaveLength(1);

      // Delete observation
      db.prepare("DELETE FROM observations WHERE id = ?").run("obs-3");

      // Verify deleted from index
      const afterDelete = db
        .prepare<[string], { title: string }>(
          "SELECT title FROM observations_fts WHERE observations_fts MATCH ?"
        )
        .all("deadlock");
      expect(afterDelete).toHaveLength(0);
    });

    it("handles NULL topic_key gracefully without trigger failures", () => {
      db.prepare(
        "INSERT INTO observations (id, project_id, category, title, content, topic_key) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        "obs-4",
        project.id,
        "convention",
        "Use PascalCase for types",
        "All interfaces and types should use PascalCase naming convention.",
        null
      );

      const matches = db
        .prepare<[string], { title: string }>(
          "SELECT title FROM observations_fts WHERE observations_fts MATCH ?"
        )
        .all("PascalCase");
      expect(matches).toHaveLength(1);

      db.prepare("DELETE FROM observations WHERE id = ?").run("obs-4");
      const empty = db
        .prepare<[string], { title: string }>(
          "SELECT title FROM observations_fts WHERE observations_fts MATCH ?"
        )
        .all("PascalCase");
      expect(empty).toHaveLength(0);
    });

    it("supports FTS5 prefix queries, phrase searches, and column filters", () => {
      db.prepare(
        "INSERT INTO observations (id, project_id, category, title, content, topic_key) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        "obs-search",
        project.id,
        "architecture",
        "Distributed Event Bus Architecture",
        "Implementing partitioned event streams for horizontal scalability.",
        "streaming"
      );

      // Prefix query
      const prefixResults = db
        .prepare<[string], { id: string }>(
          "SELECT o.id FROM observations o JOIN observations_fts f ON o.rowid = f.rowid WHERE observations_fts MATCH ?"
        )
        .all("scalab*");
      expect(prefixResults).toHaveLength(1);
      expect(prefixResults[0].id).toBe("obs-search");

      // Phrase search with quotes
      const phraseResults = db
        .prepare<[string], { id: string }>(
          "SELECT o.id FROM observations o JOIN observations_fts f ON o.rowid = f.rowid WHERE observations_fts MATCH ?"
        )
        .all('"Event Bus Architecture"');
      expect(phraseResults).toHaveLength(1);
      expect(phraseResults[0].id).toBe("obs-search");

      // Column filter
      const colResults = db
        .prepare<[string], { id: string }>(
          "SELECT o.id FROM observations o JOIN observations_fts f ON o.rowid = f.rowid WHERE observations_fts MATCH ?"
        )
        .all("topic_key:streaming");
      expect(colResults).toHaveLength(1);
    });

    it("properly synchronizes FTS5 when topic_key transitions from value to NULL and back to value", () => {
      db.prepare(
        "INSERT INTO observations (id, project_id, category, title, content, topic_key) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("obs-toggle", project.id, "convention", "Linter rules", "Enforce strict types", "linting");

      // Matches initial topic_key
      expect(
        db.prepare("SELECT count(*) as c FROM observations_fts WHERE observations_fts MATCH 'topic_key:linting'").pluck().get()
      ).toBe(1);

      // Update topic_key to null
      db.prepare("UPDATE observations SET topic_key = NULL WHERE id = 'obs-toggle'").run();
      expect(
        db.prepare("SELECT count(*) as c FROM observations_fts WHERE observations_fts MATCH 'topic_key:linting'").pluck().get()
      ).toBe(0);
      expect(
        db.prepare("SELECT count(*) as c FROM observations_fts WHERE observations_fts MATCH 'Linter'").pluck().get()
      ).toBe(1);

      // Update topic_key to new value
      db.prepare("UPDATE observations SET topic_key = 'formatting' WHERE id = 'obs-toggle'").run();
      expect(
        db.prepare("SELECT count(*) as c FROM observations_fts WHERE observations_fts MATCH 'topic_key:formatting'").pluck().get()
      ).toBe(1);
    });

    it("indexes and queries unicode, accents, quotes, and multiline content", () => {
      const multiline = "Line 1: Résumé of internationalization 🚀\nLine 2: Single 'quotes' and \"double quotes\"\nLine 3: 简体中文 日本語 한국어";
      db.prepare(
        "INSERT INTO observations (id, project_id, category, title, content, topic_key) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("obs-uni", project.id, "discovery", "Internationalization & I18N 🌐", multiline, "i18n");

      const results = db
        .prepare<[string], { title: string }>(
          "SELECT title FROM observations_fts WHERE observations_fts MATCH ?"
        )
        .all("Internationalization");
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Internationalization & I18N 🌐");
    });
  });

  describe("Foreign Key Cascades & Constraints", () => {
    it("deleting a project cascades to observations, entities, and observation_entities", () => {
      const project = ensureProject(db, {
        rootPath: "/test/cascade-repo",
        name: "cascade-repo",
      });

      // Insert observation
      db.prepare(
        "INSERT INTO observations (id, project_id, category, title, content) VALUES (?, ?, ?, ?, ?)"
      ).run("obs-c1", project.id, "decision", "Cascade test title", "Cascade test content");

      // Insert entity
      db.prepare(
        "INSERT INTO entities (id, project_id, entity_type, identifier, file_path) VALUES (?, ?, ?, ?, ?)"
      ).run("ent-1", project.id, "function", "src/auth.ts::login", "src/auth.ts");

      // Link them
      db.prepare(
        "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)"
      ).run("obs-c1", "ent-1");

      // Verify all exist
      expect(
        db.prepare("SELECT count(*) as c FROM observations WHERE id = 'obs-c1'").pluck().get()
      ).toBe(1);
      expect(
        db.prepare("SELECT count(*) as c FROM entities WHERE id = 'ent-1'").pluck().get()
      ).toBe(1);
      expect(
        db.prepare("SELECT count(*) as c FROM observation_entities WHERE observation_id = 'obs-c1'").pluck().get()
      ).toBe(1);
      expect(
        db.prepare("SELECT count(*) as c FROM observations_fts WHERE observations_fts MATCH 'Cascade'").pluck().get()
      ).toBe(1);

      // Delete project
      db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);

      // Verify all were cascade deleted
      expect(
        db.prepare("SELECT count(*) as c FROM observations WHERE id = 'obs-c1'").pluck().get()
      ).toBe(0);
      expect(
        db.prepare("SELECT count(*) as c FROM entities WHERE id = 'ent-1'").pluck().get()
      ).toBe(0);
      expect(
        db.prepare("SELECT count(*) as c FROM observation_entities WHERE observation_id = 'obs-c1'").pluck().get()
      ).toBe(0);
      // FTS table was synchronized via obs_ad cascade trigger
      expect(
        db.prepare("SELECT count(*) as c FROM observations_fts WHERE observations_fts MATCH 'Cascade'").pluck().get()
      ).toBe(0);
    });

    it("deleting an observation cascades to observation_entities and cleans FTS, keeping entity", () => {
      const project = ensureProject(db, {
        rootPath: "/test/obs-cascade",
        name: "obs-cascade",
      });

      db.prepare(
        "INSERT INTO observations (id, project_id, category, title, content) VALUES (?, ?, ?, ?, ?)"
      ).run("obs-c2", project.id, "discovery", "Observation cascade title", "Observation cascade content");

      db.prepare(
        "INSERT INTO entities (id, project_id, entity_type, identifier, file_path) VALUES (?, ?, ?, ?, ?)"
      ).run("ent-2", project.id, "class", "src/user.ts::User", "src/user.ts");

      db.prepare(
        "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)"
      ).run("obs-c2", "ent-2");

      // Delete observation only
      db.prepare("DELETE FROM observations WHERE id = ?").run("obs-c2");

      // Join table row removed
      expect(
        db.prepare("SELECT count(*) as c FROM observation_entities WHERE observation_id = 'obs-c2'").pluck().get()
      ).toBe(0);
      // FTS entry removed
      expect(
        db.prepare("SELECT count(*) as c FROM observations_fts WHERE observations_fts MATCH 'Observation'").pluck().get()
      ).toBe(0);
      // Entity remains intact
      expect(
        db.prepare("SELECT count(*) as c FROM entities WHERE id = 'ent-2'").pluck().get()
      ).toBe(1);
    });

    it("enforces observation category CHECK constraint", () => {
      const project = ensureProject(db, { rootPath: "/test/check-repo" });
      expect(() => {
        db.prepare(
          "INSERT INTO observations (id, project_id, category, title, content) VALUES (?, ?, ?, ?, ?)"
        ).run("obs-invalid", project.id, "invalid_category", "Title", "Content");
      }).toThrow(/CHECK constraint failed/);
    });

    it("enforces entity_type CHECK constraint", () => {
      const project = ensureProject(db, { rootPath: "/test/check-repo-2" });
      expect(() => {
        db.prepare(
          "INSERT INTO entities (id, project_id, entity_type, identifier, file_path) VALUES (?, ?, ?, ?, ?)"
        ).run("ent-invalid", project.id, "invalid_type", "src/foo.ts", "src/foo.ts");
      }).toThrow(/CHECK constraint failed/);
    });

    it("accepts all valid observation categories", () => {
      const project = ensureProject(db, { rootPath: "/test/categories-repo" });
      const categories: ObservationCategory[] = [
        "decision",
        "convention",
        "discovery",
        "bugfix",
        "architecture",
      ];

      for (const cat of categories) {
        expect(() => {
          db.prepare(
            "INSERT INTO observations (id, project_id, category, title, content) VALUES (?, ?, ?, ?, ?)"
          ).run(`obs-${cat}`, project.id, cat, `Title ${cat}`, `Content ${cat}`);
        }).not.toThrow();

        const row = db
          .prepare<[string], Observation>("SELECT * FROM observations WHERE id = ?")
          .get(`obs-${cat}`);
        expect(row?.category).toBe(cat);
      }
    });

    it("accepts all valid entity types", () => {
      const project = ensureProject(db, { rootPath: "/test/entities-repo" });
      const entityTypes: EntityType[] = [
        "file",
        "function",
        "class",
        "interface",
        "module",
      ];

      for (const et of entityTypes) {
        expect(() => {
          db.prepare(
            "INSERT INTO entities (id, project_id, entity_type, identifier, file_path) VALUES (?, ?, ?, ?, ?)"
          ).run(`ent-${et}`, project.id, et, `src/${et}.ts::ident`, `src/${et}.ts`);
        }).not.toThrow();

        const row = db
          .prepare<[string], Entity>("SELECT * FROM entities WHERE id = ?")
          .get(`ent-${et}`);
        expect(row?.entity_type).toBe(et);
      }
    });

    it("enforces foreign key constraints when inserting observations or entities with invalid project_id", () => {
      expect(() => {
        db.prepare(
          "INSERT INTO observations (id, project_id, category, title, content) VALUES (?, ?, ?, ?, ?)"
        ).run("obs-fk-fail", "non-existent-proj-id", "decision", "Title", "Content");
      }).toThrow(/FOREIGN KEY constraint failed/);

      expect(() => {
        db.prepare(
          "INSERT INTO entities (id, project_id, entity_type, identifier, file_path) VALUES (?, ?, ?, ?, ?)"
        ).run("ent-fk-fail", "non-existent-proj-id", "file", "path.ts", "path.ts");
      }).toThrow(/FOREIGN KEY constraint failed/);
    });

    it("enforces foreign key constraints on observation_entities join table", () => {
      const project = ensureProject(db, { rootPath: "/test/join-fk" });
      db.prepare(
        "INSERT INTO observations (id, project_id, category, title, content) VALUES (?, ?, ?, ?, ?)"
      ).run("obs-valid", project.id, "decision", "Title", "Content");

      expect(() => {
        db.prepare(
          "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)"
        ).run("obs-valid", "non-existent-entity");
      }).toThrow(/FOREIGN KEY constraint failed/);

      expect(() => {
        db.prepare(
          "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)"
        ).run("non-existent-obs", "ent-valid");
      }).toThrow(/FOREIGN KEY constraint failed/);
    });

    it("enforces composite primary key uniqueness on observation_entities", () => {
      const project = ensureProject(db, { rootPath: "/test/pk-repo" });
      db.prepare(
        "INSERT INTO observations (id, project_id, category, title, content) VALUES (?, ?, ?, ?, ?)"
      ).run("obs-pk", project.id, "decision", "Title", "Content");
      db.prepare(
        "INSERT INTO entities (id, project_id, entity_type, identifier, file_path) VALUES (?, ?, ?, ?, ?)"
      ).run("ent-pk", project.id, "file", "file.ts", "file.ts");

      db.prepare(
        "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)"
      ).run("obs-pk", "ent-pk");

      expect(() => {
        db.prepare(
          "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)"
        ).run("obs-pk", "ent-pk");
      }).toThrow(/UNIQUE constraint failed: observation_entities.observation_id, observation_entities.entity_id|PRIMARY KEY/);
    });

    it("deleting an entity cascades to observation_entities while keeping observation and FTS", () => {
      const project = ensureProject(db, { rootPath: "/test/entity-cascade" });
      db.prepare(
        "INSERT INTO observations (id, project_id, category, title, content) VALUES (?, ?, ?, ?, ?)"
      ).run("obs-ec", project.id, "discovery", "Entity cascade test", "Content");
      db.prepare(
        "INSERT INTO entities (id, project_id, entity_type, identifier, file_path) VALUES (?, ?, ?, ?, ?)"
      ).run("ent-ec", project.id, "module", "src/mod.ts", "src/mod.ts");
      db.prepare(
        "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)"
      ).run("obs-ec", "ent-ec");

      // Delete entity
      db.prepare("DELETE FROM entities WHERE id = ?").run("ent-ec");

      // Join table row removed
      expect(
        db.prepare("SELECT count(*) as c FROM observation_entities WHERE entity_id = 'ent-ec'").pluck().get()
      ).toBe(0);
      // Observation remains
      expect(
        db.prepare("SELECT count(*) as c FROM observations WHERE id = 'obs-ec'").pluck().get()
      ).toBe(1);
      // FTS remains
      expect(
        db.prepare("SELECT count(*) as c FROM observations_fts WHERE observations_fts MATCH 'cascade'").pluck().get()
      ).toBe(1);
    });

    it("enforces uniqueness on entities(project_id, identifier) via idx_entities_project_identifier", () => {
      const project1 = ensureProject(db, { rootPath: "/test/unique-entity-repo-1" });
      const project2 = ensureProject(db, { rootPath: "/test/unique-entity-repo-2" });

      db.prepare(
        "INSERT INTO entities (id, project_id, entity_type, identifier, file_path) VALUES (?, ?, ?, ?, ?)"
      ).run("ent-1", project1.id, "file", "src/index.ts", "src/index.ts");

      // Same project and same identifier should violate the unique index
      expect(() => {
        db.prepare(
          "INSERT INTO entities (id, project_id, entity_type, identifier, file_path) VALUES (?, ?, ?, ?, ?)"
        ).run("ent-2", project1.id, "function", "src/index.ts", "src/different.ts");
      }).toThrow(/UNIQUE constraint failed: entities\.project_id, entities\.identifier/);

      // Same identifier in a different project should succeed
      expect(() => {
        db.prepare(
          "INSERT INTO entities (id, project_id, entity_type, identifier, file_path) VALUES (?, ?, ?, ?, ?)"
        ).run("ent-3", project2.id, "file", "src/index.ts", "src/index.ts");
      }).not.toThrow();
    });

    it("enforces uniqueness on projects(root_path)", () => {
      const project = ensureProject(db, { rootPath: "/test/unique-root-repo" });
      expect(() => {
        db.prepare(
          "INSERT INTO projects (id, name, git_remote, root_path) VALUES (?, ?, ?, ?)"
        ).run("proj-duplicate", "duplicate", null, project.root_path);
      }).toThrow(/UNIQUE constraint failed: projects\.root_path/);
    });
  });

  describe("ensureProject idempotency", () => {
    it("returns existing project when rootPath already exists", () => {
      const root = "/Users/developer/awesome-project";
      const p1 = ensureProject(db, {
        rootPath: root,
        name: "awesome-project",
        gitRemote: "https://github.com/org/awesome-project.git",
      });

      expect(p1.id).toBeDefined();
      expect(p1.name).toBe("awesome-project");
      expect(p1.git_remote).toBe("https://github.com/org/awesome-project.git");
      expect(p1.root_path).toBe(root);

      // Call ensureProject again with the same rootPath
      const p2 = ensureProject(db, {
        rootPath: root,
        name: "different-name",
      });

      // Must be the exact same project
      expect(p2.id).toBe(p1.id);
      expect(p2.name).toBe(p1.name);
      expect(p2.root_path).toBe(p1.root_path);
      expect(p2.git_remote).toBe(p1.git_remote);

      // Verify exactly one row in DB
      const count = db
        .prepare<[string], { c: number }>(
          "SELECT count(*) as c FROM projects WHERE root_path = ?"
        )
        .get(root);
      expect(count?.c).toBe(1);
    });

    it("infers project name from directory when name is not provided", () => {
      const root = "/Users/developer/inferred-repo";
      const project = ensureProject(db, { rootPath: root });
      expect(project.name).toBe("inferred-repo");
    });

    it("creates project with default options resolving to current repo", () => {
      const project = ensureProject(db);
      expect(project.id).toBeDefined();
      expect(project.root_path).toBe(process.cwd());
    });

    it("defaults project name to 'project' when path.basename returns empty string (root '/')", () => {
      const root = path.resolve("/");
      const project = ensureProject(db, { rootPath: root });
      expect(project.name).toBe("project");
      expect(project.root_path).toBe(root);
    });

    it("automatically resolves git remote using tryGetGitRemote when gitRemote is omitted", () => {
      const tempGit = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-auto-remote-"));
      try {
        fs.mkdirSync(path.join(tempGit, ".git"));
        fs.writeFileSync(
          path.join(tempGit, ".git", "config"),
          `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://token123@github.com/my-org/auto-detected.git\n`
        );

        const project = ensureProject(db, { rootPath: tempGit });
        expect(project.git_remote).toBe("https://github.com/my-org/auto-detected.git");
      } finally {
        fs.rmSync(tempGit, { recursive: true, force: true });
      }
    });

    it("throws an error when SELECT project by id returns undefined after INSERT", () => {
      const targetSql = "SELECT id, name, git_remote, root_path, created_at FROM projects WHERE id = ?";
      const originalPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        const stmt = originalPrepare(sql);
        if (sql === targetSql) {
          return {
            ...stmt,
            get: () => undefined,
          } as any;
        }
        return stmt;
      });

      try {
        expect(() =>
          ensureProject(db, { rootPath: "/nonexistent/test/failure" })
        ).toThrow("Failed to create project record for rootPath: /nonexistent/test/failure");
      } finally {
        prepareSpy.mockRestore();
      }
    });
  });

  describe("sanitizeGitRemote", () => {
    it("strips user and password credentials from https remotes", () => {
      const sanitized = sanitizeGitRemote(
        "https://developer:secret_pass123@github.com/my-org/my-repo.git"
      );
      expect(sanitized).toBe("https://github.com/my-org/my-repo.git");
    });

    it("strips tokens embedded in username or password fields", () => {
      const patUrl =
        "https://ghp_1234567890abcdefghijklmnopqrstuvwxyz@github.com/org/repo.git";
      expect(sanitizeGitRemote(patUrl)).toBe("https://github.com/org/repo.git");

      const oauthUrl =
        "https://oauth2:glpat-9876543210zyxwvutsrqponmlkjihgfedcba@gitlab.com/group/project.git";
      expect(sanitizeGitRemote(oauthUrl)).toBe(
        "https://gitlab.com/group/project.git"
      );
    });

    it("preserves remotes without embedded credentials", () => {
      expect(sanitizeGitRemote("https://github.com/my-org/my-repo.git")).toBe(
        "https://github.com/my-org/my-repo.git"
      );
      expect(sanitizeGitRemote("git@github.com:my-org/my-repo.git")).toBe(
        "git@github.com:my-org/my-repo.git"
      );
      expect(sanitizeGitRemote("ssh://git@github.com/my-org/my-repo.git")).toBe(
        "ssh://git@github.com/my-org/my-repo.git"
      );
    });

    it("strips embedded password credentials from ssh URLs", () => {
      expect(
        sanitizeGitRemote(
          "ssh://user:secret@git-server.internal:2222/org/repo.git"
        )
      ).toBe("ssh://git-server.internal:2222/org/repo.git");
    });

    it("uses regex fallback when URL parsing throws on non-standard URLs", () => {
      const nonStandard = "custom-vcs://user:pass@internal-host/repo.git";
      expect(sanitizeGitRemote(nonStandard)).toBe(
        "custom-vcs://internal-host/repo.git"
      );
    });

    it("ensures project saves sanitized git remote even when rawRemote has credentials", () => {
      const project = ensureProject(db, {
        rootPath: "/test/auth-remote-repo",
        name: "auth-remote-repo",
        gitRemote: "https://user:token123@github.com/org/auth-remote-repo.git",
      });

      expect(project.git_remote).toBe(
        "https://github.com/org/auth-remote-repo.git"
      );
    });
  });

  describe("tryGetGitRemote", () => {
    it("returns null when directory has no .git folder", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-no-git-remote-"));
      try {
        expect(tryGetGitRemote(tempDir)).toBeNull();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("returns null when .git exists but config file is missing", () => {
      const tempGit = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-missing-config-"));
      try {
        fs.mkdirSync(path.join(tempGit, ".git"));
        expect(tryGetGitRemote(tempGit)).toBeNull();
      } finally {
        fs.rmSync(tempGit, { recursive: true, force: true });
      }
    });

    it("returns null when .git/config exists but has no origin remote", () => {
      const tempGit = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-no-origin-"));
      try {
        fs.mkdirSync(path.join(tempGit, ".git"));
        fs.writeFileSync(
          path.join(tempGit, ".git", "config"),
          `[core]\n\trepositoryformatversion = 0\n[remote "upstream"]\n\turl = git@github.com:upstream/repo.git\n`
        );
        expect(tryGetGitRemote(tempGit)).toBeNull();
      } finally {
        fs.rmSync(tempGit, { recursive: true, force: true });
      }
    });

    it("extracts and sanitizes origin URL from .git/config", () => {
      const tempGit = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-origin-url-"));
      try {
        fs.mkdirSync(path.join(tempGit, ".git"));
        fs.writeFileSync(
          path.join(tempGit, ".git", "config"),
          `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://user:secret@github.com/org/repo.git\n`
        );
        expect(tryGetGitRemote(tempGit)).toBe("https://github.com/org/repo.git");
      } finally {
        fs.rmSync(tempGit, { recursive: true, force: true });
      }
    });

    it("catches and returns null when reading .git/config fails", () => {
      const tempGit = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-read-err-"));
      try {
        fs.mkdirSync(path.join(tempGit, ".git"));
        // Create .git/config as a directory so readFileSync throws EISDIR
        fs.mkdirSync(path.join(tempGit, ".git", "config"));
        expect(tryGetGitRemote(tempGit)).toBeNull();
      } finally {
        fs.rmSync(tempGit, { recursive: true, force: true });
      }
    });
  });
});

/**
 * ADR-49 / REQ-50 — the database file and the project row are resolved from ONE
 * root: the caller's `projectRoot`, never the process working directory. The
 * regression this pins is a `--project X` run from a cwd inside `Y` labelling X's
 * row (and writing X's data) into Y's database.
 */
describe("Muninn one-root resolution (ADR-49)", () => {
  const roots: string[] = [];

  function gitRepo(name: string): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `muninn-${name}-`)));
    roots.push(dir);
    spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
    return dir;
  }

  afterEach(() => {
    while (roots.length > 0) {
      fs.rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("resolves the database from startDir, not the process cwd", () => {
    const project = gitRepo("one-root");
    const db = getDatabase(undefined, project);
    try {
      // The cwd here is the huginn repository, not the project.
      expect(db.name).toBe(path.join(project, ".huginn", "muninn.db"));
      expect(fs.existsSync(path.join(project, ".huginn", "muninn.db"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("keeps the database and the project row on the same root", () => {
    const project = gitRepo("one-row");
    const db = getDatabase(undefined, project);
    try {
      const row = ensureProject(db, { startDir: project });
      expect(row.root_path).toBe(project);

      const target = getDatabase(undefined, project);
      try {
        // Re-opening from the same root finds the same row rather than creating
        // a second one.
        expect(ensureProject(target, { startDir: project }).id).toBe(row.id);
        const count = db.prepare("SELECT count(*) AS n FROM projects").get() as { n: number };
        expect(count.n).toBe(1);
      } finally {
        target.close();
      }
    } finally {
      db.close();
    }
  });

  it("refuses a repository-shipped .huginn symlink instead of writing through it (SEC-005)", () => {
    const project = gitRepo("symlinked");
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "muninn-outside-")));
    roots.push(outside);
    fs.symlinkSync(outside, path.join(project, ".huginn"), "dir");

    expect(() => getDatabase(undefined, project)).toThrow(/outside the project root|symlink/i);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});



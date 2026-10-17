import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import * as clientModule from "../src/db/client.js";
import { getDatabase } from "../src/db/client.js";
import {
  MemoryService,
  sanitizeFtsQuery,
  normalizeSymbol,
  VALID_CATEGORIES,
  type SaveObservationInput,
  type IMemoryService,
} from "../src/service/memory-service.js";

describe("Muninn MemoryService & Persistence Engine", () => {
  let db: Database.Database;
  let service: MemoryService;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-service-test-"));
    db = getDatabase(":memory:");
    service = new MemoryService({ db, projectRoot: tempDir });
  });

  afterEach(() => {
    service.close(true);
    if (db.open) {
      db.close();
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Constructor & Initialization", () => {
    it("initializes successfully with an external db and ensures project", () => {
      expect(service.db).toBe(db);
      expect(service.currentProject).toBeDefined();
      expect(service.currentProject.id).toBeTypeOf("string");
      expect(service.currentProject.root_path).toBe(path.resolve(tempDir));
    });

    it("initializes an internal db when no db is provided and closes it on close()", () => {
      const internalDir = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-internal-"));
      try {
        const ownedService = new MemoryService({
          dbPath: ":memory:",
          projectRoot: internalDir,
        });
        expect(ownedService.db).toBeDefined();
        expect(ownedService.db.open).toBe(true);
        expect(ownedService.currentProject.root_path).toBe(path.resolve(internalDir));

        ownedService.close();
        expect(ownedService.db.open).toBe(false);
      } finally {
        fs.rmSync(internalDir, { recursive: true, force: true });
      }
    });

    it("does not close external db on close() unless force is true", () => {
      service.close(); // isDbOwned is false
      expect(db.open).toBe(true);

      service.close(true); // force close
      expect(db.open).toBe(false);
    });

    it("closes owned database if ensureProject throws in constructor (SEC-003)", () => {
      let openedDb: Database.Database | undefined;
      const getDbSpy = vi
        .spyOn(clientModule, "getDatabase")
        .mockImplementationOnce((dbPath?: string) => {
          openedDb = getDatabase(dbPath);
          return openedDb;
        });

      const ensureSpy = vi
        .spyOn(clientModule, "ensureProject")
        .mockImplementationOnce(() => {
          throw new Error("Simulated ensureProject failure");
        });

      try {
        expect(() => {
          new MemoryService({ dbPath: ":memory:" });
        }).toThrow("Simulated ensureProject failure");

        expect(openedDb).toBeDefined();
        expect(openedDb!.open).toBe(false);
      } finally {
        getDbSpy.mockRestore();
        ensureSpy.mockRestore();
      }
    });

    it("does not close external database if ensureProject throws in constructor (SEC-003)", () => {
      const extDb = getDatabase(":memory:");
      const ensureSpy = vi
        .spyOn(clientModule, "ensureProject")
        .mockImplementationOnce(() => {
          throw new Error("Simulated external failure");
        });

      try {
        expect(() => {
          new MemoryService({ db: extDb });
        }).toThrow("Simulated external failure");

        expect(extDb.open).toBe(true);
      } finally {
        extDb.close();
        ensureSpy.mockRestore();
      }
    });

    it("does not throw if close() is called multiple times on an already closed database", () => {
      service.close(true);
      expect(() => service.close(true)).not.toThrow();
    });
  });

  describe("normalizeSymbol helper", () => {
    it("normalizes string symbols with :: delimiter", () => {
      const norm = normalizeSymbol("src/muninn/db/client.ts::getDatabase");
      expect(norm.identifier).toBe("src/muninn/db/client.ts::getDatabase");
      expect(norm.filePath).toBe("src/muninn/db/client.ts");
      expect(norm.entityType).toBe("module");
    });

    it("normalizes string symbols representing file paths", () => {
      const norm = normalizeSymbol("src/muninn/service/memory-service.ts");
      expect(norm.identifier).toBe("src/muninn/service/memory-service.ts");
      expect(norm.filePath).toBe("src/muninn/service/memory-service.ts");
      expect(norm.entityType).toBe("file");
    });

    it("normalizes simple string symbol without path", () => {
      const norm = normalizeSymbol("MyCustomSymbol");
      expect(norm.identifier).toBe("MyCustomSymbol");
      expect(norm.filePath).toBe("unknown");
      expect(norm.entityType).toBe("module");
    });

    it("normalizes object symbol with name and filePath", () => {
      const norm = normalizeSymbol({
        name: "saveObservation",
        filePath: "src/muninn/service/memory-service.ts",
        type: "function",
      });
      expect(norm.identifier).toBe(
        "src/muninn/service/memory-service.ts::saveObservation"
      );
      expect(norm.filePath).toBe("src/muninn/service/memory-service.ts");
      expect(norm.entityType).toBe("function");
    });

    it("normalizes object symbol with explicit identifier", () => {
      const norm = normalizeSymbol({
        identifier: "App::startServer",
        type: "function",
      });
      expect(norm.identifier).toBe("App::startServer");
      expect(norm.filePath).toBe("App");
      expect(norm.entityType).toBe("function");
    });

    it("defaults to file type when only filePath is provided (REV-003)", () => {
      const norm = normalizeSymbol({
        filePath: "README.md",
      });
      expect(norm.identifier).toBe("README.md");
      expect(norm.filePath).toBe("README.md");
      expect(norm.entityType).toBe("file");
    });

    it("handles null, undefined, empty string, and corrupted symbols safely (REV-002)", () => {
      expect(normalizeSymbol(null as any)).toEqual({
        identifier: "unknown",
        filePath: "unknown",
        entityType: "module",
      });
      expect(normalizeSymbol(undefined as any)).toEqual({
        identifier: "unknown",
        filePath: "unknown",
        entityType: "module",
      });
      expect(normalizeSymbol("" as any)).toEqual({
        identifier: "unknown",
        filePath: "unknown",
        entityType: "module",
      });
      expect(normalizeSymbol("   " as any)).toEqual({
        identifier: "unknown",
        filePath: "unknown",
        entityType: "module",
      });
      expect(normalizeSymbol(123 as any)).toEqual({
        identifier: "unknown",
        filePath: "unknown",
        entityType: "module",
      });
      expect(normalizeSymbol(false as any)).toEqual({
        identifier: "unknown",
        filePath: "unknown",
        entityType: "module",
      });
    });

    it("normalizes string symbols with empty file part in :: delimiter", () => {
      const norm = normalizeSymbol("::mySymbol");
      expect(norm.identifier).toBe("::mySymbol");
      expect(norm.filePath).toBe("unknown");
      expect(norm.entityType).toBe("module");
    });

    it("normalizes string symbols ending with .json as file", () => {
      const norm = normalizeSymbol("package.json");
      expect(norm.identifier).toBe("package.json");
      expect(norm.filePath).toBe("package.json");
      expect(norm.entityType).toBe("file");
    });

    it("normalizes object symbol with only name", () => {
      const norm = normalizeSymbol({ name: "myFunction" });
      expect(norm.identifier).toBe("myFunction");
      expect(norm.filePath).toBe("unknown");
      expect(norm.entityType).toBe("module");
    });

    it("normalizes empty object symbol to unknown", () => {
      const norm = normalizeSymbol({});
      expect(norm.identifier).toBe("unknown");
      expect(norm.filePath).toBe("unknown");
      expect(norm.entityType).toBe("module");
    });

    it("normalizes object symbol with identifier ending with .ts, .js, or .json (REV-003)", () => {
      const tsNorm = normalizeSymbol({ identifier: "index.ts" });
      expect(tsNorm.identifier).toBe("index.ts");
      expect(tsNorm.filePath).toBe("index.ts");
      expect(tsNorm.entityType).toBe("module");

      const jsNorm = normalizeSymbol({ identifier: "index.js" });
      expect(jsNorm.identifier).toBe("index.js");
      expect(jsNorm.filePath).toBe("index.js");
      expect(jsNorm.entityType).toBe("module");

      const jsonNorm = normalizeSymbol({ identifier: "config.json" });
      expect(jsonNorm.identifier).toBe("config.json");
      expect(jsonNorm.filePath).toBe("config.json");
      expect(jsonNorm.entityType).toBe("module");
    });

    it("normalizes object symbol with identifier starting with ::", () => {
      const norm = normalizeSymbol({ identifier: "::start" });
      expect(norm.identifier).toBe("::start");
      expect(norm.filePath).toBe("unknown");
      expect(norm.entityType).toBe("module");
    });

    it("normalizes object symbol with identifier containing no slash or ::", () => {
      const norm = normalizeSymbol({ identifier: "isolatedSymbol" });
      expect(norm.identifier).toBe("isolatedSymbol");
      expect(norm.filePath).toBe("unknown");
      expect(norm.entityType).toBe("module");
    });

    it("normalizes object symbol with name 'default' and filePath as file type without appending ::default (REV-003)", () => {
      const norm = normalizeSymbol({ filePath: "src/main.ts", name: "default" });
      expect(norm.identifier).toBe("src/main.ts");
      expect(norm.filePath).toBe("src/main.ts");
      expect(norm.entityType).toBe("file");
    });

    it("normalizes object symbol with non-default name and filePath", () => {
      const norm = normalizeSymbol({ filePath: "src/main.ts", name: "startServer" });
      expect(norm.identifier).toBe("src/main.ts::startServer");
      expect(norm.filePath).toBe("src/main.ts");
    });

    it("normalizes object symbol with snake_case file_path and entity_type without ::default (REV-003)", () => {
      const norm = normalizeSymbol({
        file_path: "src/test.ts",
        entity_type: "file",
      });
      expect(norm.identifier).toBe("src/test.ts");
      expect(norm.filePath).toBe("src/test.ts");
      expect(norm.entityType).toBe("file");
    });

    it("normalizes object symbol with unsupported entity type and without filePath to module", () => {
      const norm = normalizeSymbol({ name: "foo", type: "custom_type" as any });
      expect(norm.entityType).toBe("module");
    });
  });

  describe("saveObservation", () => {
    it("saves observations across all allowed categories", () => {
      for (const category of VALID_CATEGORIES) {
        const obs = service.saveObservation({
          category,
          title: `Observation for ${category}`,
          content: `Content details for ${category}`,
          topicKey: `topic-${category}`,
        });

        expect(obs.id).toBeDefined();
        expect(obs.category).toBe(category);
        expect(obs.title).toBe(`Observation for ${category}`);
        expect(obs.content).toBe(`Content details for ${category}`);
        expect(obs.topic_key).toBe(`topic-${category}`);
        expect(obs.project_id).toBe(service.currentProject.id);
        expect(obs.created_at).toBeDefined();
        expect(obs.updated_at).toBeDefined();
        expect(obs.entities).toEqual([]);
      }
    });

    it("throws error when category is invalid", () => {
      expect(() => {
        service.saveObservation({
          category: "invalid_category" as any,
          title: "Invalid observation",
          content: "Content",
        });
      }).toThrow(/Invalid category "invalid_category"/);
    });

    it("throws error when title is empty or missing", () => {
      expect(() => {
        service.saveObservation({
          category: "decision",
          title: "",
          content: "Content",
        });
      }).toThrow(/title is required/);

      expect(() => {
        service.saveObservation({
          category: "decision",
          title: "   ",
          content: "Content",
        });
      }).toThrow(/title is required/);
    });

    it("throws error when content is missing", () => {
      expect(() => {
        service.saveObservation({
          category: "decision",
          title: "Valid title",
          content: undefined as any,
        });
      }).toThrow(/content is required/);
    });

    it("creates, links, and attaches symbols when symbols array is provided", () => {
      const obs = service.saveObservation({
        category: "architecture",
        title: "Persistence Layer Architecture",
        content: "We use SQLite FTS5 for full-text search.",
        symbols: [
          {
            name: "getDatabase",
            filePath: "src/muninn/db/client.ts",
            type: "function",
          },
          {
            identifier: "src/muninn/service/memory-service.ts",
            type: "file",
          },
          "src/muninn/db/schema.sql",
        ],
      });

      expect(obs.entities).toHaveLength(3);
      const identifiers = obs.entities.map((e) => e.identifier);
      expect(identifiers).toContain("src/muninn/db/client.ts::getDatabase");
      expect(identifiers).toContain("src/muninn/service/memory-service.ts");
      expect(identifiers).toContain("src/muninn/db/schema.sql");

      const fnEntity = obs.entities.find((e) => e.identifier.includes("getDatabase"));
      expect(fnEntity?.entity_type).toBe("function");
      expect(fnEntity?.file_path).toBe("src/muninn/db/client.ts");
    });

    it("deduplicates identical symbols within the same observation", () => {
      const obs = service.saveObservation({
        category: "decision",
        title: "Deduplication Test",
        content: "Testing symbol deduplication in saveObservation.",
        symbols: [
          {
            name: "execute",
            filePath: "src/engine.ts",
            type: "function",
          },
          {
            name: "execute",
            filePath: "src/engine.ts",
            type: "function",
          },
          "src/engine.ts::execute",
        ],
      });

      expect(obs.entities).toHaveLength(1);
      expect(obs.entities[0].identifier).toBe("src/engine.ts::execute");
    });

    it("reuses existing entities across multiple observations without duplicating entity records", () => {
      const obs1 = service.saveObservation({
        category: "decision",
        title: "First Reference",
        content: "First note referencing MemoryService.",
        symbols: [
          {
            identifier: "MemoryService",
            filePath: "src/muninn/service/memory-service.ts",
            type: "class",
          },
        ],
      });

      const obs2 = service.saveObservation({
        category: "discovery",
        title: "Second Reference",
        content: "Second note referencing MemoryService.",
        symbols: [
          {
            identifier: "MemoryService",
            filePath: "src/muninn/service/memory-service.ts",
            type: "class",
          },
        ],
      });

      expect(obs1.entities[0].id).toBe(obs2.entities[0].id);

      const entityCount = db
        .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM entities")
        .get()?.count;
      expect(entityCount).toBe(1);

      const linkCount = db
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) as count FROM observation_entities"
        )
        .get()?.count;
      expect(linkCount).toBe(2);
    });

    it("supports snake_case topic_key and project_id in input", () => {
      const obs = service.saveObservation({
        category: "bugfix",
        title: "Snake case input support",
        content: "Testing snake case options",
        topic_key: "snake_topic",
        project_id: service.currentProject.id,
      });

      expect(obs.topic_key).toBe("snake_topic");
      expect(obs.project_id).toBe(service.currentProject.id);
    });

    it("throws error when observation retrieval fails after insert", () => {
      const origPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (
          typeof sql === "string" &&
          sql.includes("SELECT id, project_id, category, title, content")
        ) {
          return {
            get: () => undefined,
          } as any;
        }
        return origPrepare(sql);
      });

      try {
        expect(() => {
          service.saveObservation({
            category: "decision",
            title: "Failing retrieval observation",
            content: "Details",
          });
        }).toThrow(/Failed to retrieve newly created observation/);
      } finally {
        prepareSpy.mockRestore();
      }
    });
  });

  describe("sanitizeFtsQuery helper", () => {
    it("returns empty string for empty or blank queries", () => {
      expect(sanitizeFtsQuery("")).toBe("");
      expect(sanitizeFtsQuery("   ")).toBe("");
      expect(sanitizeFtsQuery(null as any)).toBe("");
      expect(sanitizeFtsQuery(undefined as any)).toBe("");
    });

    it("safely handles special characters, punctuation, colons, slashes, and dashes", () => {
      expect(sanitizeFtsQuery("src/muninn/db/client.ts")).toBe(
        '"src/muninn/db/client.ts"'
      );
      expect(sanitizeFtsQuery("MemoryService::saveObservation")).toBe(
        '"MemoryService::saveObservation"'
      );
      expect(sanitizeFtsQuery("test-case")).toBe('"test-case"');
      expect(sanitizeFtsQuery("category:architecture")).toBe(
        '"category:architecture"'
      );
    });

    it("safely preserves prefix queries ending with *", () => {
      expect(sanitizeFtsQuery("arch*")).toBe('"arch"*');
      expect(sanitizeFtsQuery("Memory*")).toBe('"Memory"*');
    });

    it("strips standalone syntax operators and pure punctuation that would break FTS5", () => {
      expect(sanitizeFtsQuery("*")).toBe("");
      expect(sanitizeFtsQuery("***")).toBe("");
      expect(sanitizeFtsQuery("///")).toBe("");
      expect(sanitizeFtsQuery("---")).toBe("");
      expect(sanitizeFtsQuery(":::")).toBe("");
      expect(sanitizeFtsQuery("()()()")).toBe("");
    });

    it("preserves explicitly quoted phrases and handles unclosed quotes", () => {
      expect(sanitizeFtsQuery('"SQLite persistence"')).toBe(
        '"SQLite persistence"'
      );
      expect(sanitizeFtsQuery('"unclosed quote')).toBe('"unclosed" "quote"');
      expect(sanitizeFtsQuery("AND OR NOT")).toBe('"AND" "OR" "NOT"');
    });

    it("safely handles tokens resulting in empty strings after quote stripping", () => {
      expect(sanitizeFtsQuery('test " " query')).toBe('"test" "query"');
      expect(sanitizeFtsQuery('"""')).toBe("");
      expect(sanitizeFtsQuery('""')).toBe("");
    });

    it("handles wildcard with non-alphanumeric base", () => {
      expect(sanitizeFtsQuery("-*")).toBe("");
      expect(sanitizeFtsQuery("**")).toBe("");
    });

    it("ignores quotes containing only punctuation", () => {
      expect(sanitizeFtsQuery('"!@#$%^"')).toBe("");
    });
  });

  describe("search with FTS5 BM25 Ranking", () => {
    beforeEach(() => {
      // Seed observations with varied term frequencies and categories
      service.saveObservation({
        category: "architecture",
        title: "SQLite Architecture & Engine Design in schema.sql",
        content:
          "The architecture relies heavily on SQLite architecture patterns in src/muninn/db/schema.sql, with SQLite WAL mode and FTS5 architecture.",
        topicKey: "arch-pattern",
        symbols: ["src/muninn/db/schema.sql"],
      });

      service.saveObservation({
        category: "convention",
        title: "Coding Convention",
        content: "We follow clean architecture naming conventions in our project.",
        topicKey: "conventions",
      });

      service.saveObservation({
        category: "bugfix",
        title: "Bugfix for Parser Tokenizer in src/plan/parser.ts",
        content: "Fixed a bug in src/plan/parser.ts where tokenizer failed on slash / character.",
        topicKey: "tokenizer",
        symbols: ["src/plan/parser.ts"],
      });

      service.saveObservation({
        category: "decision",
        title: "Decision on Storage Engine",
        content: "Decided to use SQLite rather than Postgres for local persistence.",
        topicKey: "storage-choice",
      });
    });

    it("returns empty array for blank or whitespace query without throwing", () => {
      expect(service.search({ query: "" })).toEqual([]);
      expect(service.search({ query: "   " })).toEqual([]);
      expect(service.search({ query: "***" })).toEqual([]);
      expect(service.search({ query: "///" })).toEqual([]);
    });

    it("ranks most relevant results first using BM25 rank ASC", () => {
      const results = service.search({ query: "architecture" });
      expect(results.length).toBeGreaterThanOrEqual(2);

      // The observation with 3 mentions of "architecture" must have a lower (more negative) rank
      // and therefore appear first.
      expect(results[0].title).toBe("SQLite Architecture & Engine Design in schema.sql");
      expect(results[1].title).toBe("Coding Convention");
      expect(results[0].rank).toBeLessThan(results[1].rank);
    });

    it("attaches linked entities to search results", () => {
      const results = service.search({ query: "schema.sql" });
      expect(results.length).toBe(1);
      expect(results[0].entities).toHaveLength(1);
      expect(results[0].entities[0].identifier).toBe("src/muninn/db/schema.sql");
    });

    it("filters search results by category", () => {
      const allMatches = service.search({ query: "SQLite" });
      expect(allMatches.length).toBe(2);

      const archOnly = service.search({
        query: "SQLite",
        category: "architecture",
      });
      expect(archOnly).toHaveLength(1);
      expect(archOnly[0].category).toBe("architecture");
      expect(archOnly[0].title).toBe("SQLite Architecture & Engine Design in schema.sql");

      const decisionOnly = service.search({
        query: "SQLite",
        category: "decision",
      });
      expect(decisionOnly).toHaveLength(1);
      expect(decisionOnly[0].category).toBe("decision");
      expect(decisionOnly[0].title).toBe("Decision on Storage Engine");
    });

    it("filters search results by projectId", () => {
      const results = service.search({
        query: "SQLite",
        projectId: service.currentProject.id,
      });
      expect(results.length).toBe(2);

      const nonExistent = service.search({
        query: "SQLite",
        projectId: "non-existent-project-id",
      });
      expect(nonExistent).toHaveLength(0);
    });

    it("respects the limit option and defaults to 10", () => {
      const limited = service.search({ query: "SQLite", limit: 1 });
      expect(limited).toHaveLength(1);

      const defaultLimit = service.search({ query: "SQLite" });
      expect(defaultLimit.length).toBeLessThanOrEqual(10);
    });

    it("clamps limit in search between 1 and 500 (SEC-002)", () => {
      const zeroLimit = service.search({ query: "SQLite", limit: 0 });
      expect(zeroLimit.length).toBeLessThanOrEqual(1);

      const negLimit = service.search({ query: "SQLite", limit: -5 });
      expect(negLimit.length).toBeLessThanOrEqual(1);

      const largeLimit = service.search({ query: "SQLite", limit: 1000 });
      expect(largeLimit.length).toBeLessThanOrEqual(500);
    });

    it("handles complex punctuation, slashes, and colons in query without throwing FTS5 syntax errors", () => {
      const queries = [
        "src/plan/parser.ts",
        "category:architecture",
        "bugfix-parser",
        "slash / character",
        "SQLite*",
        "test:case-study/part.1",
        "!@#$%^&*()",
      ];

      for (const q of queries) {
        expect(() => service.search({ query: q })).not.toThrow();
      }

      const slashResults = service.search({ query: "src/plan/parser.ts" });
      expect(slashResults.length).toBe(1);
      expect(slashResults[0].title).toBe("Bugfix for Parser Tokenizer in src/plan/parser.ts");
    });

    it("supports prefix search with asterisk (*)", () => {
      const results = service.search({ query: "token*" });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe("Bugfix for Parser Tokenizer in src/plan/parser.ts");
    });

    it("gracefully handles database errors during FTS search and returns empty array", () => {
      const origPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementationOnce((sql: string) => {
        if (typeof sql === "string" && sql.includes("observations_fts")) {
          return {
            all: () => {
              throw new Error("Simulated FTS execution failure");
            },
          } as any;
        }
        return origPrepare(sql);
      });

      try {
        const results = service.search({ query: "architecture" });
        expect(results).toEqual([]);
      } finally {
        prepareSpy.mockRestore();
      }
    });

    it("throws and logs unexpected database fatal errors (disk I/O, database corruption)", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Test SQLITE_CORRUPT
      const corruptErr = new Error("database disk image is malformed");
      (corruptErr as any).code = "SQLITE_CORRUPT";
      const corruptSpy = vi.spyOn(db, "prepare").mockImplementationOnce(() => {
        return {
          all: () => {
            throw corruptErr;
          },
        } as any;
      });

      try {
        expect(() => service.search({ query: "architecture" })).toThrow(/malformed/);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Fatal SQLite error"),
          corruptErr
        );
      } finally {
        corruptSpy.mockRestore();
      }

      // Test SQLITE_IOERR
      const ioErr = new Error("disk I/O error");
      (ioErr as any).code = "SQLITE_IOERR_SHORT_READ";
      const ioSpy = vi.spyOn(db, "prepare").mockImplementationOnce(() => {
        return {
          all: () => {
            throw ioErr;
          },
        } as any;
      });

      try {
        expect(() => service.search({ query: "architecture" })).toThrow(/disk I\/O/);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Fatal SQLite error"),
          ioErr
        );
      } finally {
        ioSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("verifies MemoryService satisfies IMemoryService interface", () => {
      const ims: IMemoryService = service;
      expect(ims.currentProject).toBeDefined();
      expect(ims.db).toBeDefined();
      expect(typeof ims.saveObservation).toBe("function");
      expect(typeof ims.search).toBe("function");
      expect(typeof ims.getContext).toBe("function");
      expect(typeof ims.linkSymbol).toBe("function");
      expect(typeof ims.getStats).toBe("function");
      expect(typeof ims.syncToDisk).toBe("function");
      expect(typeof ims.importFromDisk).toBe("function");
      expect(typeof ims.close).toBe("function");
    });

    it("supports search filtering with snake_case project_id", () => {
      const results = service.search({
        query: "SQLite",
        project_id: service.currentProject.id,
      });
      expect(results.length).toBe(2);
    });
  });

  describe("getContext", () => {
    let obs1: any;
    let obs2: any;
    let obs3: any;

    beforeEach(() => {
      obs1 = service.saveObservation({
        category: "decision",
        title: "First Decision",
        content: "Decided on technology stack",
        topicKey: "tech",
        symbols: ["src/tech.ts"],
      });

      obs2 = service.saveObservation({
        category: "convention",
        title: "Coding Style",
        content: "Decided on formatting",
        topicKey: "style",
      });

      obs3 = service.saveObservation({
        category: "decision",
        title: "Second Decision",
        content: "Decided on deployment",
        topicKey: "tech",
      });

      db.prepare(
        "UPDATE observations SET updated_at = '2026-01-01 00:00:01', created_at = '2026-01-01 00:00:01' WHERE id = ?"
      ).run(obs1.id);
      db.prepare(
        "UPDATE observations SET updated_at = '2026-01-01 00:00:02', created_at = '2026-01-01 00:00:02' WHERE id = ?"
      ).run(obs2.id);
      db.prepare(
        "UPDATE observations SET updated_at = '2026-01-01 00:00:03', created_at = '2026-01-01 00:00:03' WHERE id = ?"
      ).run(obs3.id);
    });

    it("retrieves observations ordered by updated_at DESC, created_at DESC", () => {
      const context = service.getContext();
      expect(context.length).toBe(3);

      // Most recent should appear first
      expect(context[0].id).toBe(obs3.id);
      expect(context[1].id).toBe(obs2.id);
      expect(context[2].id).toBe(obs1.id);
    });

    it("attaches linked entities to each observation in context", () => {
      const context = service.getContext();
      const withEntities = context.find((c) => c.id === obs1.id);
      expect(withEntities?.entities).toHaveLength(1);
      expect(withEntities?.entities[0].identifier).toBe("src/tech.ts");
    });

    it("filters getContext by category", () => {
      const decisions = service.getContext({ category: "decision" });
      expect(decisions).toHaveLength(2);
      expect(decisions.every((d) => d.category === "decision")).toBe(true);

      const conventions = service.getContext({ category: "convention" });
      expect(conventions).toHaveLength(1);
      expect(conventions[0].id).toBe(obs2.id);
    });

    it("filters getContext by topicKey", () => {
      const techObs = service.getContext({ topicKey: "tech" });
      expect(techObs).toHaveLength(2);
      expect(techObs.every((o) => o.topic_key === "tech")).toBe(true);

      const styleObs = service.getContext({ topicKey: "style" });
      expect(styleObs).toHaveLength(1);
      expect(styleObs[0].title).toBe("Coding Style");
    });

    it("filters getContext by projectId", () => {
      const currentProjObs = service.getContext({
        projectId: service.currentProject.id,
      });
      expect(currentProjObs).toHaveLength(3);

      const otherProjObs = service.getContext({
        projectId: "unknown-project-id",
      });
      expect(otherProjObs).toHaveLength(0);
    });

    it("respects limit parameter and defaults to 20", () => {
      const limited = service.getContext({ limit: 1 });
      expect(limited).toHaveLength(1);
      expect(limited[0].id).toBe(obs3.id);
    });

    it("clamps limit in getContext between 1 and 500 (SEC-002)", () => {
      const zeroLimit = service.getContext({ limit: 0 });
      expect(zeroLimit).toHaveLength(1);

      const negLimit = service.getContext({ limit: -10 });
      expect(negLimit).toHaveLength(1);

      const largeLimit = service.getContext({ limit: 1000 });
      expect(largeLimit.length).toBeLessThanOrEqual(500);
    });

    it("chunks entity lookup when obsIds exceed 500 without exceeding SQLite parameter bounds (SEC-002)", () => {
      const obsIds: string[] = [];
      db.transaction(() => {
        for (let i = 0; i < 505; i++) {
          const obs = service.saveObservation({
            category: "discovery",
            title: `Bulk Obs ${i}`,
            content: `Bulk content ${i}`,
            symbols: [`bulk-sym-${i}`],
          });
          obsIds.push(obs.id);
        }
      })();

      expect(obsIds).toHaveLength(505);

      const entityMap = (service as any)._fetchEntitiesForObservations(obsIds);
      expect(entityMap.size).toBe(505);
      expect(entityMap.get(obsIds[0])?.[0].identifier).toBe("bulk-sym-0");
      expect(entityMap.get(obsIds[504])?.[0].identifier).toBe("bulk-sym-504");
    });

    it("supports snake_case project_id and topic_key filters", () => {
      const context = service.getContext({
        project_id: service.currentProject.id,
        topic_key: "tech",
      });
      expect(context).toHaveLength(2);
    });

    it("returns empty array when database has no matching observations", () => {
      const results = service.getContext({ category: "bugfix" });
      expect(results).toEqual([]);
    });

    it("returns empty map when _fetchEntitiesForObservations is given empty list", () => {
      const entityMap = (service as any)._fetchEntitiesForObservations([]);
      expect(entityMap.size).toBe(0);
    });
  });

  describe("linkSymbol", () => {
    let observationId: string;

    beforeEach(() => {
      const obs = service.saveObservation({
        category: "discovery",
        title: "Discovered Memory Leak",
        content: "Identified memory leak in connection pooling.",
      });
      observationId = obs.id;
    });

    it("links symbol to observation using object input", () => {
      const result = service.linkSymbol({
        observationId,
        symbol: {
          name: "connectionPool",
          filePath: "src/db/pool.ts",
          type: "class",
        },
      });

      expect(result.observation.id).toBe(observationId);
      expect(result.entity.identifier).toBe("src/db/pool.ts::connectionPool");
      expect(result.entity.entity_type).toBe("class");
      expect(result.entity.file_path).toBe("src/db/pool.ts");

      // Verify DB join table has link
      const links = db
        .prepare<[string], { entity_id: string }>(
          "SELECT entity_id FROM observation_entities WHERE observation_id = ?"
        )
        .all(observationId);
      expect(links).toHaveLength(1);
      expect(links[0].entity_id).toBe(result.entity.id);
    });

    it("links symbol to observation using positional arguments overload", () => {
      const result = service.linkSymbol(
        observationId,
        "src/db/pool.ts::releaseConnection"
      );

      expect(result.observation.id).toBe(observationId);
      expect(result.entity.identifier).toBe("src/db/pool.ts::releaseConnection");
      expect(result.entity.file_path).toBe("src/db/pool.ts");
    });

    it("is idempotent when linking the same symbol multiple times", () => {
      const res1 = service.linkSymbol({
        observationId,
        symbol: "src/db/pool.ts::close",
      });

      const res2 = service.linkSymbol({
        observationId,
        symbol: "src/db/pool.ts::close",
      });

      expect(res1.entity.id).toBe(res2.entity.id);

      const links = db
        .prepare<[string], { entity_id: string }>(
          "SELECT entity_id FROM observation_entities WHERE observation_id = ?"
        )
        .all(observationId);
      expect(links).toHaveLength(1);
    });

    it("throws an error if observationId does not exist", () => {
      expect(() => {
        service.linkSymbol({
          observationId: "non-existent-obs",
          symbol: "src/foo.ts",
        });
      }).toThrow(/Observation with id "non-existent-obs" not found/);
    });

    it("throws an error if observationId or symbol is missing", () => {
      expect(() => {
        service.linkSymbol({ observationId: "", symbol: "src/foo.ts" });
      }).toThrow(/observationId is required/);

      expect(() => {
        service.linkSymbol({ observationId, symbol: "" });
      }).toThrow(/symbol is required/);
    });

    it("throws an error if symbol argument is missing in positional call", () => {
      expect(() => {
        (service.linkSymbol as any)(observationId);
      }).toThrow("Symbol must be provided to linkSymbol");
    });

    it("supports snake_case observation_id in input object", () => {
      const result = service.linkSymbol({
        observation_id: observationId,
        symbol: "src/db/pool.ts::snakeCaseTest",
      });
      expect(result.observation.id).toBe(observationId);
      expect(result.entity.identifier).toBe("src/db/pool.ts::snakeCaseTest");
    });
  });

  describe("getStats", () => {
    it("returns correct zero counts for an empty project", () => {
      const stats = service.getStats();
      expect(stats.projects).toBe(1);
      expect(stats.observations).toBe(0);
      expect(stats.entities).toBe(0);
      expect(stats.links).toBe(0);
    });

    it("updates statistics accurately as observations and entities are created", () => {
      const obs1 = service.saveObservation({
        category: "architecture",
        title: "Stats Test 1",
        content: "Content 1",
        symbols: ["src/a.ts", "src/b.ts"],
      });

      const obs2 = service.saveObservation({
        category: "bugfix",
        title: "Stats Test 2",
        content: "Content 2",
        symbols: ["src/b.ts", "src/c.ts"],
      });

      const stats = service.getStats();
      expect(stats.projects).toBe(1);
      expect(stats.observations).toBe(2);
      expect(stats.entities).toBe(3); // src/a.ts, src/b.ts, src/c.ts (b is reused)
      expect(stats.links).toBe(4); // 2 links from obs1, 2 links from obs2

      // Scoped stats by project
      const projStats = service.getStats(service.currentProject.id);
      expect(projStats).toEqual(stats);

      // Scoped stats for non-existent project
      const emptyStats = service.getStats("non-existent-id");
      expect(emptyStats).toEqual({
        projects: 0,
        observations: 0,
        entities: 0,
        links: 0,
      });
    });

    it("handles undefined count return from database queries gracefully", () => {
      const origPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation(() => {
        return {
          get: () => undefined,
        } as any;
      });

      try {
        const stats = service.getStats();
        expect(stats).toEqual({
          projects: 0,
          observations: 0,
          entities: 0,
          links: 0,
        });

        const projStats = service.getStats(service.currentProject.id);
        expect(projStats).toEqual({
          projects: 0,
          observations: 0,
          entities: 0,
          links: 0,
        });
      } finally {
        prepareSpy.mockRestore();
      }
    });
  });

  describe("syncToDisk and importFromDisk roundtrip idempotency", () => {
    it("syncs empty observations to disk without error", () => {
      const exportPath = path.join(tempDir, "empty-memories.jsonl");
      const res = service.syncToDisk(exportPath);

      expect(res.path).toBe(exportPath);
      expect(res.count).toBe(0);
      expect(fs.existsSync(exportPath)).toBe(true);
      expect(fs.readFileSync(exportPath, "utf-8")).toBe("");
    });

    it("exports observations and attached entities as valid JSON Lines (.jsonl)", () => {
      service.saveObservation({
        category: "decision",
        title: "Obs 1",
        content: "Content 1",
        topicKey: "topic-1",
        symbols: ["src/service.ts::save"],
      });

      service.saveObservation({
        category: "architecture",
        title: "Obs 2",
        content: "Content 2",
        topicKey: "topic-2",
        symbols: ["src/db/client.ts"],
      });

      const exportPath = path.join(tempDir, "memories.jsonl");
      const res = service.syncToDisk(exportPath);

      expect(res.path).toBe(exportPath);
      expect(res.count).toBe(2);

      const content = fs.readFileSync(exportPath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);

      const record1 = JSON.parse(lines[0]);
      expect(record1.title).toBe("Obs 1");
      expect(record1.category).toBe("decision");
      expect(record1.entities).toHaveLength(1);
      expect(record1.entities[0].identifier).toBe("src/service.ts::save");

      const record2 = JSON.parse(lines[1]);
      expect(record2.title).toBe("Obs 2");
      expect(record2.category).toBe("architecture");
      expect(record2.entities).toHaveLength(1);
      expect(record2.entities[0].identifier).toBe("src/db/client.ts");
    });

    it("performs full roundtrip export and import idempotently across fresh database instances", () => {
      // 1. Populate original service
      const obs1 = service.saveObservation({
        category: "decision",
        title: "Original Decision",
        content: "Roundtrip test decision details.",
        topicKey: "roundtrip",
        symbols: [
          {
            name: "MemoryService",
            filePath: "src/muninn/service/memory-service.ts",
            type: "class",
          },
          "src/config.ts",
        ],
      });

      const obs2 = service.saveObservation({
        category: "convention",
        title: "Original Convention",
        content: "Roundtrip test convention details.",
        symbols: ["src/config.ts"],
      });

      const exportPath = path.join(tempDir, "export-test.jsonl");
      const syncResult = service.syncToDisk(exportPath);
      expect(syncResult.count).toBe(2);

      // 2. Create a second independent database and service
      const db2 = getDatabase(":memory:");
      const service2 = new MemoryService({ db: db2, projectRoot: tempDir });

      try {
        // Initial import into empty database
        const firstImport = service2.importFromDisk(exportPath);
        expect(firstImport.imported).toBe(2);
        expect(firstImport.skipped).toBe(0);

        // Verify imported observations and entities in service2
        const context = service2.getContext();
        expect(context).toHaveLength(2);

        const importedObs1 = context.find((c) => c.title === "Original Decision");
        expect(importedObs1).toBeDefined();
        expect(importedObs1?.category).toBe("decision");
        expect(importedObs1?.topic_key).toBe("roundtrip");
        expect(importedObs1?.entities).toHaveLength(2);

        const importedObs2 = context.find((c) => c.title === "Original Convention");
        expect(importedObs2).toBeDefined();
        expect(importedObs2?.entities).toHaveLength(1);

        // Verify FTS search works seamlessly on imported observations
        const searchResults = service2.search({ query: "Roundtrip" });
        expect(searchResults).toHaveLength(2);

        // 3. Second import (test idempotency)
        const secondImport = service2.importFromDisk(exportPath);
        expect(secondImport.imported).toBe(0);
        expect(secondImport.skipped).toBe(2);

        // Total observations count remains 2
        const stats = service2.getStats();
        expect(stats.observations).toBe(2);
        expect(stats.entities).toBe(2);
      } finally {
        service2.close(true);
        if (db2.open) {
          db2.close();
        }
      }
    });

    it("returns { imported: 0, skipped: 0 } when source file does not exist", () => {
      const nonExistentPath = path.join(tempDir, "does-not-exist.jsonl");
      const res = service.importFromDisk(nonExistentPath);
      expect(res).toEqual({ imported: 0, skipped: 0 });
    });

    it("ignores malformed JSON lines during import without aborting valid lines", () => {
      const mixedPath = path.join(tempDir, "mixed.jsonl");
      const validRecord = {
        id: "valid-1",
        project_id: service.currentProject.id,
        category: "bugfix",
        title: "Valid Observation",
        content: "Valid content",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        entities: [],
      };

      const fileContent = [
        "not a json line",
        JSON.stringify(validRecord),
        "{ corrupt: json [",
        "",
      ].join("\n");

      fs.writeFileSync(mixedPath, fileContent, "utf-8");

      const res = service.importFromDisk(mixedPath);
      expect(res.imported).toBe(1);
      expect(res.skipped).toBe(0);

      const obs = service.getContext();
      expect(obs).toHaveLength(1);
      expect(obs[0].id).toBe("valid-1");
    });

    it("resolves relative path to project root_path and sets file mode 0o600 in syncToDisk (SEC-001)", () => {
      service.saveObservation({
        category: "decision",
        title: "Relative Sync Obs",
        content: "Testing relative path resolution.",
      });

      const relPath = "backup/data/memories-rel.jsonl";
      const result = service.syncToDisk(relPath);
      const expectedPath = path.resolve(service.currentProject.root_path, relPath);

      expect(result.path).toBe(expectedPath);
      expect(fs.existsSync(expectedPath)).toBe(true);

      // Verify atomic write: .tmp file is cleaned up / renamed
      expect(fs.existsSync(`${expectedPath}.tmp`)).toBe(false);

      // Verify file permission mode 0o600
      const stat = fs.statSync(expectedPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("resolves relative path to project root_path in importFromDisk (SEC-001)", () => {
      const relPath = "relative-import.jsonl";
      const fullPath = path.resolve(service.currentProject.root_path, relPath);
      const record = {
        id: "rel-imp-id-1",
        project_id: service.currentProject.id,
        category: "architecture",
        title: "Imported via Relative Path",
        content: "Content for relative import.",
      };
      fs.writeFileSync(fullPath, JSON.stringify(record) + "\n", "utf-8");

      const result = service.importFromDisk(relPath);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);

      const obs = service.getContext();
      const found = obs.find((o) => o.id === "rel-imp-id-1");
      expect(found).toBeDefined();
      expect(found?.title).toBe("Imported via Relative Path");
    });

    it("strictly verifies typeof id, title, and content are strings in importFromDisk (SEC-005)", () => {
      const typeTestPath = path.join(tempDir, "type-checks.jsonl");
      const records = [
        // id is not a string
        { id: 12345, title: "Title 1", content: "Content 1" },
        // title is not a string
        { id: "bad-title-1", title: { not: "a string" }, content: "Content 2" },
        // content is not a string
        { id: "bad-content-1", title: "Title 3", content: 12345 },
        // null fields
        { id: null, title: "Title 4", content: "Content 4" },
        { id: "null-title", title: null, content: "Content 5" },
        { id: "null-content", title: "Title 6", content: null },
        // empty / whitespace strings
        { id: "   ", title: "Title 7", content: "Content 7" },
        { id: "bad-title-2", title: "   ", content: "Content 8" },
        // valid record
        {
          id: "strictly-valid-1",
          project_id: service.currentProject.id,
          category: "convention",
          title: "Strictly Valid Title",
          content: "Strictly valid content string",
        },
      ];

      fs.writeFileSync(
        typeTestPath,
        records.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf-8"
      );

      const result = service.importFromDisk(typeTestPath);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);

      const obs = service.getContext();
      expect(obs.find((o) => o.id === "strictly-valid-1")).toBeDefined();
      expect(obs.find((o) => o.id === "bad-title-1")).toBeUndefined();
      expect(obs.find((o) => o.id === "bad-content-1")).toBeUndefined();
    });

    it("syncToDisk defaults to .huginn/memories.jsonl in project root when no path is provided", () => {
      service.saveObservation({
        category: "decision",
        title: "Default Sync Obs",
        content: "Testing default path syncToDisk",
      });

      const result = service.syncToDisk();
      const expectedDefaultPath = path.join(
        service.currentProject.root_path,
        ".huginn",
        "memories.jsonl"
      );
      expect(result.path).toBe(expectedDefaultPath);
      expect(result.count).toBe(1);
      expect(fs.existsSync(expectedDefaultPath)).toBe(true);
    });

    it("syncToDisk cleans up .tmp file and rethrows when rename fails", () => {
      const renameSpy = vi
        .spyOn(fs, "renameSync")
        .mockImplementationOnce(() => {
          throw new Error("Simulated rename error");
        });

      try {
        expect(() => {
          service.syncToDisk(path.join(tempDir, "fail-sync.jsonl"));
        }).toThrow("Simulated rename error");

        expect(fs.existsSync(path.join(tempDir, "fail-sync.jsonl.tmp"))).toBe(false);
      } finally {
        renameSpy.mockRestore();
      }
    });

    it("syncToDisk ignores unlink errors during error cleanup", () => {
      const renameSpy = vi
        .spyOn(fs, "renameSync")
        .mockImplementationOnce(() => {
          throw new Error("Simulated rename error");
        });
      const unlinkSpy = vi
        .spyOn(fs, "unlinkSync")
        .mockImplementationOnce(() => {
          throw new Error("Simulated unlink error");
        });

      try {
        expect(() => {
          service.syncToDisk(path.join(tempDir, "fail-sync-unlink.jsonl"));
        }).toThrow("Simulated rename error");
      } finally {
        renameSpy.mockRestore();
        unlinkSpy.mockRestore();
      }
    });

    it("syncToDisk handles platforms where fs.chmodSync throws", () => {
      const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementationOnce(() => {
        throw new Error("Simulated chmod failure");
      });

      try {
        const dest = path.join(tempDir, "chmod-test.jsonl");
        const res = service.syncToDisk(dest);
        expect(res.path).toBe(dest);
        expect(fs.existsSync(dest)).toBe(true);
      } finally {
        chmodSpy.mockRestore();
      }
    });

    it("importFromDisk defaults to .huginn/memories.jsonl in project root when no path is provided", () => {
      service.saveObservation({
        category: "decision",
        title: "Default Path Obs",
        content: "Testing default import path",
      });
      service.syncToDisk(); // writes to .huginn/memories.jsonl

      // In a fresh db/service instance:
      const db2 = getDatabase(":memory:");
      const service2 = new MemoryService({ db: db2, projectRoot: tempDir });
      try {
        const res = service2.importFromDisk();
        expect(res.imported).toBe(1);
        expect(res.skipped).toBe(0);
      } finally {
        service2.close(true);
        if (db2.open) db2.close();
      }
    });

    it("importFromDisk falls back to currentProject.id when projectId does not exist in projects table", () => {
      const jsonlPath = path.join(tempDir, "missing-project.jsonl");
      const record = {
        id: "foreign-obs-1",
        projectId: "non-existent-proj-id",
        category: "discovery",
        title: "Foreign Project Obs",
        content: "Content with foreign project ID",
      };
      fs.writeFileSync(jsonlPath, JSON.stringify(record) + "\n", "utf-8");

      const result = service.importFromDisk(jsonlPath);
      expect(result.imported).toBe(1);

      const imported = service.getContext().find((o) => o.id === "foreign-obs-1");
      expect(imported).toBeDefined();
      expect(imported?.project_id).toBe(service.currentProject.id);
    });

    it("importFromDisk falls back to decision category when category is invalid", () => {
      const jsonlPath = path.join(tempDir, "invalid-cat.jsonl");
      const record = {
        id: "invalid-cat-obs-1",
        project_id: service.currentProject.id,
        category: "unrecognized_category",
        title: "Fallback Category Obs",
        content: "Content with invalid category",
      };
      fs.writeFileSync(jsonlPath, JSON.stringify(record) + "\n", "utf-8");

      const result = service.importFromDisk(jsonlPath);
      expect(result.imported).toBe(1);

      const imported = service.getContext().find((o) => o.id === "invalid-cat-obs-1");
      expect(imported).toBeDefined();
      expect(imported?.category).toBe("decision");
    });

    it("importFromDisk preserves custom symbol id when provided in jsonl entities", () => {
      const jsonlPath = path.join(tempDir, "custom-entity-id.jsonl");
      const customEntityId = "custom-entity-uuid-12345";
      const record = {
        id: "custom-entity-obs-1",
        project_id: service.currentProject.id,
        category: "architecture",
        title: "Custom Entity Id Obs",
        content: "Testing custom entity id import",
        entities: [
          {
            id: customEntityId,
            identifier: "src/custom.ts",
            entity_type: "file",
            file_path: "src/custom.ts",
          },
        ],
      };
      fs.writeFileSync(jsonlPath, JSON.stringify(record) + "\n", "utf-8");

      const result = service.importFromDisk(jsonlPath);
      expect(result.imported).toBe(1);

      const imported = service.getContext().find((o) => o.id === "custom-entity-obs-1");
      expect(imported).toBeDefined();
      expect(imported?.entities[0].id).toBe(customEntityId);
    });

    it("importFromDisk reuses existing entity when entity identifier matches existing record", () => {
      const jsonlPath = path.join(tempDir, "reuse-entity.jsonl");
      const record1 = {
        id: "reuse-obs-1",
        project_id: service.currentProject.id,
        category: "architecture",
        title: "Reuse Obs 1",
        content: "First observation",
        symbols: ["shared::identifier"],
      };
      const record2 = {
        id: "reuse-obs-2",
        project_id: service.currentProject.id,
        category: "bugfix",
        title: "Reuse Obs 2",
        content: "Second observation",
        symbols: ["shared::identifier"],
      };
      fs.writeFileSync(
        jsonlPath,
        [JSON.stringify(record1), JSON.stringify(record2)].join("\n") + "\n",
        "utf-8"
      );

      const result = service.importFromDisk(jsonlPath);
      expect(result.imported).toBe(2);

      const obsList = service.getContext();
      const o1 = obsList.find((o) => o.id === "reuse-obs-1");
      const o2 = obsList.find((o) => o.id === "reuse-obs-2");
      expect(o1?.entities[0].id).toBe(o2?.entities[0].id);
    });

    it("importFromDisk handles record with non-array entities or symbols gracefully", () => {
      const jsonlPath = path.join(tempDir, "non-array-symbols.jsonl");
      const record = {
        id: "non-array-obs",
        project_id: service.currentProject.id,
        category: "discovery",
        title: "Non Array Symbols Obs",
        content: "Content with string symbols",
        entities: "not-an-array",
      };
      fs.writeFileSync(jsonlPath, JSON.stringify(record) + "\n", "utf-8");

      const result = service.importFromDisk(jsonlPath);
      expect(result.imported).toBe(1);

      const imported = service.getContext().find((o) => o.id === "non-array-obs");
      expect(imported?.entities).toEqual([]);
    });

    it("falls back to findGitRoot or process.cwd when currentProject.root_path is falsy in syncToDisk and importFromDisk", () => {
      const origRoot = service.currentProject.root_path;
      try {
        (service.currentProject as any).root_path = "";
        const syncRes = service.syncToDisk("fallback-test.jsonl");
        expect(syncRes.path).toContain("fallback-test.jsonl");
        expect(fs.existsSync(syncRes.path)).toBe(true);
        fs.unlinkSync(syncRes.path);

        const impRes = service.importFromDisk("fallback-test.jsonl");
        expect(impRes).toEqual({ imported: 0, skipped: 0 });
      } finally {
        (service.currentProject as any).root_path = origRoot;
      }
    });

    it("defaults to memories.jsonl using git root or cwd fallback when root_path is empty", () => {
      const origRoot = service.currentProject.root_path;
      try {
        (service.currentProject as any).root_path = "";
        const syncRes = service.syncToDisk();
        expect(syncRes.path).toContain(".huginn/memories.jsonl");
        if (fs.existsSync(syncRes.path)) {
          fs.unlinkSync(syncRes.path);
        }

        const impRes = service.importFromDisk();
        expect(impRes).toBeDefined();
      } finally {
        (service.currentProject as any).root_path = origRoot;
      }
    });

    it("falls back to process.cwd when currentProject.root_path is falsy and findGitRoot returns null", () => {
      const origRoot = service.currentProject.root_path;
      const gitRootSpy = vi.spyOn(clientModule, "findGitRoot").mockReturnValue(null);
      try {
        (service.currentProject as any).root_path = "";
        const syncRes = service.syncToDisk("cwd-fallback.jsonl");
        expect(syncRes.path).toBe(path.resolve(process.cwd(), "cwd-fallback.jsonl"));
        if (fs.existsSync(syncRes.path)) {
          fs.unlinkSync(syncRes.path);
        }

        const syncDefaultRes = service.syncToDisk();
        expect(syncDefaultRes.path).toBe(path.join(process.cwd(), ".huginn", "memories.jsonl"));
        if (fs.existsSync(syncDefaultRes.path)) {
          fs.unlinkSync(syncDefaultRes.path);
        }

        const impRes = service.importFromDisk("cwd-fallback.jsonl");
        expect(impRes).toEqual({ imported: 0, skipped: 0 });

        const impDefaultRes = service.importFromDisk();
        expect(impDefaultRes).toEqual({ imported: 0, skipped: 0 });
      } finally {
        (service.currentProject as any).root_path = origRoot;
        gitRootSpy.mockRestore();
      }
    });

    it("syncToDisk skips tmp file unlink if writeFileSync failed before creating tmp file", () => {
      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
        throw new Error("Simulated writeFileSync error before file creation");
      });

      try {
        expect(() => {
          service.syncToDisk(path.join(tempDir, "write-fail.jsonl"));
        }).toThrow("Simulated writeFileSync error before file creation");
      } finally {
        writeSpy.mockRestore();
      }
    });
  });
});

/**
 * ADR-49 / AC-50.2 — `projectRoot` alone decides where the database lives and
 * which project the row belongs to. The bug: the database came from the process
 * cwd while the row came from `--project`, so running against project X from a cwd
 * inside Y wrote X's row into Y's database.
 */
describe("MemoryService one-root attribution (ADR-49)", () => {
  const roots: string[] = [];

  function gitRepo(name: string): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `muninn-svc-${name}-`)));
    roots.push(dir);
    spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
    return dir;
  }

  afterEach(() => {
    while (roots.length > 0) {
      fs.rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("opens the database under projectRoot and never the cwd", () => {
    const project = gitRepo("root");
    const service = new MemoryService({ projectRoot: project });
    try {
      expect(service.db.name).toBe(path.join(project, ".huginn", "muninn.db"));
      expect(service.currentProject.root_path).toBe(project);
      // The database is not the one the process cwd would resolve to.
      expect(service.db.name).not.toBe(clientModule.resolveDatabasePath(undefined));
    } finally {
      service.close?.();
    }
  });

  it("refuses a repository-shipped symlink for the memory export, both ways (SEC-006)", () => {
    const project = gitRepo("export");
    fs.mkdirSync(path.join(project, ".huginn"), { recursive: true });
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "muninn-export-")));
    roots.push(outside);
    const victim = path.join(outside, "memories.jsonl");
    fs.writeFileSync(victim, '{"id":"outside"}\n');
    fs.symlinkSync(victim, path.join(project, ".huginn", "memories.jsonl"));

    const service = new MemoryService({ projectRoot: project });
    try {
      service.saveObservation({ category: "decision", title: "t", content: "c" });
      // Neither direction may travel through the link.
      expect(() => service.syncToDisk()).toThrow(/symlink/i);
      expect(() => service.importFromDisk()).toThrow(/symlink/i);
      expect(fs.readFileSync(victim, "utf8")).toBe('{"id":"outside"}\n');
      expect(fs.readdirSync(outside)).toEqual(["memories.jsonl"]);
    } finally {
      service.close?.();
    }
  });

  it("writes nothing into another project's database", () => {
    const target = gitRepo("target");
    const other = gitRepo("other");
    // The other project has its own database...
    const otherService = new MemoryService({ projectRoot: other });
    otherService.saveObservation({ category: "decision", title: "keep", content: "keep" });
    otherService.close?.();

    // ...and a run against `target` must not add a row to it.
    const service = new MemoryService({ projectRoot: target });
    try {
      service.saveObservation({ category: "decision", title: "mine", content: "mine" });
      const targetRows = service.db
        .prepare("SELECT name FROM projects")
        .all() as Array<{ name: string }>;
      expect(targetRows.map((r) => r.name)).toEqual([path.basename(target)]);
    } finally {
      service.close?.();
    }

    const reopened = new MemoryService({ projectRoot: other });
    try {
      const otherRows = reopened.db
        .prepare("SELECT name FROM projects")
        .all() as Array<{ name: string }>;
      expect(otherRows.map((r) => r.name)).toEqual([path.basename(other)]);
    } finally {
      reopened.close?.();
    }
  });
});

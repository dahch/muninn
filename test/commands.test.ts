import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  handleMemoryCommand,
  handleMcpCommand,
  printMemoryUsage,
  printMcpUsage,
} from "../src/commands/memory.js";
import { main, parseArgs, usage } from "../src/cli.js";
import { MemoryService } from "../src/service/memory-service.js";
import { getDatabase } from "../src/db/client.js";
import * as mcpServerModule from "../src/mcp/server.js";

describe("Muninn CLI Commands & Integration", () => {
  let tempDir: string;
  let dbPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-cmd-test-"));
    dbPath = path.join(tempDir, "test-muninn.db");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = 0;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("parseArgs with multiple positionals", () => {
    it("parses single positional and command", () => {
      const parsed = parseArgs(["run", "--project", "/path/to/repo"]);
      expect(parsed._command).toBe("run");
      expect(parsed["--project"]).toBe("/path/to/repo");
      expect(parsed._positionals).toEqual([]);
    });

    it("parses multiple positionals for memory search", () => {
      const parsed = parseArgs(["memory", "search", "vector search", "--limit", "5"]);
      expect(parsed._command).toBe("memory");
      expect(parsed._positional).toBe("vector search");
      expect(parsed._positionals).toEqual(["search", "vector search"]);
      expect(parsed["--limit"]).toBe("5");
    });

    it("parses multiple positionals for sync import", () => {
      const parsed = parseArgs(["memory", "sync", "--import", "backup.jsonl"]);
      expect(parsed._command).toBe("memory");
      expect(parsed._positional).toBe("backup.jsonl");
      expect(parsed._positionals).toEqual(["sync", "backup.jsonl"]);
      expect(parsed["--import"]).toBe(true);
    });

    it("recognizes single-dash flags like -h as boolean flags and does not add them to positionals (REV-001)", () => {
      const parsed1 = parseArgs(["-h"]);
      expect(parsed1["-h"]).toBe(true);
      expect(parsed1._command).toBeUndefined();
      expect(parsed1._positionals).toEqual([]);

      const parsed2 = parseArgs(["memory", "init", "-h"]);
      expect(parsed2._command).toBe("memory");
      expect(parsed2._positional).toBe("init");
      expect(parsed2._positionals).toEqual(["init"]);
      expect(parsed2["-h"]).toBe(true);

      const parsed3 = parseArgs(["check", "src/foo.ts", "-h"]);
      expect(parsed3._command).toBe("check");
      expect(parsed3._positionals).toEqual(["src/foo.ts"]);
      expect(parsed3["-h"]).toBe(true);
    });
  });

  describe("usage documentation", () => {
    it("includes memory and mcp command documentation", () => {
      const help = usage();
      expect(help).toContain("muninn memory init [--db <path>] [--project <path>]");
      expect(help).toContain("muninn memory search <query> [--category <cat>] [--limit <n>] [--project <path>]");
      expect(help).toContain("muninn memory sync [--import] [--file <path>] [--project <path>]");
      expect(help).toContain("muninn mcp run [--db <path>] [--project <path>]");
      expect(help).toContain("memory");
      expect(help).toContain("mcp");
    });
  });

  describe("handleMemoryCommand 'init'", () => {
    it("initializes SQLite database and outputs formatted status", async () => {
      await handleMemoryCommand("init", {
        "--db": dbPath,
        "--project": tempDir,
      });

      expect(fs.existsSync(dbPath)).toBe(true);

      const db = getDatabase(dbPath);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      db.close();

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("projects");
      expect(tableNames).toContain("observations");
      expect(tableNames).toContain("entities");
      expect(tableNames).toContain("observation_entities");

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Muninn memory database initialized");
      expect(logOutput).toContain(dbPath);
      expect(logOutput).toContain(path.basename(tempDir));
      expect(logOutput).toContain("Tables ready");
    });

    it("initializes SQLite database using --root instead of --project", async () => {
      await handleMemoryCommand("init", {
        "--db": dbPath,
        "--root": tempDir,
      });

      expect(fs.existsSync(dbPath)).toBe(true);
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Muninn memory database initialized");
      expect(logOutput).toContain(path.basename(tempDir));
    });

    it("ensures db is closed even if ensureProject throws", async () => {
      const dbClientModule = await import("../src/db/client.js");
      const ensureSpy = vi
        .spyOn(dbClientModule, "ensureProject")
        .mockImplementationOnce(() => {
          throw new Error("Disk full or permission denied");
        });

      await expect(
        handleMemoryCommand("init", {
          "--db": dbPath,
          "--project": tempDir,
        })
      ).rejects.toThrow("Disk full or permission denied");

      ensureSpy.mockRestore();
    });

    it("handles db already closed or undefined in finally block", async () => {
      const dbClientModule = await import("../src/db/client.js");
      const realGetDatabase = dbClientModule.getDatabase;
      const getDbSpy = vi
        .spyOn(dbClientModule, "getDatabase")
        .mockImplementationOnce(((p: any) => {
          const db = realGetDatabase(p);
          db.close();
          return db;
        }) as any);

      await expect(
        handleMemoryCommand("init", {
          "--db": dbPath,
          "--project": tempDir,
        })
      ).rejects.toThrow();

      getDbSpy.mockRestore();
    });
  });

  describe("handleMemoryCommand 'search'", () => {
    beforeEach(() => {
      const service = new MemoryService({ dbPath, projectRoot: tempDir });
      service.saveObservation({
        category: "architecture",
        title: "Microservices design",
        content: "Detailed overview of microservice architecture and service communication",
        topicKey: "arch-core",
        symbols: ["src/services/order.ts", "src/services/auth.ts"],
      });
      service.saveObservation({
        category: "bugfix",
        title: "Fix JWT token expiration bug",
        content: "Fixed auth token validation error when token has expired timestamp",
        topicKey: "auth-security",
        symbols: ["src/auth/jwt.ts"],
      });
      service.saveObservation({
        category: "decision",
        title: "Adopt SQLite with FTS5",
        content: "Decided to use SQLite FTS5 for fast fulltext BM25 search and memory retrieval",
        topicKey: "storage",
      });
      service.saveObservation({
        category: "convention",
        title: "Repository Pattern Implementation",
        content:
          "Line 1: A detailed and comprehensive note.\nLine 2: This is an architectural explanation describing repository patterns across all database layers in the system exceeding one hundred and fifty characters threshold.",
      });
      service.close();
    });

    it("searches observations with matches and displays BM25 ranked details", async () => {
      await handleMemoryCommand(
        "search",
        { "--db": dbPath, "--project": tempDir },
        ["auth"]
      );

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain('Found 1 result(s) for "auth" (BM25 ranked):');
      expect(logOutput).toContain("[BUGFIX]");
      expect(logOutput).toContain("Fix JWT token expiration bug");
      expect(logOutput).toContain("score:");
      expect(logOutput).toContain("Topic: auth-security");
      expect(logOutput).toContain("src/auth/jwt.ts");
      expect(logOutput).toContain("Fixed auth token validation error");
    });

    it("supports search via --query flag", async () => {
      await handleMemoryCommand(
        "search",
        { "--db": dbPath, "--project": tempDir, "--query": "SQLite" },
        []
      );

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain('Found 1 result(s) for "SQLite" (BM25 ranked):');
      expect(logOutput).toContain("[DECISION]");
      expect(logOutput).toContain("Adopt SQLite with FTS5");
    });

    it("filters search results by --category", async () => {
      await handleMemoryCommand(
        "search",
        {
          "--db": dbPath,
          "--project": tempDir,
          "--category": "architecture",
        },
        ["microservice"]
      );

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain('Found 1 result(s) for "microservice" (BM25 ranked):');
      expect(logOutput).toContain("[ARCHITECTURE]");
      expect(logOutput).toContain("Microservices design");
    });

    it("returns no matches message when query matches nothing", async () => {
      await handleMemoryCommand(
        "search",
        { "--db": dbPath, "--project": tempDir },
        ["nonexistentquery12345"]
      );

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain('No observations found matching "nonexistentquery12345".');
    });

    it("sets process.exitCode to 1 and returns cleanly when query is missing", async () => {
      await handleMemoryCommand(
        "search",
        { "--db": dbPath, "--project": tempDir },
        []
      );

      const errorOutput = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("Search query is required");
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("does not crash with TypeError when flags are passed as boolean true", async () => {
      process.exitCode = 0;
      await handleMemoryCommand(
        "search",
        {
          "--db": true,
          "--project": true,
          "--query": true,
          "--category": true,
        },
        []
      );

      const errorOutput = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("Search query is required");
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();

      // Also verify searching with valid query string and boolean category does not crash
      logSpy.mockClear();
      await handleMemoryCommand(
        "search",
        {
          "--db": dbPath,
          "--project": tempDir,
          "--query": "auth",
          "--category": true,
        },
        []
      );
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain('Found 1 result(s) for "auth"');
    });

    it("extracts query from positionals[0] and allows searching for keyword 'search' (REV-002)", async () => {
      await handleMemoryCommand(
        "search",
        { "--db": dbPath, "--project": tempDir },
        ["microservices"]
      );

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain('Found 1 result(s) for "microservices"');
      expect(logOutput).toContain("Microservices design");
    });

    it("allows searching for keyword 'search' without shadowing (REV-002)", async () => {
      await handleMemoryCommand(
        "search",
        { "--db": dbPath, "--project": tempDir },
        ["search"]
      );

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain('Found 1 result(s) for "search"');
      expect(logOutput).toContain("Adopt SQLite with FTS5");
      expect(process.exitCode).toBe(0);
    });

    it("extracts query from args._positional when positionals array is not provided", async () => {
      await handleMemoryCommand(
        "search",
        { "--db": dbPath, "--project": tempDir, _positional: "microservices" }
      );

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain('Found 1 result(s) for "microservices"');
      expect(logOutput).toContain("Microservices design");
    });

    it("truncates content exceeding 150 characters and replaces newlines, formats observation without topic key or entities", async () => {
      await handleMemoryCommand(
        "search",
        { "--db": dbPath, "--project": tempDir },
        ["comprehensive"]
      );

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain('Found 1 result(s) for "comprehensive"');
      expect(logOutput).toContain("[CONVENTION]");
      expect(logOutput).toContain("Repository Pattern Implementation");
      expect(logOutput).toContain("...");
      expect(logOutput).toContain("Line 1: A detailed and comprehensive note. Line 2:");
      expect(logOutput).not.toContain("Topic:");
      expect(logOutput).not.toContain("Symbols:");
    });

    it("supports custom numeric --limit flag and falls back to default 10 for invalid/negative limit", async () => {
      // Limit 1
      logSpy.mockClear();
      await handleMemoryCommand(
        "search",
        {
          "--db": dbPath,
          "--project": tempDir,
          "--query": "detailed",
          "--limit": "1",
        },
        []
      );
      let logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Found 1 result(s)");

      // Negative limit falls back to 10
      logSpy.mockClear();
      await handleMemoryCommand(
        "search",
        {
          "--db": dbPath,
          "--project": tempDir,
          "--query": "detailed",
          "--limit": "-5",
        },
        []
      );
      logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Found 2 result(s)");

      // Non-numeric limit falls back to 10
      logSpy.mockClear();
      await handleMemoryCommand(
        "search",
        {
          "--db": dbPath,
          "--project": tempDir,
          "--query": "detailed",
          "--limit": "notanumber",
        },
        []
      );
      logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Found 2 result(s)");
    });

    it("resolves project root using --root flag instead of --project", async () => {
      await handleMemoryCommand(
        "search",
        { "--db": dbPath, "--root": tempDir, "--query": "SQLite" },
        []
      );

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain('Found 1 result(s) for "SQLite"');
    });

    it("sets process.exitCode to 1 when query is empty whitespace string", async () => {
      process.exitCode = 0;
      await handleMemoryCommand(
        "search",
        { "--db": dbPath, "--project": tempDir, "--query": "    " },
        []
      );

      const errorOutput = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("Search query is required");
      expect(process.exitCode).toBe(1);
    });

    it("sets process.exitCode to 1 when positionals array is empty and no query flag is provided", async () => {
      process.exitCode = 0;
      await handleMemoryCommand(
        "search",
        { "--db": dbPath, "--project": tempDir },
        []
      );

      const errorOutput = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("Search query is required");
      expect(process.exitCode).toBe(1);
    });

    it("floors float --limit values using Math.floor (REV-007)", async () => {
      logSpy.mockClear();
      await handleMemoryCommand(
        "search",
        {
          "--db": dbPath,
          "--project": tempDir,
          "--query": "detailed",
          "--limit": "1.9",
        },
        []
      );
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Found 1 result(s)");
    });

    it("sets process.exitCode to 1 when args._positional is 'search'", async () => {
      process.exitCode = 0;
      await handleMemoryCommand(
        "search",
        { "--db": dbPath, "--project": tempDir, _positional: "search" },
        []
      );

      const errorOutput = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("Search query is required");
      expect(process.exitCode).toBe(1);
    });
  });

  describe("handleMemoryCommand 'sync'", () => {
    let exportFile: string;

    beforeEach(() => {
      exportFile = path.join(tempDir, "backup-memories.jsonl");
      const service = new MemoryService({ dbPath, projectRoot: tempDir });
      service.saveObservation({
        category: "convention",
        title: "Use ESM imports",
        content: "Always use explicit .js extensions in ESM relative imports",
      });
      service.saveObservation({
        category: "discovery",
        title: "Bun sqlite performance",
        content: "Native better-sqlite3 with WAL journal mode achieves optimal write latency",
      });
      service.close();
    });

    it("exports observations to disk", async () => {
      await handleMemoryCommand(
        "sync",
        {
          "--db": dbPath,
          "--file": exportFile,
          "--project": tempDir,
        },
        []
      );

      expect(fs.existsSync(exportFile)).toBe(true);
      const lines = fs
        .readFileSync(exportFile, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(lines.length).toBe(2);

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain(`Synced 2 memories to ${exportFile}.`);
    });

    it("imports observations from disk using --import", async () => {
      // First export to file
      await handleMemoryCommand(
        "sync",
        {
          "--db": dbPath,
          "--file": exportFile,
          "--project": tempDir,
        },
        []
      );

      // Create a new fresh db
      const freshDbPath = path.join(tempDir, "fresh-muninn.db");
      logSpy.mockClear();

      // Import into new db
      await handleMemoryCommand(
        "sync",
        {
          "--db": freshDbPath,
          "--file": exportFile,
          "--import": true,
          "--project": tempDir,
        },
        []
      );

      let logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain(`Imported 2 memories (skipped 0 duplicates) from ${exportFile}.`);

      // Import again to test duplicate skipping
      logSpy.mockClear();
      await handleMemoryCommand(
        "sync",
        {
          "--db": freshDbPath,
          "--file": exportFile,
          "--import": true,
          "--project": tempDir,
        },
        []
      );

      logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain(`Imported 0 memories (skipped 2 duplicates) from ${exportFile}.`);
    });

    it("passes filePath directly to syncToDisk and handles boolean true flags (REV-006)", async () => {
      const syncSpy = vi.spyOn(MemoryService.prototype, "syncToDisk");
      await handleMemoryCommand("sync", {
        "--db": dbPath,
        "--project": tempDir,
        "--file": true,
      });

      expect(syncSpy).toHaveBeenCalledWith(undefined);
      syncSpy.mockRestore();
    });

    it("passes relative path directly to importFromDisk without redundant calculation (REV-006)", async () => {
      const importSpy = vi.spyOn(MemoryService.prototype, "importFromDisk");
      await handleMemoryCommand("sync", {
        "--db": dbPath,
        "--project": tempDir,
        "--import": true,
        "--file": "relative-backup.jsonl",
      });

      expect(importSpy).toHaveBeenCalledWith("relative-backup.jsonl");
      importSpy.mockRestore();
    });

    it("extracts file path from positionals without 'sync' keyword shadowing (REV-002)", async () => {
      const syncFile = path.join(tempDir, "pos-sync.jsonl");
      await handleMemoryCommand(
        "sync",
        { "--db": dbPath, "--project": tempDir },
        [syncFile]
      );

      expect(fs.existsSync(syncFile)).toBe(true);
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain(`Synced 2 memories to ${syncFile}.`);
    });

    it("extracts file path from positionals when multiple positionals exist", async () => {
      const syncFile = path.join(tempDir, "pos-direct.jsonl");
      await handleMemoryCommand(
        "sync",
        { "--db": dbPath, "--project": tempDir },
        [syncFile]
      );

      expect(fs.existsSync(syncFile)).toBe(true);
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain(`Synced 2 memories to ${syncFile}.`);
    });

    it("extracts file path from args._positional when positionals array is omitted", async () => {
      const syncFile = path.join(tempDir, "raw-pos.jsonl");
      await handleMemoryCommand(
        "sync",
        { "--db": dbPath, "--project": tempDir, _positional: syncFile }
      );

      expect(fs.existsSync(syncFile)).toBe(true);
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain(`Synced 2 memories to ${syncFile}.`);
    });

    it("allows using keyword 'sync' as filename positional without shadowing (REV-002)", async () => {
      const syncFile = path.join(tempDir, "sync");
      await handleMemoryCommand(
        "sync",
        { "--db": dbPath, "--project": tempDir },
        [syncFile]
      );

      expect(fs.existsSync(syncFile)).toBe(true);
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain(`Synced 2 memories to ${syncFile}.`);
    });

    it("syncs to default path when positionals is empty", async () => {
      const defaultPath = path.join(tempDir, ".huginn", "memories.jsonl");
      await handleMemoryCommand(
        "sync",
        { "--db": dbPath, "--project": tempDir },
        []
      );

      expect(fs.existsSync(defaultPath)).toBe(true);
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain(`Synced 2 memories to ${defaultPath}.`);
    });

    it("syncs to default path when args._positional is 'sync'", async () => {
      const defaultPath = path.join(tempDir, ".huginn", "memories.jsonl");
      if (fs.existsSync(defaultPath)) {
        fs.unlinkSync(defaultPath);
      }
      await handleMemoryCommand(
        "sync",
        { "--db": dbPath, "--project": tempDir, _positional: "sync" },
        []
      );

      expect(fs.existsSync(defaultPath)).toBe(true);
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain(`Synced 2 memories to ${defaultPath}.`);
    });

    it("supports resolving project root using --root flag instead of --project in sync", async () => {
      const rootSyncFile = path.join(tempDir, "root-synced.jsonl");
      await handleMemoryCommand("sync", {
        "--db": dbPath,
        "--root": tempDir,
        "--file": rootSyncFile,
      });

      expect(fs.existsSync(rootSyncFile)).toBe(true);
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain(`Synced 2 memories to ${rootSyncFile}.`);
    });

    it("falls back to findGitRoot when currentProject.root_path is empty", async () => {
      const dbClientModule = await import("../src/db/client.js");
      const gitRootSpy = vi.spyOn(dbClientModule, "findGitRoot").mockReturnValue(tempDir);
      const ensureSpy = vi.spyOn(dbClientModule, "ensureProject").mockReturnValue({
        id: "test-id",
        name: "test-project",
        root_path: "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      try {
        await handleMemoryCommand("sync", {
          "--db": dbPath,
        });

        const defaultPath = path.join(tempDir, ".huginn", "memories.jsonl");
        expect(fs.existsSync(defaultPath)).toBe(true);
      } finally {
        gitRootSpy.mockRestore();
        ensureSpy.mockRestore();
      }
    });

    it("falls back to process.cwd when currentProject.root_path is empty and findGitRoot is null", async () => {
      const dbClientModule = await import("../src/db/client.js");
      const gitRootSpy = vi.spyOn(dbClientModule, "findGitRoot").mockReturnValue(null);
      const ensureSpy = vi.spyOn(dbClientModule, "ensureProject").mockReturnValue({
        id: "test-id",
        name: "test-project",
        root_path: "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const syncSpy = vi.spyOn(MemoryService.prototype, "syncToDisk");
      try {
        await handleMemoryCommand("sync", {
          "--db": dbPath,
        });

        expect(syncSpy).toHaveBeenCalledWith(undefined);
      } finally {
        gitRootSpy.mockRestore();
        ensureSpy.mockRestore();
        syncSpy.mockRestore();
      }
    });
  });

  describe("handleMemoryCommand usage & unknown subcommands", () => {
    it("displays memory usage when called without subcommand", async () => {
      await handleMemoryCommand(undefined, {});
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("muninn memory init");
      expect(logOutput).toContain("muninn memory search");
      expect(logOutput).toContain("muninn memory sync");
    });

    it("displays memory usage when called with help flags ('help', '--help', '-h')", async () => {
      for (const helpFlag of ["help", "--help", "-h"]) {
        logSpy.mockClear();
        await handleMemoryCommand(helpFlag, {});
        const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logOutput).toContain("muninn memory init");
        expect(logOutput).toContain("muninn memory search");
        expect(logOutput).toContain("muninn memory sync");
      }
    });

    it("displays memory usage, logs error, and sets process.exitCode = 1 for unknown subcommand (REV-004)", async () => {
      process.exitCode = 0;
      await handleMemoryCommand("invalidcmd", {});
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      const errorOutput = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("muninn memory init");
      expect(logOutput).toContain("muninn memory search");
      expect(errorOutput).toContain("Unknown subcommand: invalidcmd");
      expect(process.exitCode).toBe(1);
    });

    it("printMemoryUsage outputs usage directly", () => {
      printMemoryUsage();
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("muninn memory init");
    });

    it("displays memory usage and does not execute subcommand when --help or -h is passed in args (REV-002)", async () => {
      for (const helpFlag of ["--help", "-h"]) {
        logSpy.mockClear();
        const nonExistentDb = path.join(tempDir, `no-init-${helpFlag}.db`);
        await handleMemoryCommand("init", { [helpFlag]: true, "--db": nonExistentDb, "--project": tempDir });
        expect(fs.existsSync(nonExistentDb)).toBe(false);
        const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logOutput).toContain("muninn memory init");
      }
    });
  });

  describe("handleMcpCommand", () => {
    it("displays mcp usage, logs error, and sets process.exitCode = 1 when called with unknown subcommand (REV-004)", async () => {
      process.exitCode = 0;
      await handleMcpCommand("invalid", {});
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      const errorOutput = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("muninn mcp run [--db <path>] [--project <path>]");
      expect(errorOutput).toContain("Unknown subcommand: invalid");
      expect(process.exitCode).toBe(1);
    });

    it("displays mcp usage when called without subcommand", async () => {
      await handleMcpCommand(undefined, {});
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("muninn mcp run");
    });

    it("displays mcp usage and does not run server when --help or -h is passed in args (REV-002)", async () => {
      const startSpy = vi.spyOn(mcpServerModule, "startMcpServer");
      for (const helpFlag of ["--help", "-h"]) {
        logSpy.mockClear();
        startSpy.mockClear();
        await handleMcpCommand("run", { [helpFlag]: true });
        expect(startSpy).not.toHaveBeenCalled();
        const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logOutput).toContain("muninn mcp run");
      }
      startSpy.mockRestore();
    });

    it("printMcpUsage outputs mcp usage directly", () => {
      printMcpUsage();
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("muninn mcp run");
    });

    it("starts MCP server without console.log on startup and holds lifecycle until transport closes", async () => {
      let closeCallback: (() => void) | undefined;
      const mockTransport = {
        set onclose(fn: () => void) {
          closeCallback = fn;
        },
        get onclose() {
          return closeCallback;
        },
      };

      const startSpy = vi
        .spyOn(mcpServerModule, "startMcpServer")
        .mockResolvedValue({ transport: mockTransport } as any);

      let completed = false;
      const runPromise = handleMcpCommand("run", {
        "--db": dbPath,
        "--project": tempDir,
      }).then(() => {
        completed = true;
      });

      expect(startSpy).toHaveBeenCalledWith({
        dbPath,
        projectRoot: tempDir,
      });
      // Verification that console.log was NOT called (stdio json-rpc integrity)
      expect(logSpy).not.toHaveBeenCalled();

      // Verify lifecycle is held (promise not resolved immediately)
      await new Promise((r) => setTimeout(r, 20));
      expect(completed).toBe(false);

      // Trigger transport close to cleanly end lifecycle
      expect(typeof closeCallback).toBe("function");
      closeCallback!();

      await runPromise;
      expect(completed).toBe(true);
      startSpy.mockRestore();
    });

    it("holds lifecycle until SIGINT signal is received", async () => {
      let closeCallback: (() => void) | undefined;
      const mockTransport = {
        set onclose(fn: () => void) {
          closeCallback = fn;
        },
        get onclose() {
          return closeCallback;
        },
      };

      const startSpy = vi
        .spyOn(mcpServerModule, "startMcpServer")
        .mockResolvedValue({ transport: mockTransport } as any);

      let completed = false;
      const runPromise = handleMcpCommand("run", {
        "--db": dbPath,
        "--project": tempDir,
      }).then(() => {
        completed = true;
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(completed).toBe(false);

      process.emit("SIGINT");
      await runPromise;
      expect(completed).toBe(true);
      startSpy.mockRestore();
    });

    it("does not crash with TypeError when string flags default to boolean true", async () => {
      let closeCallback: (() => void) | undefined;
      const mockTransport = {
        set onclose(fn: () => void) {
          closeCallback = fn;
        },
        get onclose() {
          return closeCallback;
        },
      };

      const startSpy = vi
        .spyOn(mcpServerModule, "startMcpServer")
        .mockResolvedValue({ transport: mockTransport } as any);

      const runPromise = handleMcpCommand("run", {
        "--db": true,
        "--project": true,
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(startSpy).toHaveBeenCalledWith({
        dbPath: undefined,
        projectRoot: undefined,
      });

      expect(typeof closeCallback).toBe("function");
      closeCallback!();
      await runPromise;
      startSpy.mockRestore();
    });

    it("supports resolving project root using --root flag instead of --project", async () => {
      let closeCallback: (() => void) | undefined;
      const mockTransport = {
        set onclose(fn: () => void) {
          closeCallback = fn;
        },
        get onclose() {
          return closeCallback;
        },
      };

      const startSpy = vi
        .spyOn(mcpServerModule, "startMcpServer")
        .mockResolvedValue({ transport: mockTransport } as any);

      const runPromise = handleMcpCommand("run", {
        "--db": dbPath,
        "--root": tempDir,
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(startSpy).toHaveBeenCalledWith({
        dbPath,
        projectRoot: tempDir,
      });

      expect(typeof closeCallback).toBe("function");
      closeCallback!();
      await runPromise;
      startSpy.mockRestore();
    });

    it("completes immediately when transport is undefined", async () => {
      const startSpy = vi
        .spyOn(mcpServerModule, "startMcpServer")
        .mockResolvedValue({ transport: undefined } as any);

      await handleMcpCommand("run", {
        "--db": dbPath,
        "--project": tempDir,
      });

      expect(startSpy).toHaveBeenCalledWith({
        dbPath,
        projectRoot: tempDir,
      });
      startSpy.mockRestore();
    });

    it("holds lifecycle until SIGTERM signal is received", async () => {
      let closeCallback: (() => void) | undefined;
      const mockTransport = {
        set onclose(fn: () => void) {
          closeCallback = fn;
        },
        get onclose() {
          return closeCallback;
        },
      };

      const startSpy = vi
        .spyOn(mcpServerModule, "startMcpServer")
        .mockResolvedValue({ transport: mockTransport } as any);

      let completed = false;
      const runPromise = handleMcpCommand("run", {
        "--db": dbPath,
        "--project": tempDir,
      }).then(() => {
        completed = true;
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(completed).toBe(false);

      process.emit("SIGTERM");
      await runPromise;
      expect(completed).toBe(true);
      startSpy.mockRestore();
    });

    it("closes service and server in finally block on shutdown (REV-003)", async () => {
      let closeCallback: (() => void) | undefined;
      const mockTransport = {
        set onclose(fn: () => void) {
          closeCallback = fn;
        },
        get onclose() {
          return closeCallback;
        },
      };

      const mockService = { close: vi.fn() };
      const mockServer = { close: vi.fn().mockResolvedValue(undefined) };

      const startSpy = vi
        .spyOn(mcpServerModule, "startMcpServer")
        .mockResolvedValue({
          server: mockServer,
          service: mockService,
          transport: mockTransport,
        } as any);

      const runPromise = handleMcpCommand("run", {
        "--db": dbPath,
        "--project": tempDir,
      });

      await new Promise((r) => setTimeout(r, 10));
      closeCallback!();
      await runPromise;

      expect(mockService.close).toHaveBeenCalled();
      expect(mockServer.close).toHaveBeenCalled();
      startSpy.mockRestore();
    });
  });

  describe("cli.ts routing to memory and mcp", () => {
    it("routes 'memory init' through main", async () => {
      await main(["memory", "init", "--db", dbPath, "--project", tempDir]);
      expect(fs.existsSync(dbPath)).toBe(true);
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Muninn memory database initialized");
    });

    it("routes 'memory search' through main", async () => {
      // First init and save
      const service = new MemoryService({ dbPath, projectRoot: tempDir });
      service.saveObservation({
        category: "bugfix",
        title: "Resolved crash on startup",
        content: "Fixed null pointer exception on launch",
      });
      service.close();
      logSpy.mockClear();

      await main([
        "memory",
        "search",
        "crash",
        "--db",
        dbPath,
        "--project",
        tempDir,
      ]);

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Resolved crash on startup");
    });

    it("routes 'memory sync' through main", async () => {
      const syncFile = path.join(tempDir, "synced.jsonl");
      await main([
        "memory",
        "sync",
        "--file",
        syncFile,
        "--db",
        dbPath,
        "--project",
        tempDir,
      ]);

      expect(fs.existsSync(syncFile)).toBe(true);
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain(`Synced 0 memories to ${syncFile}.`);
    });

    it("routes 'mcp' through main", async () => {
      process.exitCode = 0;
      await main(["mcp", "unknown"]);
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      const errorOutput = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("muninn mcp run");
      expect(errorOutput).toContain("Unknown subcommand: unknown");
      expect(process.exitCode).toBe(1);
    });
  });
});

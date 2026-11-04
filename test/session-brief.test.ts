import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getReadOnlyDatabase } from "../src/db/client.js";
import {
  MemoryService,
  readSessionBrief,
  renderSessionBrief,
  MAX_SESSION_BRIEF_BUDGET,
  type SessionBrief,
} from "../src/service/memory-service.js";
import {
  createMcpServer,
  normalizeArgs,
  MuninnBootstrapSchema,
} from "../src/mcp/server.js";
import { handleMemoryCommand } from "../src/commands/memory.js";

function callText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> })
    .content;
  return content[0].text;
}

describe("Read-only session bootstrap (Iteration 2)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-brief-test-"));
    dbPath = path.join(tempDir, ".huginn", "muninn.db");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  function seed(): MemoryService {
    const service = new MemoryService({ dbPath, projectRoot: tempDir });
    service.saveObservation({
      category: "decision",
      title: "Use SQLite",
      content: "SQLite keeps memory local.",
      topicKey: "storage",
      symbols: ["src/db/client.ts"],
    });
    service.saveObservation({
      category: "decision",
      title: "Use FTS5",
      content: "FTS5 provides lexical search.",
      topicKey: "storage",
    });
    service.saveObservation({
      category: "decision",
      title: "Old unkeyed decision",
      content: "This decision will be superseded.",
    });
    service.saveObservation({
      category: "decision",
      title: "New unkeyed decision",
      content: "This decision replaces the old one.",
      supersedesTopicKey: "never-used",
    });
    service.saveObservation({
      category: "discovery",
      title: "Recent discovery",
      content: "The indexer stores relative file paths.",
      symbols: [
        "src/service/memory-service.ts",
        "src/service/memory-service.ts::getSessionBrief",
      ],
    });
    // Explicitly supersede the old unkeyed decision through the same topic key.
    service.saveObservation({
      category: "decision",
      title: "Replacement for old unkeyed",
      content: "This is the active replacement.",
    });
    return service;
  }

  it("renders an empty brief for an initialized but empty project", () => {
    const service = new MemoryService({ dbPath, projectRoot: tempDir });
    try {
      const brief = service.getSessionBrief();
      expect(brief.counts).toEqual({ observations: 0, entities: 0, links: 0 });
      expect(brief.activeDecisions.keyed).toEqual([]);
      expect(brief.activeDecisions.unkeyed).toEqual([]);
      expect(brief.recentActivity).toEqual([]);
      expect(brief.symbols).toEqual([]);
      expect(brief.markdown).toContain("## Project");
      expect(brief.markdown).toContain("## Counts");
      expect(brief.markdown).not.toContain("## Active Decisions");
      expect(brief.markdown).not.toContain("## Recent Activity");
    } finally {
      service.close();
    }
  });

  it("groups keyed decisions without collapsing duplicates and keeps unkeyed decisions separate", () => {
    const service = seed();
    try {
      const brief = service.getSessionBrief();
      const storage = brief.activeDecisions.keyed.find(
        (group) => group.topicKey === "storage"
      );
      expect(storage?.decisions.map((d) => d.title).sort()).toEqual([
        "Use FTS5",
        "Use SQLite",
      ]);
      expect(brief.activeDecisions.unkeyed.map((d) => d.title).sort()).toEqual([
        "New unkeyed decision",
        "Old unkeyed decision",
        "Replacement for old unkeyed",
      ]);
      expect(brief.markdown).toContain("### Topic: storage");
      expect(brief.markdown).toContain("### Unkeyed decisions");
    } finally {
      service.close();
    }
  });

  it("counts superseded observations and labels superseded recent activity", () => {
    const service = new MemoryService({ dbPath, projectRoot: tempDir });
    try {
      const old = service.saveObservation({
        category: "decision",
        title: "Old storage decision",
        content: "old",
        topicKey: "storage",
      });
      service.saveObservation({
        category: "decision",
        title: "Current storage decision",
        content: "new",
        topicKey: "storage",
        supersedesTopicKey: "storage",
      });

      const brief = service.getSessionBrief();
      expect(brief.counts.observations).toBe(2);
      expect(
        brief.activeDecisions.keyed
          .flatMap((group) => group.decisions)
          .map((decision) => decision.title)
      ).toEqual(["Current storage decision"]);
      expect(
        brief.recentActivity.some((observation) => observation.id === old.id)
      ).toBe(true);
      expect(
        brief.recentActivity.find((observation) => observation.id === old.id)
          ?.status
      ).toBe("superseded");
      expect(brief.markdown).toContain("SUPERSEDED");
    } finally {
      service.close();
    }
  });

  it("selects only indexed symbols by relative, absolute and directory paths", () => {
    const service = seed();
    try {
      const relative = service.getSessionBrief({ paths: ["src/service"] });
      expect(relative.symbols.length).toBeGreaterThan(0);
      expect(
        relative.symbols.every((symbol) =>
          symbol.file_path.startsWith("src/service")
        )
      ).toBe(true);

      const absolute = service.getSessionBrief({
        paths: [path.join(tempDir, "src", "db", "client.ts")],
      });
      expect(absolute.symbols.map((symbol) => symbol.file_path)).toContain(
        "src/db/client.ts"
      );

      // A real file that exists on disk but was never indexed must not appear.
      fs.mkdirSync(path.join(tempDir, "not-indexed"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "not-indexed", "file.ts"), "export const x = 1;\n");
      const indexedOnly = service.getSessionBrief({
        paths: ["not-indexed"],
      });
      expect(indexedOnly.symbols).toEqual([]);
      expect(indexedOnly.notes.join(" ")).toContain("No indexed symbols matched");
    } finally {
      service.close();
    }
  });

  it("rejects project escape paths and more than 20 selections", () => {
    const service = seed();
    try {
      expect(() =>
        service.getSessionBrief({ paths: ["../outside"] })
      ).toThrow(/outside the project root/);
      expect(() =>
        service.getSessionBrief({
          paths: Array.from({ length: 21 }, () => "src"),
        })
      ).toThrow(/At most 20 paths/);
    } finally {
      service.close();
    }
  });

  it("is deterministic and enforces the complete Markdown budget", () => {
    const service = seed();
    try {
      const first = service.getSessionBrief();
      const second = service.getSessionBrief();
      expect(first.markdown).toBe(second.markdown);

      const budget = 120;
      const bounded = service.getSessionBrief({ budgetChars: budget });
      expect(bounded.markdown.length).toBeLessThanOrEqual(budget);
      expect(bounded.truncated).toBe(true);
      expect(bounded.markdown.toLowerCase()).toContain("truncat");
      expect(renderSessionBrief(bounded)).toBe(bounded.markdown);

      const tiny = service.getSessionBrief({ budgetChars: 1 });
      expect(tiny.markdown.length).toBeLessThanOrEqual(1);
      expect(tiny.markdown.length).toBeGreaterThan(0);
      expect(tiny.truncated).toBe(true);

      expect(() => service.getSessionBrief({ budgetChars: 0 })).toThrow(
        /positive integer/
      );
      expect(() =>
        service.getSessionBrief({ budgetChars: MAX_SESSION_BRIEF_BUDGET + 1 })
      ).toThrow(/cannot exceed/);
    } finally {
      service.close();
    }
  });

  it("fails open for missing and corrupt databases without creating state", () => {
    const missing = readSessionBrief({ dbPath, projectRoot: tempDir });
    expect(missing.counts).toEqual({
      observations: null,
      entities: null,
      links: null,
    });
    expect(missing.markdown).toContain("unavailable");
    expect(fs.existsSync(path.join(tempDir, ".huginn"))).toBe(false);

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "this is not a sqlite database");
    const corrupt = readSessionBrief({ dbPath, projectRoot: tempDir });
    expect(corrupt.counts).toEqual({
      observations: null,
      entities: null,
      links: null,
    });
    expect(corrupt.notes.join(" ").toLowerCase()).toContain("unavailable");
    expect(() => readSessionBrief({ dbPath, projectRoot: tempDir })).not.toThrow();
  });

  it("opens an existing legacy database without migrating columns or inserting rows", () => {
    const legacyPath = path.join(tempDir, ".huginn", "legacy.db");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        git_remote TEXT,
        root_path TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE observations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        topic_key TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE entities (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        identifier TEXT NOT NULL,
        file_path TEXT NOT NULL
      );
      CREATE TABLE observation_entities (
        observation_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        PRIMARY KEY(observation_id, entity_id)
      );
    `);
    legacy
      .prepare("INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)")
      .run("legacy-project", "Legacy", path.resolve(tempDir));
    legacy
      .prepare(
        "INSERT INTO observations (id, project_id, category, title, content) VALUES (?, ?, ?, ?, ?)"
      )
      .run("legacy-obs", "legacy-project", "decision", "Legacy decision", "Body");
    legacy.close();

    // The old schema lacks the lifecycle columns, so the brief cannot be read, but
    // bootstrap must fail open without applying the write-path migration.
    const brief = readSessionBrief({ dbPath: legacyPath, projectRoot: tempDir });
    expect(brief.counts).toEqual({
      observations: null,
      entities: null,
      links: null,
    });
    expect(brief.notes.join(" ").toLowerCase()).toContain("unavailable");

    const check = new Database(legacyPath, { readonly: true });
    try {
      const columns = check
        .prepare<[], { name: string }>("PRAGMA table_info(observations)")
        .all()
        .map((column) => column.name);
      expect(columns).not.toContain("status");
      expect(columns).not.toContain("superseded_by");
      expect(
        check
          .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM projects")
          .get()?.count
      ).toBe(1);
      expect(
        check
          .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM observations")
          .get()?.count
      ).toBe(1);
    } finally {
      check.close();
    }
  });

  it("returns the shared renderer output from MCP and CLI and never JSON-wraps bootstrap", async () => {
    const service = seed();
    const projectRoot = tempDir;
    const db = service.db;
    const server = createMcpServer(service);
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "brief-test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "muninn_bootstrap",
        arguments: { paths: ["src"], budgetChars: 5000 },
      });
      const text = callText(result);
      expect(text.startsWith("{")).toBe(false);
      expect(text).toBe(
        service.getSessionBrief({ paths: ["src"], budgetChars: 5000 }).markdown
      );
    } finally {
      await client.close();
      await server.close();
      service.close(true);
      if (db.open) db.close();
    }

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleMemoryCommand(
        "brief",
        { "--db": dbPath, "--project": projectRoot, "--paths": "src", "--budget": "5000" },
        []
      );
      const cliOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(cliOutput).toContain("# Session Brief:");
      expect(cliOutput).not.toContain('"project"');
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("uses the default budget and omits empty notes for a populated project", () => {
    const service = seed();
    try {
      const brief = service.getSessionBrief();
      expect(brief.budgetChars).toBe(8_000);
      expect(brief.notes).toEqual([]);
      expect(brief.markdown).toContain("## Active Decisions");
      expect(brief.markdown).toContain("## Recent Activity");
      expect(brief.markdown).not.toContain("## Notes");
      expect(brief.truncated).toBe(false);
    } finally {
      service.close();
    }
  });

  it("matches whole path boundaries, not string prefixes, and normalizes separators", () => {
    const service = seed();
    try {
      service.saveObservation({
        category: "discovery",
        title: "Sibling directory discovery",
        content: "The service-extra directory is not part of src/service.",
        symbols: ["src/service-extra/other.ts"],
      });

      const directory = service.getSessionBrief({ paths: ["src/service"] });
      expect(directory.symbols.length).toBeGreaterThan(0);
      expect(
        directory.symbols.every((symbol) =>
          symbol.file_path.startsWith("src/service/")
        )
      ).toBe(true);
      expect(
        directory.symbols.some((symbol) =>
          symbol.file_path.startsWith("src/service-extra/")
        )
      ).toBe(false);

      const windowsSeparators = service.getSessionBrief({
        paths: ["src\\service-extra"],
      });
      expect(windowsSeparators.symbols.map((symbol) => symbol.file_path)).toEqual([
        "src/service-extra/other.ts",
      ]);

      const absoluteDirectory = service.getSessionBrief({
        paths: [path.join(tempDir, "src", "db")],
      });
      expect(absoluteDirectory.symbols.map((symbol) => symbol.file_path)).toEqual([
        "src/db/client.ts",
      ]);

      const duplicated = service.getSessionBrief({
        paths: ["src/db", "src/db/", "./src/db"],
      });
      expect(duplicated.markdown).toBe(absoluteDirectory.markdown);
    } finally {
      service.close();
    }
  });

  it("accepts exactly 20 selections and rejects empty, non-string and absolute escape paths", () => {
    const service = seed();
    try {
      const twenty = service.getSessionBrief({
        paths: Array.from({ length: 20 }, (_, index) => `src/missing-${index}`),
      });
      expect(twenty.symbols).toEqual([]);
      expect(twenty.notes.join(" ")).toContain("No indexed symbols matched");

      expect(() => service.getSessionBrief({ paths: [""] })).toThrow(
        /cannot be empty/
      );
      expect(() =>
        service.getSessionBrief({ paths: [42 as unknown as string] })
      ).toThrow(/must be strings/);
      expect(() =>
        service.getSessionBrief({
          paths: [path.join(os.tmpdir(), `muninn-outside-${Date.now()}`)],
        })
      ).toThrow(/outside the project root/);
    } finally {
      service.close();
    }
  });

  it("counts every observation and link while keeping superseded data out of active decisions", () => {
    const service = new MemoryService({ dbPath, projectRoot: tempDir });
    try {
      const old = service.saveObservation({
        category: "decision",
        title: "Old indexed storage decision",
        content: "old",
        topicKey: "storage",
      });
      const current = service.saveObservation({
        category: "decision",
        title: "Current indexed storage decision",
        content: "new",
        topicKey: "storage",
        supersedesTopicKey: "storage",
      });
      service.saveObservation({
        category: "discovery",
        title: "Indexed discovery",
        content: "Adds a symbol link.",
        symbols: ["src/counted.ts"],
      });

      const brief = service.getSessionBrief();
      expect(brief.counts).toEqual({
        observations: 3,
        entities: 1,
        links: 1,
      });
      expect(
        brief.activeDecisions.keyed
          .flatMap((group) => group.decisions)
          .map((decision) => decision.title)
      ).toEqual(["Current indexed storage decision"]);
      expect(brief.recentActivity.map((item) => item.id)).not.toContain(
        current.id
      );
      expect(brief.recentActivity.map((item) => item.id)).toContain(old.id);
      expect(
        brief.recentActivity.find((item) => item.id === old.id)?.superseded_by
      ).toBe(current.id);
      expect(brief.markdown).toContain(
        `SUPERSEDED (replaced by \`${current.id}\`)`
      );
    } finally {
      service.close();
    }
  });

  it("derives project identity and explains a missing project row without inserting one", () => {
    const service = new MemoryService({ dbPath, projectRoot: tempDir });
    service.saveObservation({
      category: "decision",
      title: "Project row exists",
      content: "Seeded",
    });
    service.close();

    const otherRoot = path.join(tempDir, "nested-root");
    const brief = readSessionBrief({
      dbPath,
      projectRoot: otherRoot,
      paths: ["src"],
    });
    expect(brief.project).toMatchObject({
      id: null,
      name: "nested-root",
      rootPath: path.resolve(otherRoot),
    });
    expect(brief.counts).toEqual({ observations: 0, entities: 0, links: 0 });
    expect(brief.notes.join(" ")).toContain("No project record was found");
    expect(brief.notes.join(" ")).toContain(
      "Indexed symbols are unavailable"
    );
    expect(fs.existsSync(otherRoot)).toBe(false);

    const check = new Database(dbPath, { readonly: true });
    try {
      expect(
        check
          .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM projects")
          .get()?.count
      ).toBe(1);
    } finally {
      check.close();
    }
  });

  it("fails open for an unopenable database path and rejects the :memory: read-only opener", () => {
    expect(() => getReadOnlyDatabase(":memory:")).toThrow(
      /existing database file/
    );

    const directoryDbPath = path.join(tempDir, "not-a-database");
    fs.mkdirSync(directoryDbPath);
    const brief = readSessionBrief({
      dbPath: directoryDbPath,
      projectRoot: tempDir,
    });
    expect(brief.counts).toEqual({
      observations: null,
      entities: null,
      links: null,
    });
    expect(brief.notes.join(" ").toLowerCase()).toContain("unavailable");
    expect(fs.readdirSync(directoryDbPath)).toEqual([]);
  });

  it("returns the exact shared output from a lazy default MCP server with snake_case aliases", async () => {
    const service = seed();
    service.close();

    const expected = readSessionBrief({
      dbPath,
      projectRoot: tempDir,
      paths: ["src/service"],
      budgetChars: 5_000,
    }).markdown;
    const server = createMcpServer({ dbPath, projectRoot: tempDir });
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "brief-alias-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "muninn_bootstrap",
        arguments: { paths: ["src/service"], budget_chars: 5_000 },
      });
      expect(callText(result)).toBe(expected);
      expect(callText(result).startsWith("{")).toBe(false);
    } finally {
      await client.close();
      await server.close();
      // The default server never materialized the writable service for bootstrap.
      server.closeService();
    }
  });

  it("validates MCP bootstrap input and keeps serving after a rejected request", async () => {
    const schema = MuninnBootstrapSchema;
    expect(schema.parse({ budget_chars: 100 })).toMatchObject({
      budget_chars: 100,
    });
    expect(normalizeArgs({ budget_chars: 100 })).toMatchObject({
      budget_chars: 100,
      budgetChars: 100,
    });
    expect(schema.safeParse({ paths: Array(21).fill("src") }).success).toBe(
      false
    );
    expect(schema.safeParse({ budgetChars: 0 }).success).toBe(false);
    expect(
      schema.safeParse({ budgetChars: MAX_SESSION_BRIEF_BUDGET + 1 }).success
    ).toBe(false);

    const server = createMcpServer({ dbPath, projectRoot: tempDir });
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "brief-validation-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);

    try {
      const invalid = (await client.callTool({
        name: "muninn_bootstrap",
        arguments: { paths: Array(21).fill("src") },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(invalid.isError).toBe(true);
      expect(invalid.content[0].text).toContain("Validation error");

      const valid = await client.callTool({
        name: "muninn_bootstrap",
        arguments: {},
      });
      expect(callText(valid)).toContain("unavailable");
      expect(fs.existsSync(path.join(tempDir, ".huginn"))).toBe(false);
    } finally {
      await client.close();
      await server.close();
      server.closeService();
    }
  });

  it("renders identical CLI output to the shared renderer and rejects invalid bounds", async () => {
    const service = seed();
    service.close();
    const expected = readSessionBrief({ dbPath, projectRoot: tempDir }).markdown;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleMemoryCommand(
        "brief",
        { "--db": dbPath, "--project": tempDir },
        []
      );
      expect(logSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toBe(
        expected
      );
      expect(errorSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);

      const invalidCases: Array<Record<string, string>> = [
        { "--paths": Array.from({ length: 21 }, () => "src").join(",") },
        { "--budget": "0" },
        { "--budget": String(MAX_SESSION_BRIEF_BUDGET + 1) },
        { "--budget": "not-a-number" },
        { "--paths": "../outside" },
      ];
      for (const args of invalidCases) {
        process.exitCode = 0;
        errorSpy.mockClear();
        logSpy.mockClear();
        await handleMemoryCommand(
          "brief",
          { "--db": dbPath, "--project": tempDir, ...args },
          []
        );
        expect(process.exitCode).toBe(1);
        expect(errorSpy).toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("fails open from the service method when its database is already closed", () => {
    const service = new MemoryService({ dbPath, projectRoot: tempDir });
    const projectId = service.currentProject.id;
    service.saveObservation({
      category: "decision",
      title: "Will become unreadable",
      content: "Seeded before closing",
    });
    service.close(true);

    const brief = service.getSessionBrief();
    expect(brief.counts).toEqual({
      observations: null,
      entities: null,
      links: null,
    });
    expect(brief.project.id).toBe(projectId);
    expect(brief.notes.join(" ").toLowerCase()).toContain("unavailable");
  });

  it("closes an explicitly injected service through the MCP closeService hook", async () => {
    const service = new MemoryService({ dbPath, projectRoot: tempDir });
    const server = createMcpServer(service);
    try {
      server.closeService();
      expect(service.db.open).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("serves MCP bootstrap without creating a writable database", async () => {
    const server = createMcpServer({ dbPath, projectRoot: tempDir });
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "brief-default-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "muninn_bootstrap",
        arguments: {},
      });
      expect(callText(result)).toContain("unavailable");
      expect(fs.existsSync(path.join(tempDir, ".huginn"))).toBe(false);
    } finally {
      await client.close();
      await server.close();
      server.closeService();
    }
  });
});

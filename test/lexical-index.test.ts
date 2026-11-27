import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { MemoryService } from "../src/service/memory-service.js";
import { indexProject, searchSymbols } from "../src/graph/index.js";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("lexical index v2 (observations)", () => {
  let service: MemoryService;
  let db: Database.Database;
  let root: string;

  beforeEach(() => {
    root = tempDir("muninn-lexical-");
    service = new MemoryService({ dbPath: ":memory:", projectRoot: root });
    db = service.db;
  });

  afterEach(() => {
    service.close(true);
  });

  it("matches morphological variants through porter stemming", () => {
    service.saveObservation({
      category: "convention",
      title: "Verification gate",
      content: "Every change is verified by running the full suite before release.",
    });

    const results = service.search({ query: "verify" });
    expect(results.map((result) => result.title)).toContain("Verification gate");
  });

  it("folds diacritics so an unaccented query finds accented content", () => {
    service.saveObservation({
      category: "discovery",
      title: "Configuración regional",
      content: "La sesión usa configuración regional en español.",
    });

    const results = service.search({ query: "sesion configuracion" });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Configuración regional");
  });

  it("recovers a substring the tokenizer cannot tokenize as a prefix", () => {
    service.saveObservation({
      category: "architecture",
      title: "Continuity record",
      content: "The supersessionmarker links a decision to its replacement.",
    });

    const results = service.search({ query: "ersessionmarker" });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Continuity record");
  });
});

describe("memory hygiene", () => {
  let service: MemoryService;
  let root: string;

  beforeEach(() => {
    root = tempDir("muninn-dedup-");
    service = new MemoryService({ dbPath: ":memory:", projectRoot: root });
  });

  afterEach(() => {
    service.close(true);
  });

  function seedRow(title: string, content: string): void {
    service.db
      .prepare(
        `INSERT INTO observations (id, project_id, category, title, content, agent)
         VALUES (?, ?, 'decision', ?, ?, 'muninn-seed')`
      )
      .run(`seed-${Math.random().toString(16).slice(2)}`, service.currentProject.id, title, content);
  }

  it("supersedes a seeded copy when a session recorded the same title", () => {
    seedRow("Storage decision", "seeded extract");
    const saved = service.saveObservation({
      category: "decision",
      title: "Storage decision",
      content: "recorded by the session",
    });

    const report = service.dedupObservations({ dryRun: true });
    expect(report.superseded).toBe(1);
    expect(report.entries[0]?.reason).toBe("seeded-copy");
    expect(report.entries[0]?.kept).toBe(saved.id);
    // Dry run leaves the row active.
    expect(service.search({ query: "seeded extract" })).toHaveLength(1);

    const applied = service.dedupObservations();
    expect(applied.superseded).toBe(1);
    expect(service.search({ query: "seeded extract" })).toHaveLength(0);
    expect(service.search({ query: "recorded by the session" })).toHaveLength(1);
  });

  it("supersedes identical bodies and leaves distinct titles alone", () => {
    service.saveObservation({
      category: "convention",
      title: "Same title",
      content: "Same body.",
    });
    service.saveObservation({
      category: "convention",
      title: "Same title",
      content: "Same body.",
    });
    service.saveObservation({
      category: "convention",
      title: "Other title",
      content: "Different body.",
    });

    const report = service.dedupObservations();
    expect(report.superseded).toBe(1);
    expect(report.entries[0]?.reason).toBe("identical-content");
  });
});

describe("lexical index v2 (code symbols)", () => {
  let root: string;
  let service: MemoryService;

  beforeEach(() => {
    root = tempDir("muninn-symbols-");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "contracts.ts"),
      [
        "export function verifyTypeScriptContracts(): number {",
        "  return 1;",
        "}",
        "",
        "export function read_session_brief(): number {",
        "  return 2;",
        "}",
        "",
      ].join("\n")
    );
    service = new MemoryService({ dbPath: ":memory:", projectRoot: root });
  });

  afterEach(() => {
    service.close(true);
  });

  it("finds a camelCase symbol by one of its subwords", async () => {
    await indexProject(service, { mode: "full" });
    const projectId = service.currentProject.id;

    const bySubword = searchSymbols(service.db, projectId, "contracts");
    expect(bySubword.some((hit) => hit.symbol.name === "verifyTypeScriptContracts")).toBe(true);

    const byStem = searchSymbols(service.db, projectId, "verifying");
    expect(byStem.some((hit) => hit.symbol.name === "verifyTypeScriptContracts")).toBe(true);
  });

  it("finds a snake_case symbol by one of its subwords", async () => {
    await indexProject(service, { mode: "full" });
    const projectId = service.currentProject.id;

    const hits = searchSymbols(service.db, projectId, "brief");
    expect(hits.some((hit) => hit.symbol.name === "read_session_brief")).toBe(true);
  });
});

describe("incremental indexing correctness", () => {
  let root: string;
  let service: MemoryService;

  beforeEach(() => {
    root = tempDir("muninn-incremental-");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    service = new MemoryService({ dbPath: ":memory:", projectRoot: root });
  });

  afterEach(() => {
    service.close(true);
  });

  it("re-parses a file whose bytes changed even when mtime and size are preserved", async () => {
    const file = path.join(root, "src", "same.ts");
    fs.writeFileSync(file, "export function alpha(): number { return 1; }\n");
    await indexProject(service, { mode: "full" });
    const before = fs.statSync(file);

    fs.writeFileSync(file, "export function omega(): number { return 1; }\n");
    fs.utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000);

    const summary = await indexProject(service, { mode: "changed" });
    expect(summary.changedFiles).toBe(1);

    const projectId = service.currentProject.id;
    expect(searchSymbols(service.db, projectId, "omega").length).toBeGreaterThan(0);
    expect(searchSymbols(service.db, projectId, "alpha")).toHaveLength(0);
  });

  it("refreshes only the fingerprint when the bytes are identical", async () => {
    const file = path.join(root, "src", "touch.ts");
    fs.writeFileSync(file, "export function stable(): number { return 1; }\n");
    await indexProject(service, { mode: "full" });
    const before = fs.statSync(file);
    const later = new Date(before.mtimeMs + 5_000);
    fs.utimesSync(file, later, later);

    const summary = await indexProject(service, { mode: "changed" });
    expect(summary.changedFiles).toBe(0);

    const row = service.db
      .prepare<[], { mtime_ms: number }>(
        "SELECT mtime_ms FROM code_files WHERE path = 'src/touch.ts'"
      )
      .get();
    expect(row?.mtime_ms).toBe(Math.floor(later.getTime()));
  });

  it("re-parses every file when the indexer version changes", async () => {
    const file = path.join(root, "src", "versioned.ts");
    fs.writeFileSync(file, "export function versioned(): number { return 1; }\n");
    await indexProject(service, { mode: "full" });

    service.db
      .prepare("UPDATE code_index_state SET indexer_version = 0")
      .run();

    const summary = await indexProject(service, { mode: "changed" });
    expect(summary.changedFiles).toBe(1);
    const state = service.db
      .prepare<[], { indexer_version: number }>(
        "SELECT indexer_version FROM code_index_state LIMIT 1"
      )
      .get();
    expect(state?.indexer_version).toBe(2);
  });
});

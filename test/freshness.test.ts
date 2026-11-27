import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryService } from "../src/service/memory-service.js";
import {
  checkIndexFreshness,
  getIndexStatus,
  indexProject,
} from "../src/graph/index.js";
import { maybeAutoIndex } from "../src/mcp/server.js";
import { handleHookCommand } from "../src/commands/hook.js";

const roots: string[] = [];

function tempDir(prefix = "muninn-fresh-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("code-graph freshness", () => {
  let root: string;
  let service: MemoryService;

  beforeEach(() => {
    root = tempDir();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "a.ts"),
      "export function alpha(): number { return 1; }\n"
    );
    service = new MemoryService({ dbPath: ":memory:", projectRoot: root });
  });

  afterEach(() => {
    service.close(true);
  });

  it("reports an empty graph as not fresh", () => {
    const freshness = checkIndexFreshness(service);
    expect(freshness.fresh).toBe(false);
    expect(freshness.reason).toMatch(/empty/);
  });

  it("is fresh right after indexing and stale after an edit", async () => {
    await indexProject(service, { mode: "full" });
    expect(checkIndexFreshness(service).fresh).toBe(true);

    fs.writeFileSync(
      path.join(root, "src", "a.ts"),
      "export function alpha(): number { return 2; }\n"
    );
    const freshness = checkIndexFreshness(service);
    expect(freshness.fresh).toBe(false);
    expect(freshness.staleFiles).toBeGreaterThan(0);
    expect(freshness.reason).toMatch(/changed/);
  });

  it("treats an indexer version change as stale", async () => {
    await indexProject(service, { mode: "full" });
    service.db.prepare("UPDATE code_index_roots SET indexer_version = 1").run();
    const freshness = checkIndexFreshness(service);
    expect(freshness.fresh).toBe(false);
    expect(freshness.reason).toMatch(/indexer v1/);
  });

  it("detects a new commit in a Git worktree", async () => {
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");

    await indexProject(service, { mode: "full" });
    expect(checkIndexFreshness(service).fresh).toBe(true);

    fs.writeFileSync(
      path.join(root, "src", "a.ts"),
      "export function alpha(): number { return 3; }\n"
    );
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "second");

    const freshness = checkIndexFreshness(service);
    expect(freshness.fresh).toBe(false);
    expect(freshness.staleFiles).toBe(1);
    expect(freshness.reason).toMatch(/changed/);
  });

  it("keeps a root fingerprint that status can report", async () => {
    await indexProject(service, { mode: "full" });
    const status = getIndexStatus(service);
    expect(status.exists).toBe(true);
    const row = service.db
      .prepare<[], { files: number; indexer_version: number }>(
        "SELECT files, indexer_version FROM code_index_roots LIMIT 1"
      )
      .get();
    expect(row?.files).toBeGreaterThan(0);
    expect(row?.indexer_version).toBe(2);
  });
});

describe("MCP auto-index", () => {
  let root: string;
  let service: MemoryService;

  beforeEach(() => {
    root = tempDir();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "a.ts"),
      "export function alpha(): number { return 1; }\n"
    );
    service = new MemoryService({ dbPath: ":memory:", projectRoot: root });
    delete process.env.MUNINN_AUTO_INDEX;
  });

  afterEach(() => {
    service.close(true);
    delete process.env.MUNINN_AUTO_INDEX;
  });

  it("does nothing for tools that do not read the graph", async () => {
    await indexProject(service, { mode: "full" });
    expect(await maybeAutoIndex(service, "muninn_search", { force: true })).toBe(
      "skipped"
    );
  });

  it("never cold-indexes a project without a graph", async () => {
    expect(await maybeAutoIndex(service, "muninn_explore", { force: true })).toBe(
      "skipped"
    );
  });

  it("honours the debounce window and the environment switch", async () => {
    await indexProject(service, { mode: "full" });
    const now = Date.now();
    expect(
      await maybeAutoIndex(service, "muninn_explore", { now, force: true })
    ).toBe("fresh");
    fs.writeFileSync(
      path.join(root, "src", "a.ts"),
      "export function alpha(): number { return 2; }\n"
    );
    expect(
      await maybeAutoIndex(service, "muninn_explore", { now: now + 1_000 })
    ).toBe("skipped");
    process.env.MUNINN_AUTO_INDEX = "0";
    expect(
      await maybeAutoIndex(service, "muninn_explore", { now: now + 60_000, force: true })
    ).toBe("skipped");
  });

  it("refreshes a stale graph in place", async () => {
    await indexProject(service, { mode: "full" });
    fs.writeFileSync(
      path.join(root, "src", "a.ts"),
      "export function alpha(): number { return 42; }\n"
    );
    expect(
      await maybeAutoIndex(service, "muninn_graph", { force: true })
    ).toBe("indexed");
    expect(checkIndexFreshness(service).fresh).toBe(true);
  });
});

describe("after-edit hook", () => {
  let root: string;
  let service: MemoryService;

  beforeEach(() => {
    root = tempDir();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "a.ts"),
      "export function alpha(): number { return 1; }\n"
    );
    service = new MemoryService({ projectRoot: root });
    service.saveObservation({
      category: "decision",
      title: "Hook fixture",
      content: "fixture",
    });
    service.close(true);
  });

  afterEach(() => {
    const current = roots[roots.length - 1];
    if (current) fs.rmSync(current, { recursive: true, force: true });
  });

  it("indexes changed files without printing noise", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await handleHookCommand("after-edit", {
        "--project": root,
        "--quiet": true,
        "--json": true,
      });
    } finally {
      spy.mockRestore();
    }
    expect(logs).toHaveLength(1);
    const summary = JSON.parse(logs[0]!);
    expect(summary.changedFiles).toBe(1);
  });

  it("is a no-op in a project without a Muninn database", async () => {
    const empty = tempDir();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await handleHookCommand("after-edit", { "--project": empty, "--json": true });
    } finally {
      spy.mockRestore();
    }
    expect(logs).toHaveLength(0);
  });
});

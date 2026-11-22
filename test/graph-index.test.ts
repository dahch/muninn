import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../src/service/memory-service.js";
import {
  buildExplore,
  findImportCycles,
  findSymbol,
  getAffectedTests,
  getEdges,
  getFileImports,
  getImpact,
  getIndexStatus,
  indexProject,
  searchSymbols,
} from "../src/graph/index.js";

const roots: string[] = [];

function tempProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "muninn-graph-")));
  roots.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "a.ts"),
    [
      'import { beta } from "./b";',
      "export function alpha(): number {",
      "  return beta();",
      "}",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(dir, "src", "b.ts"),
    [
      'import { alpha } from "./a";',
      "export function beta(): number {",
      "  return 2;",
      "}",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(dir, "src", "use.ts"),
    [
      'import { alpha } from "./a";',
      "export function run(): number {",
      "  return alpha();",
      "}",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(dir, "tests", "use.test.ts"),
    [
      'import { run } from "../src/use";',
      "export function testRun(): number {",
      "  return run();",
      "}",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(dir, "app.py"),
    [
      "import os",
      "",
      "def handler():",
      "    return helper()",
      "",
      "def helper():",
      "    return os.getcwd()",
      "",
    ].join("\n")
  );
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("Code graph indexing", () => {
  let root: string;
  let service: MemoryService;

  beforeEach(() => {
    root = tempProject();
    service = new MemoryService({ dbPath: ":memory:", projectRoot: root });
  });

  afterEach(() => {
    service.close(true);
  });

  it("indexes TypeScript and heuristic languages into files, symbols and edges", async () => {
    const summary = await indexProject(service, { mode: "full" });
    expect(summary.changedFiles).toBe(5);
    expect(summary.symbols).toBeGreaterThanOrEqual(5);
    expect(summary.edges).toBeGreaterThan(0);

    const status = getIndexStatus(service);
    expect(status.files).toBe(5);
    expect(status.symbols).toBeGreaterThanOrEqual(5);
    expect(status.languages.some((row) => row.language === "typescript")).toBe(true);
    expect(status.languages.some((row) => row.language === "python")).toBe(true);
    expect(status.indexedAt).toBeTruthy();
  });

  it("searches symbols and resolves cross-file calls", async () => {
    await indexProject(service, { mode: "full" });
    const projectId = service.currentProject.id;
    const hits = searchSymbols(service.db, projectId, "alpha");
    const alpha = hits.find((hit) => hit.symbol.name === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.file_path).toBe("src/a.ts");

    const beta = findSymbol(service.db, projectId, "beta")!;
    const callers = getEdges(service.db, projectId, beta.id, "incoming", {
      kinds: ["calls"],
    });
    expect(callers.some((edge) => edge.symbol?.name === "alpha")).toBe(true);

    const alphaSymbol = findSymbol(service.db, projectId, "alpha")!;
    const callees = getEdges(service.db, projectId, alphaSymbol.id, "outgoing", {
      kinds: ["calls"],
    });
    expect(callees.some((edge) => edge.symbol?.name === "beta")).toBe(true);
  });

  it("answers impact, implementations, imports, cycles and tests", async () => {
    await indexProject(service, { mode: "full" });
    const projectId = service.currentProject.id;

    const alpha = findSymbol(service.db, projectId, "alpha")!;
    const impact = getImpact(service.db, projectId, alpha.id, { depth: 2 });
    expect(impact.some((entry) => entry.symbol.name === "run")).toBe(true);

    const imports = getFileImports(service.db, projectId, "src/use.ts");
    expect(imports.some((entry) => entry.path === "src/a.ts")).toBe(true);

    const cycles = findImportCycles(service.db, projectId);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toContain("src/a.ts");

    const tests = getAffectedTests(service.db, projectId, ["src/use.ts"]);
    expect(tests.some((entry) => entry.test_file === "tests/use.test.ts")).toBe(true);
  });

  it("builds a bounded explore response with source and call paths", async () => {
    await indexProject(service, { mode: "full" });
    const markdown = buildExplore(
      service.db,
      service.currentProject.id,
      root,
      "alpha",
      { budget: 8_000 }
    );
    expect(markdown).toContain("alpha");
    expect(markdown).toContain("function alpha");
    expect(markdown).toContain("beta");
    expect(markdown.length).toBeLessThanOrEqual(8_000);
  });

  it("resolves Python relative imports and cross-module calls", async () => {
    const pyRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "muninn-graph-py-")));
    roots.push(pyRoot);
    fs.mkdirSync(path.join(pyRoot, "pkg"));
    fs.writeFileSync(path.join(pyRoot, "pkg", "__init__.py"), "");
    fs.writeFileSync(
      path.join(pyRoot, "pkg", "mod.py"),
      "def target():\n    return 1\n"
    );
    fs.writeFileSync(
      path.join(pyRoot, "uses_pkg.py"),
      "from pkg.mod import target\n\ndef caller():\n    return target()\n"
    );

    const pyService = new MemoryService({ dbPath: ":memory:", projectRoot: pyRoot });
    try {
      await indexProject(pyService, { mode: "full" });
      const projectId = pyService.currentProject.id;
      const imports = getFileImports(pyService.db, projectId, "uses_pkg.py");
      expect(imports.some((entry) => entry.path === "pkg/mod.py")).toBe(true);

      const target = findSymbol(pyService.db, projectId, "target");
      expect(target).not.toBeNull();

      const { treeSitterAvailable } = await import("../src/graph/treesitter.js");
      if (await treeSitterAvailable()) {
        expect(pyService.db && target!.start_line).toBe(1);
        expect(target!.end_line).toBe(2);
      }
      const callers = getEdges(pyService.db, projectId, target!.id, "incoming", {
        kinds: ["calls"],
      });
      expect(callers.some((edge) => edge.symbol?.name === "caller")).toBe(true);
    } finally {
      pyService.close(true);
    }
  });

  it("is incremental: an unchanged file is not re-parsed, a changed one is", async () => {
    const first = await indexProject(service, { mode: "full" });
    expect(first.changedFiles).toBe(5);

    const second = await indexProject(service, { mode: "changed" });
    expect(second.changedFiles).toBe(0);

    // Change the mtime by writing different content.
    fs.writeFileSync(
      path.join(root, "src", "b.ts"),
      'import { alpha } from "./a";\nexport function beta(): number { return 3; }\n'
    );
    const third = await indexProject(service, { mode: "changed" });
    expect(third.changedFiles).toBe(1);
    expect(third.removedFiles).toBe(0);
  });

  it("removes deleted files and their symbols from the graph", async () => {
    await indexProject(service, { mode: "full" });
    const projectId = service.currentProject.id;
    expect(findSymbol(service.db, projectId, "helper")).not.toBeNull();

    fs.unlinkSync(path.join(root, "app.py"));
    const summary = await indexProject(service, { mode: "changed" });
    expect(summary.removedFiles).toBe(1);
    expect(findSymbol(service.db, projectId, "helper")).toBeNull();
    expect(searchSymbols(service.db, projectId, "helper")).toHaveLength(0);

    const status = getIndexStatus(service);
    expect(status.files).toBe(4);
  });

  it("honours .gitignore outside a Git repository", async () => {
    fs.mkdirSync(path.join(root, "generated"));
    fs.writeFileSync(path.join(root, "generated", "ignored.ts"), "export function ignored() {}\n");
    fs.writeFileSync(path.join(root, ".gitignore"), "generated/\n");

    const summary = await indexProject(service, { mode: "full" });
    expect(summary.indexedFiles).toBe(5);
    expect(findSymbol(service.db, service.currentProject.id, "ignored")).toBeNull();
  });
});

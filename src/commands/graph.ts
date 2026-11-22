/**
 * `muninn index` and `muninn graph` — the code-graph surface of the CLI.
 */
import fs from "node:fs";
import chalk from "chalk";
import { MemoryService } from "../service/memory-service.js";
import {
  findImportCycles,
  findSymbol,
  getAffectedTests,
  getEdges,
  getFileImports,
  getFileTree,
  getImpact,
  getImplementations,
  getIndexStatus,
  indexProject,
  readSourceSlice,
  searchSymbols,
} from "../graph/index.js";

/**
 * Watches the project and re-indexes changed files after a quiet window.
 * The process stays alive until SIGINT/SIGTERM.
 */
function startWatching(
  service: MemoryService,
  options: { maxFiles?: number; exclude?: string[] }
): void {
  const root = service.currentProject.root_path;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const summary = await indexProject(service, {
        mode: "changed",
        maxFiles: options.maxFiles,
        exclude: options.exclude,
      });
      if (summary.changedFiles > 0 || summary.removedFiles > 0) {
        console.log(
          chalk.dim(
            `[watch] ${summary.changedFiles} changed, ${summary.removedFiles} removed, ${summary.symbols} symbols (${summary.durationMs} ms)`
          )
        );
      }
    } catch (err) {
      console.error(`[watch] index failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      const name = filename ? String(filename) : "";
      if (!name) return;
      if (/(^|\/)(node_modules|\.git|\.muninn|dist|build|target)(\/|$)/.test(name)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void run();
      }, 1_200);
    });
  } catch (err) {
    console.error(`[watch] cannot watch ${root}: ${(err as Error).message}`);
    return;
  }
  const stop = (): void => {
    watcher.close();
    if (timer) clearTimeout(timer);
    service.close(true);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(chalk.dim(`[watch] watching ${root} (Ctrl+C to stop)`));
}

export function printIndexUsage(): void {
  console.log(`muninn index — build or refresh the code graph

Usage:
  muninn index [--project <path>] [--full] [--watch] [--json]
               [--max-files <n>] [--exclude dir1,dir2] [--no-treesitter]

The graph is incremental: only changed files are re-parsed. In a Git work tree
the file list comes from git, so .gitignore is honoured exactly; outside Git the
walker reads .gitignore itself.
`);
}

export function printGraphUsage(): void {
  console.log(`muninn graph — query the code graph

Usage:
  muninn graph search <query> [--limit <n>] [--json]
  muninn graph files [--limit <n>] [--json]
  muninn graph cycles [--limit <n>] [--json]
  muninn graph imports <file> [--json]
  muninn graph tests <file> [--json]
  muninn graph node <symbol> [--json]
  muninn graph callers <symbol> [--limit <n>] [--json]
  muninn graph callees <symbol> [--limit <n>] [--json]
  muninn graph impact <symbol> [--depth <1-3>] [--limit <n>] [--json]
  muninn graph implementations <symbol> [--json]
`);
}

export async function handleIndexCommand(
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  if (args["--help"] || args["-h"]) {
    printIndexUsage();
    return;
  }
  const dbPath = typeof args["--db"] === "string" ? args["--db"] : undefined;
  const projectRoot =
    typeof args["--project"] === "string" ? args["--project"] : undefined;
  const rawMaxFiles =
    typeof args["--max-files"] === "string" ? Number(args["--max-files"]) : undefined;
  const maxFiles =
    rawMaxFiles && Number.isFinite(rawMaxFiles) && rawMaxFiles > 0
      ? Math.floor(rawMaxFiles)
      : undefined;
  const exclude =
    typeof args["--exclude"] === "string"
      ? args["--exclude"].split(",").map((item) => item.trim()).filter(Boolean)
      : undefined;
  if (args["--no-treesitter"]) {
    process.env.MUNINN_TREESITTER = "0";
  }
  const service = new MemoryService({ dbPath, projectRoot });
  let watching = false;
  try {
    const summary = await indexProject(service, {
      mode: args["--full"] ? "full" : "changed",
      projectRoot: service.currentProject.root_path,
      maxFiles,
      exclude,
    });
    const status = getIndexStatus(service);
    if (args["--json"]) {
      console.log(JSON.stringify({ summary, status }, null, 2));
      return;
    }
    console.log(
      chalk.green(
        `✔ Indexed ${summary.changedFiles} changed file(s) of ${summary.indexedFiles} (${summary.symbols} symbols, ${summary.edges} edges) in ${summary.durationMs} ms`
      )
    );
    if (summary.removedFiles > 0) {
      console.log(`  Removed ${summary.removedFiles} deleted file(s) from the graph.`);
    }
    if (summary.skippedFiles > 0) {
      console.log(`  Skipped ${summary.skippedFiles} oversized file(s).`);
    }
    console.log(
      summary.preciseFiles > 0
        ? `  Engine: ${summary.preciseFiles} file(s) via tree-sitter; TypeScript/JavaScript via the Compiler API`
        : "  Engine: heuristic + Compiler API (install web-tree-sitter and @vscode/tree-sitter-wasm for Tier B)",
    );
    if (summary.truncated) {
      console.log(chalk.yellow("  Reached the file limit; index a subdirectory to cover the rest."));
    }
    console.log(
      `  Graph: ${status.files} files, ${status.symbols} symbols, ${status.edges} edges`
    );
    if (status.languages.length > 0) {
      console.log(
        "  Languages: " + status.languages.map((row) => `${row.language} (${row.files})`).join(", ")
      );
    }
    if (args["--watch"]) {
      watching = true;
      startWatching(service, { maxFiles, exclude });
    }
  } finally {
    if (!watching) service.close?.();
  }
}

function formatSymbol(symbol: {
  name?: string;
  qualified_name?: string;
  kind?: string;
  file_path?: string;
  start_line?: number;
} | null): string {
  if (!symbol) return "unresolved";
  return `${symbol.qualified_name ?? symbol.name} [${symbol.kind ?? "?"}] ${symbol.file_path ?? ""}:${symbol.start_line ?? "?"}`;
}

export async function handleGraphCommand(
  positionals: string[],
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  if (args["--help"] || args["-h"] || positionals.length === 0) {
    printGraphUsage();
    return;
  }
  const relation = positionals[0];
  const target = positionals[1];
  const dbPath = typeof args["--db"] === "string" ? args["--db"] : undefined;
  const projectRoot =
    typeof args["--project"] === "string" ? args["--project"] : undefined;
  const limit =
    typeof args["--limit"] === "string" ? Number(args["--limit"]) : undefined;
  const depth =
    typeof args["--depth"] === "string" ? Number(args["--depth"]) : undefined;
  const json = Boolean(args["--json"]);

  const service = new MemoryService({ dbPath, projectRoot });
  try {
    const db = service.db;
    const projectId = service.currentProject.id;
    const root = service.currentProject.root_path;
    let result: unknown;

    if (relation === "search") {
      if (!target) throw new Error("Usage: muninn graph search <query>");
      result = { symbols: searchSymbols(db, projectId, target, { limit }) };
    } else if (relation === "files") {
      result = { files: getFileTree(db, projectId, { limit }) };
    } else if (relation === "cycles") {
      result = { cycles: findImportCycles(db, projectId, limit ?? 20) };
    } else if (relation === "imports") {
      if (!target) throw new Error("Usage: muninn graph imports <file>");
      result = { file: target, imports: getFileImports(db, projectId, target) };
    } else if (relation === "tests") {
      if (!target) throw new Error("Usage: muninn graph tests <file>");
      result = { tests: getAffectedTests(db, projectId, [target], limit ?? 50) };
    } else {
      if (!target) throw new Error(`Usage: muninn graph ${relation} <symbol>`);
      const symbol = findSymbol(db, projectId, target);
      if (!symbol) {
        console.log(`Symbol "${target}" not found. Run \`muninn index\` first or check the name.`);
        process.exitCode = 1;
        return;
      }
      if (relation === "node") {
        result = {
          symbol,
          source: readSourceSlice(root, symbol.file_path, symbol.start_line, symbol.end_line, {
            maxLines: 120,
          }),
          callers: getEdges(db, projectId, symbol.id, "incoming", {
            kinds: ["calls", "references"],
            limit: limit ?? 20,
          }),
          callees: getEdges(db, projectId, symbol.id, "outgoing", {
            kinds: ["calls", "references"],
            limit: limit ?? 20,
          }),
          tests: getAffectedTests(db, projectId, [symbol.file_path], 20),
        };
      } else if (relation === "callers" || relation === "callees") {
        result = {
          symbol,
          edges: getEdges(db, projectId, symbol.id, relation === "callers" ? "incoming" : "outgoing", {
            kinds: ["calls", "references", "extends", "implements"],
            limit: limit ?? 50,
          }),
        };
      } else if (relation === "impact") {
        result = {
          symbol,
          depth: depth ?? 2,
          affected: getImpact(db, projectId, symbol.id, { depth, limit: limit ?? 50 }),
        };
      } else if (relation === "implementations") {
        result = {
          symbol,
          implementations: getImplementations(db, projectId, symbol.id, { limit: limit ?? 100 }),
        };
      } else {
        throw new Error(`Unknown relation "${relation}". Run \`muninn graph --help\`.`);
      }
    }

    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Human-readable rendering of the shared result shapes.
    const value = result as Record<string, unknown>;
    if (value.symbol) {
      console.log(chalk.bold(formatSymbol(value.symbol as Parameters<typeof formatSymbol>[0])));
      if (typeof value.source === "string" && value.source) {
        console.log("\n" + value.source);
      }
      for (const key of ["callers", "callees", "edges", "affected", "implementations"]) {
        const list = value[key];
        if (!Array.isArray(list)) continue;
        console.log(`\n${key}:`);
        for (const item of list as Array<Record<string, unknown>>) {
          const symbol = (item.symbol ?? item) as Parameters<typeof formatSymbol>[0];
          const depthLabel = typeof item.depth === "number" ? ` (depth ${item.depth})` : "";
          console.log(`- ${formatSymbol(symbol)}${depthLabel}`);
        }
      }
      const affectedTests = value.tests;
      if (Array.isArray(affectedTests) && affectedTests.length > 0) {
        console.log("\ntests:");
        for (const test of affectedTests as Array<{ test_file: string }>) {
          console.log(`- ${test.test_file}`);
        }
      }
      return;
    }
    if (Array.isArray(value.symbols)) {
      for (const hit of value.symbols as Array<{ symbol: Parameters<typeof formatSymbol>[0]; file_path: string }>) {
        console.log(formatSymbol({ ...hit.symbol, file_path: hit.file_path }));
      }
    } else if (Array.isArray(value.files)) {
      for (const file of value.files as Array<{ path: string; language: string; symbols: number }>) {
        console.log(`${file.path} — ${file.language}, ${file.symbols} symbols`);
      }
    } else if (Array.isArray(value.cycles)) {
      if (value.cycles.length === 0) console.log("No import cycles.");
      for (const cycle of value.cycles as string[][]) console.log(cycle.join(" -> "));
    } else if (Array.isArray(value.imports)) {
      for (const imported of value.imports as Array<{ path: string | null; target_name: string | null; resolution: string }>) {
        console.log(`${imported.path ?? imported.target_name} (${imported.resolution})`);
      }
    } else if (Array.isArray(value.tests)) {
      if (value.tests.length === 0) console.log("No affected tests found.");
      for (const test of value.tests as Array<{ test_file: string }>) console.log(test.test_file);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    service.close?.();
  }
}

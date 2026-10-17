import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { MemoryService } from "../service/memory-service.js";
import { startMcpServer } from "../mcp/server.js";
import { indexFilesIntoMuninn } from "../indexer/ast-indexer.js";
import { sanitizeTerminalText } from "../util/text.js";

const IGNORED_INDEX_DIRS = new Set([
  "node_modules",
  ".git",
  ".harness",
  ".huginn",
  "dist",
  "build",
  ".cache",
]);

const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

export function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(current: string) {
    if (!fs.existsSync(current)) return;
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!IGNORED_INDEX_DIRS.has(entry.name)) {
            walk(path.join(current, entry.name));
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SOURCE_FILE_EXTENSIONS.has(ext)) {
            results.push(path.join(current, entry.name));
          }
        }
      }
    } catch {
      // ignore read error
    }
  }
  walk(dir);
  return results;
}

export function printMemoryUsage(): void {
  console.log(`muninn memory — Persistent codebase memory across spec-build cycles

Usage:
  muninn memory init [--db <path>] [--project <path>]
  muninn memory search <query> [--category <cat>] [--limit <n>] [--project <path>]
  muninn memory sync [--import] [--file <path>] [--project <path>]
  muninn memory index [files...] [--project <path>] [--db <path>]

Subcommands:
  init     Initialize SQLite database and verify schema
  search   Search observations with BM25 relevance ranking
  sync     Export observations to disk (.jsonl) or import with --import
  index    Index AST symbols and dependencies into Muninn memory
`);
}

export function printMcpUsage(): void {
  console.log(`muninn mcp — Model Context Protocol server for Muninn memory

Usage:
  muninn mcp run [--db <path>] [--project <path>]

Subcommands:
  run     Start the stdio MCP server for agent memory integration
`);
}

export async function handleMemoryCommand(
  subcommand: string | undefined,
  args: Record<string, string | boolean | undefined>,
  positionals?: string[]
): Promise<void> {
  const dbPath = typeof args["--db"] === "string" ? args["--db"] : undefined;
  const projectRoot =
    typeof args["--project"] === "string"
      ? args["--project"]
      : typeof args["--root"] === "string"
        ? args["--root"]
        : undefined;

  if (
    !subcommand ||
    args["--help"] ||
    args["-h"] ||
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    printMemoryUsage();
    return;
  }

  if (subcommand === "init") {
    const service = new MemoryService({ dbPath, projectRoot });
    try {
      const project = service.currentProject;
      console.log(chalk.green("✔ Muninn memory database initialized"));
      console.log(`  Database: ${service.db.name}`);
      console.log(`  Project:  ${project.name} (${project.root_path})`);
      console.log(`  Status:   Tables ready`);
    } finally {
      service.close?.();
    }
    return;
  }

  if (subcommand === "search") {
    const queryPositional =
      positionals?.[0] ??
      (typeof args._positional === "string" && args._positional !== "search"
        ? args._positional
        : undefined);
    const query =
      typeof args["--query"] === "string" ? args["--query"] : queryPositional;

    if (!query || query.trim() === "") {
      console.error(chalk.red("Error: Search query is required."));
      process.exitCode = 1;
      return;
    }

    const category =
      typeof args["--category"] === "string" ? args["--category"] : undefined;
    const parsedLimit =
      typeof args["--limit"] === "string"
        ? Math.floor(Number(args["--limit"]))
        : undefined;
    const limit = parsedLimit && parsedLimit > 0 ? parsedLimit : 10;

    const service = new MemoryService({ dbPath, projectRoot });
    try {
      const results = service.search({
        query: query.trim(),
        category,
        limit,
      });

      if (results.length === 0) {
        console.log(`No observations found matching "${query.trim()}".`);
        return;
      }

      console.log(
        chalk.bold(
          `Found ${results.length} result(s) for "${query.trim()}" (BM25 ranked):`
        )
      );

      for (const obs of results) {
        const categoryTag = chalk.cyan(`[${obs.category.toUpperCase()}]`);
        const rankScore = chalk.gray(`(score: ${obs.rank.toFixed(3)})`);
        console.log(`\n${categoryTag} ${chalk.bold(obs.title)} ${rankScore}`);

        if (obs.topic_key) {
          console.log(`  ${chalk.dim("Topic:")} ${obs.topic_key}`);
        }

        const preview =
          obs.content.length > 150
            ? `${obs.content.slice(0, 147)}...`
            : obs.content;
        console.log(`  ${chalk.white(preview.replace(/\n/g, " "))}`);

        if (obs.entities && obs.entities.length > 0) {
          const symbols = obs.entities.map((e) => e.identifier).join(", ");
          console.log(`  ${chalk.dim("Symbols:")} ${chalk.yellow(symbols)}`);
        }
      }
    } finally {
      service.close?.();
    }
    return;
  }

  if (subcommand === "sync") {
    const syncPositional =
      positionals?.[0] ??
      (typeof args._positional === "string" && args._positional !== "sync"
        ? args._positional
        : undefined);
    const filePath =
      typeof args["--file"] === "string" ? args["--file"] : syncPositional;

    const isImport = Boolean(args["--import"]);
    const service = new MemoryService({ dbPath, projectRoot });

    try {
      if (isImport) {
        const result = service.importFromDisk(filePath);
        console.log(
          `Imported ${result.imported} memories (skipped ${result.skipped} duplicates) from ${filePath ?? path.join(service.currentProject.root_path || process.cwd(), ".huginn", "memories.jsonl")}.`
        );
      } else {
        const result = service.syncToDisk(filePath);
        console.log(`Synced ${result.count} memories to ${result.path}.`);
      }
    } finally {
      service.close?.();
    }
    return;
  }

  if (subcommand === "index") {
    const rawFiles =
      positionals && positionals.length > 0
        ? positionals
        : typeof args._positional === "string" && args._positional !== "index"
          ? [args._positional]
          : [];

    const service = new MemoryService({ dbPath, projectRoot });
    try {
      const root = service.currentProject.root_path || process.cwd();
      const targetFiles =
        rawFiles.length > 0 ? rawFiles : findSourceFiles(root);

      const result = indexFilesIntoMuninn(service, targetFiles, {
        projectRoot: root,
      });
      console.log(
        chalk.green(
          `✔ Indexed ${result.indexedFiles} file(s) (${result.indexedSymbols} symbol(s), ${result.indexedDependencies} dependency link(s)) into Muninn memory.`
        )
      );
    } finally {
      service.close?.();
    }
    return;
  }

  console.error(chalk.red(`Unknown subcommand: ${subcommand}`));
  printMemoryUsage();
  process.exitCode = 1;
}

/**
 * Logs to stderr without ever risking a second crash (ADR-30.3): once the
 * parent pipe is gone, even the diagnostic write can fail with EPIPE.
 */
function logToStderr(line: string): void {
  try {
    process.stderr.write(line.endsWith("\n") ? line : `${line}\n`);
  } catch {
    /* stderr is gone too — the process is exiting anyway */
  }
}

interface StdioGuards {
  /** Removes every listener this branch installed. */
  dispose(): void;
}

/**
 * Installs the stdio guards that keep `muninn mcp run` from crashing or hanging
 * when its parent goes away (REQ-30 / AC-30.3):
 *
 * - an `'error'` handler on `process.stdout` so an EPIPE from a closed parent
 *   pipe is logged and turned into a clean shutdown instead of an unhandled
 *   exception that kills the server mid-response;
 * - a no-op `'error'` handler on `process.stderr` for the same reason (a dead
 *   parent usually breaks both ends);
 * - `'end'`/`'close'` on `process.stdin` — the SDK transport only observes
 *   `'data'`/`'error'`, so without this bridge a parent disconnect is invisible
 *   and the server would keep running forever.
 */
function installStdioGuards(onStdoutFailure: () => void): StdioGuards {
  const onStdoutError = (err: Error) => {
    logToStderr(
      `[muninn] mcp run: stdout write failed (${sanitizeTerminalText(err.message)}); shutting down.`,
    );
    onStdoutFailure();
  };
  const onStderrError = () => {
    /* a broken stderr must never crash the JSON-RPC server */
  };

  process.stdout.on("error", onStdoutError);
  process.stderr.on("error", onStderrError);

  return {
    dispose() {
      process.stdout.off("error", onStdoutError);
      process.stderr.off("error", onStderrError);
    },
  };
}

export async function handleMcpCommand(
  subcommand: string | undefined,
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  const dbPath = typeof args["--db"] === "string" ? args["--db"] : undefined;
  const projectRoot =
    typeof args["--project"] === "string"
      ? args["--project"]
      : typeof args["--root"] === "string"
        ? args["--root"]
        : undefined;

  if (
    !subcommand ||
    args["--help"] ||
    args["-h"] ||
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    printMcpUsage();
    return;
  }

  if (subcommand === "run") {
    const { server, transport, service } = await startMcpServer({
      dbPath,
      projectRoot,
    });
    try {
      // Protocol failures were previously discarded (AC-30.3): surface them on
      // stderr (never stdout — that stream carries JSON-RPC) without aborting.
      if (server) {
        server.onerror = (err: Error) => {
          logToStderr(`[muninn] mcp run: protocol error: ${sanitizeTerminalText(err.message)}`);
        };
      }

      // Keep process alive while stdio transport is connected:
      await new Promise<void>((resolve) => {
        let finished = false;
        const onStdinClosed = () => {
          if ((process.env.MUNINN_DEBUG || process.env.HUGINN_DEBUG)) {
            logToStderr("[muninn] mcp run: stdin closed by the client; shutting down.");
          }
          done();
        };
        const guards = installStdioGuards(() => done());
        const done = () => {
          if (finished) return;
          finished = true;
          process.removeListener("SIGINT", done);
          process.removeListener("SIGTERM", done);
          process.stdin.removeListener("end", onStdinClosed);
          process.stdin.removeListener("close", onStdinClosed);
          guards.dispose();
          resolve();
        };
        if (transport) {
          transport.onclose = () => done();
        } else {
          done();
          return;
        }
        // The parent disappearing is a lifecycle event, not a hang: bridge EOF
        // (and an abruptly closed pipe) to the same shutdown path as onclose.
        process.stdin.on("end", onStdinClosed);
        process.stdin.on("close", onStdinClosed);
        process.on("SIGINT", done);
        process.on("SIGTERM", done);
      });
    } finally {
      service?.close?.();
      await server?.close?.();
    }
    return;
  }

  console.error(chalk.red(`Unknown subcommand: ${subcommand}`));
  printMcpUsage();
  process.exitCode = 1;
}

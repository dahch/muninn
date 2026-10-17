#!/usr/bin/env node
/**
 * `muninn` — command-line surface for the Muninn memory engine.
 *
 * Three commands, one per consumer:
 *
 * - `muninn memory …` — init / search / sync / index the project database.
 * - `muninn mcp run`  — the stdio MCP server an agent runtime registers.
 * - `muninn check …`  — TypeScript execution-contract verification, the same
 *   pass the MCP `muninn_verify_contract` tool performs.
 *
 * The parser and the usage text are deliberately small and dependency-free:
 * this file is the only part of Muninn that has to be stable for other tools to
 * embed it.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleMcpCommand, handleMemoryCommand } from "./commands/memory.js";
import { handleCheckCommand } from "./commands/check.js";

export const VERSION = "0.1.0";

export interface ParsedArgs {
  [key: string]: string | boolean | undefined | string[];
  _command?: string;
  _positional?: string;
  _positionals?: string[];
}

/**
 * Flags that never consume the next argv entry as their value. `--import` is the
 * one that matters in practice: `muninn memory sync --import backup.jsonl` must
 * leave `backup.jsonl` as a positional, not swallow it into the flag.
 */
const BOOLEAN_FLAGS = new Set([
  "-h",
  "--help",
  "-v",
  "--version",
  "--import",
  "--json",
  "--quiet",
]);

/**
 * Parses argv into flags plus positionals.
 *
 * The first bare word is `_command`; every later bare word is appended to
 * `_positionals` (and mirrored in `_positional` as the last one), which is what
 * lets `memory search "vector search"` keep a multi-word query intact.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("-") && arg !== "-") {
      const eq = arg.indexOf("=");
      let key = arg;
      let value: string | boolean = true;
      if (eq !== -1) {
        key = arg.slice(0, eq);
        value = arg.slice(eq + 1);
      } else if (!BOOLEAN_FLAGS.has(key)) {
        const next = argv[i + 1];
        if (
          next !== undefined &&
          (!next.startsWith("-") || /^-\d+(\.\d+)?$/.test(next))
        ) {
          value = next;
          i++;
        }
      }
      out[key] = value;
    } else if (out._command === undefined) {
      out._command = arg;
    } else {
      out._positional = arg;
      (out._positionals as string[]).push(arg);
    }
  }
  return out;
}

export function usage(): string {
  return `muninn — persistent semantic and symbol memory for coding agents.

Usage:
  muninn memory init [--db <path>] [--project <path>]
  muninn memory search <query> [--category <cat>] [--limit <n>] [--project <path>]
  muninn memory sync [--import] [--file <path>] [--project <path>]
  muninn memory index [files...] [--project <path>] [--db <path>]
  muninn check [files...] [--project <path>]
  muninn mcp run [--db <path>] [--project <path>]

Commands:
  memory  query and manage the persistent codebase memory (init, search, sync, index)
  mcp     start the Muninn MCP server for agent memory integration (run)
  check   verify TypeScript execution contracts and pre-emit diagnostics

Storage:
  The database resolves to <git-root>/.huginn/muninn.db inside a repository and
  to ~/.huginn/muninn.db outside one. --db overrides it (":memory:" is accepted).
`;
}

/**
 * Runs the CLI. Exported (rather than inlined) so tests can drive it with an
 * explicit argv and assert on the routed handler.
 */
export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const command = args._command;

  if (args["--version"] === true || args["-v"] === true || command === "version") {
    console.log(`muninn ${VERSION}`);
    return;
  }

  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    args["--help"] === true ||
    args["-h"] === true
  ) {
    console.log(usage());
    return;
  }

  if (command === "memory") {
    const positionals = (args._positionals as string[] | undefined) ?? [];
    const subcommand =
      typeof positionals[0] === "string"
        ? positionals[0]
        : typeof args._positional === "string"
          ? args._positional
          : undefined;
    await handleMemoryCommand(
      subcommand,
      args as Record<string, string | boolean | undefined>,
      positionals.slice(1),
    );
    return;
  }

  if (command === "mcp") {
    const positionals = (args._positionals as string[] | undefined) ?? [];
    const subcommand =
      typeof positionals[0] === "string"
        ? positionals[0]
        : typeof args._positional === "string"
          ? args._positional
          : undefined;
    await handleMcpCommand(subcommand, args as Record<string, string | boolean | undefined>);
    return;
  }

  if (command === "check") {
    const positionals = (args._positionals as string[] | undefined) ?? [];
    const files =
      positionals.length > 0
        ? positionals
        : typeof args._positional === "string" && args._positional !== "check"
          ? [args._positional]
          : [];
    await handleCheckCommand(files, args as Record<string, string | boolean | undefined>);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.log(usage());
  process.exitCode = 1;
}

/**
 * True only when this module is the process entry point — under `node dist/cli.js`,
 * `bun dist/cli.js` or the installed `muninn` bin — and false when a test or a
 * consumer merely imports it.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`muninn: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

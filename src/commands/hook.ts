/**
 * `muninn hook` — the agent-agnostic hook contract.
 *
 * MCP `initialize.instructions` is the primary activation path, but not every
 * agent exposes instructions or a rules file. Any agent that can run a command at
 * session start/end can use these two hooks without Muninn knowing its format:
 *
 *   muninn hook session-start   -> prints the session brief (read-only)
 *   muninn hook session-end     -> writes the session handoff from git state
 */
import chalk from "chalk";
import { readSessionBrief } from "../service/memory-service.js";
import { handleEndSessionCommand } from "./handoff.js";

export function printHookUsage(): void {
  console.log(`muninn hook — session hooks for any agent

Usage:
  muninn hook session-start [--project <path>] [--budget <n>] [--json]
  muninn hook session-end [--goal <t>] [--state <s>] [--next "a;b"]
                          [--question "x;y"] [--agent <name>] [--project <path>]

session-start prints the project brief (read-only, no database is created).
session-end writes a handoff from the branch, changed files and last commit.

Wire these into your agent's own hook mechanism; no per-agent format is assumed.
`);
}

export async function handleHookCommand(
  subcommand: string | undefined,
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  if (!subcommand || args["--help"] || args["-h"] || subcommand === "help") {
    printHookUsage();
    return;
  }

  if (subcommand === "session-start") {
    const projectRoot =
      typeof args["--project"] === "string" ? args["--project"] : undefined;
    const rawBudget =
      typeof args["--budget"] === "string" ? Number(args["--budget"]) : undefined;
    const budgetChars =
      rawBudget && Number.isFinite(rawBudget) && rawBudget > 0
        ? Math.min(Math.floor(rawBudget), 20_000)
        : 4_000;
    const brief = readSessionBrief({ projectRoot, budgetChars });
    if (args["--json"]) {
      console.log(JSON.stringify(brief, null, 2));
      return;
    }
    console.log(brief.markdown);
    return;
  }

  if (subcommand === "session-end") {
    await handleEndSessionCommand(args);
    return;
  }

  console.error(chalk.red(`Unknown hook: ${subcommand}`));
  printHookUsage();
  process.exitCode = 1;
}

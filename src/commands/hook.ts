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
import fs from "node:fs";
import chalk from "chalk";
import {
  DEFAULT_SESSION_BRIEF_BUDGET,
  SESSION_BRIEF_ALL_BUDGET,
  SESSION_BRIEF_BUDGET_RULE,
  MemoryService,
  readSessionBrief,
  resolveSessionBriefBudget,
  type SessionBriefBudget,
} from "../service/memory-service.js";
import { indexProject } from "../graph/index.js";
import { memoryDbPath, resolveProjectContext } from "../project/identity.js";
import { handleEndSessionCommand } from "./handoff.js";

export function printHookUsage(): void {
  console.log(`muninn hook — session hooks for any agent

Usage:
  muninn hook session-start [--project <path>] [--budget <n>|all] [--all] [--json]
  muninn hook session-end [--goal <t>] [--state <s>] [--next "a;b"]
                          [--question "x;y"] [--agent <name>] [--project <path>]
  muninn hook after-edit [--project <path>] [--quiet] [--json]

session-start prints the project brief (read-only, no database is created).
session-end writes a handoff from the branch, changed files and last commit.
after-edit refreshes the code graph incrementally; it is a no-op in a project
that has no Muninn database, so it is safe to wire into any edit hook.

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
      typeof args["--budget"] === "string" ? args["--budget"] : undefined;
    // The hook used to clamp silently (Math.min(…, 20_000)) and default to
    // 4,000, so a caller asking for 60,000 received a shorter brief with no
    // indication that the request had been rewritten. Both are gone: the shared
    // resolver either honors the request or explains how to get the whole brief.
    let budgetChars: SessionBriefBudget | undefined;
    if (
      args["--all"] === true ||
      rawBudget?.trim().toLowerCase() === SESSION_BRIEF_ALL_BUDGET
    ) {
      budgetChars = SESSION_BRIEF_ALL_BUDGET;
    } else if (rawBudget !== undefined) {
      try {
        budgetChars = resolveSessionBriefBudget(Number(rawBudget));
      } catch {
        // Flag-level wording, matching the CLI: the shared resolver's message
        // uses the API field name, which is not what a hook user typed.
        console.error(
          chalk.red(`Error: --budget must be ${SESSION_BRIEF_BUDGET_RULE}.`)
        );
        process.exitCode = 1;
        return;
      }
    } else {
      budgetChars = DEFAULT_SESSION_BRIEF_BUDGET;
    }
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

  if (subcommand === "after-edit") {
    const projectRoot =
      typeof args["--project"] === "string" ? args["--project"] : undefined;
    const context = resolveProjectContext({
      explicitRoot: projectRoot ?? process.cwd(),
    });
    // Never create state from an edit hook: a project without memory stays
    // without memory until the user runs setup.
    if (!fs.existsSync(memoryDbPath(context.uid))) return;
    const service = new MemoryService({ projectRoot: context.rootPath });
    try {
      const summary = await indexProject(service, { mode: "changed" });
      if (args["--json"]) {
        console.log(JSON.stringify(summary, null, 2));
      } else if (!args["--quiet"] && (summary.changedFiles > 0 || summary.removedFiles > 0)) {
        console.log(
          `muninn: indexed ${summary.changedFiles} changed and ${summary.removedFiles} removed file(s) in ${summary.durationMs} ms`
        );
      }
    } finally {
      service.close(true);
    }
    return;
  }

  console.error(chalk.red(`Unknown hook: ${subcommand}`));
  printHookUsage();
  process.exitCode = 1;
}

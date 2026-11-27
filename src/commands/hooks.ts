/**
 * \`muninn hooks\` — install, inspect and remove agent session hooks.
 *
 * This is deliberately separate from \`muninn setup\`: hooks modify a shared
 * settings file, so they are opt-in and never part of the default MCP setup.
 * The agent, its settings path and its event plan come from the setup catalog,
 * so adding an agent with a hook mechanism is a registry entry, not new code.
 */
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import {
  getHooksStatus,
  setupHooks,
  uninstallHooks,
  type HooksReport,
} from "../setup/hooks-target.js";
import {
  AGENT_REGISTRY,
  isAgentId,
  resolveHooksPath,
  type AgentId,
} from "../setup/registry.js";

export function printHooksUsage(): void {
  console.log("muninn hooks — agent session hooks (opt-in)");
  console.log("");
  console.log("Usage:");
  console.log("  muninn hooks status [--agent <id>] [--scope user|project] [--home <path>] [--json]");
  console.log("  muninn hooks install [--agent <id>] [--scope user|project] [--project <path>]");
  console.log("                        [--home <path>] [--dry-run] [--force] [--json]");
  console.log("  muninn hooks uninstall [--agent <id>] [--scope user|project] [--project <path>]");
  console.log("                          [--home <path>] [--dry-run] [--json]");
  console.log("");
  console.log("Hooks run 'muninn hook session-start' (prints the brief),");
  console.log("'muninn hook session-end' (writes the handoff) and 'muninn hook after-edit'");
  console.log("(refreshes the code graph once per turn). Only the Muninn commands are");
  console.log("merged; unrelated settings and hooks are preserved.");
}

function printReport(report: HooksReport): void {
  const label =
    report.outcome === "written"
      ? chalk.green("written")
      : report.outcome === "present"
        ? chalk.green("present")
        : report.outcome === "skipped"
          ? chalk.yellow("skipped")
          : chalk.red("failed");
  console.log(chalk.bold(report.path) + " — " + label);
  if (report.error) console.log(chalk.red("  " + report.error));
  for (const command of report.present) console.log("  ✔ " + command);
  for (const command of report.missing) console.log("  ✘ " + command);
  if (report.dryRun) console.log(chalk.dim("  dry run: nothing was written"));
}

export async function handleHooksCommand(
  subcommand: string | undefined,
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  if (!subcommand || subcommand === "help" || args["--help"] || args["-h"]) {
    printHooksUsage();
    return;
  }
  const home =
    typeof args["--home"] === "string"
      ? path.resolve(args["--home"])
      : os.homedir();
  const agentArg =
    typeof args["--agent"] === "string" ? args["--agent"] : "claude";
  if (!isAgentId(agentArg)) {
    console.error(chalk.red(`Unknown agent "${agentArg}".`));
    process.exitCode = 1;
    return;
  }
  const agent: AgentId = agentArg;
  const scope = args["--scope"] === "project" ? "project" : "user";
  const projectPath =
    typeof args["--project"] === "string"
      ? path.resolve(args["--project"])
      : process.cwd();
  if (!AGENT_REGISTRY[agent].hooks) {
    console.error(
      chalk.red(
        `${AGENT_REGISTRY[agent].label} has no hook installer; use 'muninn hook' from its own hook mechanism.`
      )
    );
    process.exitCode = 1;
    return;
  }
  const resolved = resolveHooksPath(agent, {
    scope,
    projectPath,
    homeDir: home,
  });
  if (!resolved) {
    console.error(chalk.red(`Cannot resolve the ${scope} settings path.`));
    process.exitCode = 1;
    return;
  }
  const target = resolved;
  const dryRun = Boolean(args["--dry-run"]);
  const json = Boolean(args["--json"]);

  if (subcommand === "status") {
    const status = getHooksStatus({ path: target });
    if (json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(chalk.bold("Claude Code hooks"));
    console.log("  File:  " + status.path);
    console.log("  State: " + status.state);
    for (const command of status.present) console.log("  ✔ " + command);
    for (const command of status.missing) console.log("  ✘ " + command);
    if (status.error) console.log(chalk.red("  " + status.error));
    return;
  }

  if (subcommand === "install") {
    const report = setupHooks({ path: target, dryRun, force: Boolean(args["--force"]) });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printReport(report);
    if (report.outcome === "failed" || report.outcome === "skipped") {
      process.exitCode = 1;
    }
    return;
  }

  if (subcommand === "uninstall") {
    const report = uninstallHooks({ path: target, dryRun });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printReport(report);
    if (report.outcome === "failed") process.exitCode = 1;
    return;
  }

  console.error(chalk.red("Unknown hooks subcommand: " + subcommand));
  printHooksUsage();
  process.exitCode = 1;
}

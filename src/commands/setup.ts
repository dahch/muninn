import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import {
  getPortableStatus,
  setupPortable,
  type PortableReport,
  type PortableStatus,
} from "../setup/portable.js";
import {
  getJsonTargetStatus,
  setupJsonTarget,
  type JsonTargetReport,
  type JsonTargetStatus,
} from "../setup/json-target.js";
import {
  getTomlTargetStatus,
  setupTomlTarget,
  type TomlTargetReport,
  type TomlTargetStatus,
} from "../setup/toml-target.js";
import {
  AGENT_IDS,
  AGENT_REGISTRY,
  agentExecutable,
  parseAgentSelection,
  resolveMcpPaths,
  resolveRulesPath,
  type AgentId,
  type AgentTarget,
} from "../setup/registry.js";
import {
  getRulesTargetStatus,
  setupRulesTarget,
  type RulesTargetReport,
  type RulesTargetStatus,
} from "../setup/rules-target.js";
import { sanitizeTerminalText } from "../util/text.js";

export function printSetupUsage(): void {
  console.log(`muninn setup — Install and diagnose Muninn agent integrations

Usage:
  muninn setup [--portable] [--force] [--dry-run] [--status] [--list]
               [--agent <id|all|id,id>] [--project <path>] [--home <path>]

Options:
  --list           List the agent catalog without modifying anything
  --agent <ids>    Configure one ID, all, or a comma-separated list
  --project <path> Project root used by project-level agent configs
  --portable       Install the portable MCP configuration (default)
  --no-portable    Skip the portable configuration (requires --agent)
  --no-rules       Skip installing marked usage rules for selected agents
  --home <path>    Home directory to configure (default: OS home directory)
  --force          Replace a different existing Muninn entry
  --dry-run        Report intended changes without writing
  --status         Report configuration state without writing
`);
}

function setupError(message: string): void {
  console.error(chalk.red(`Error: ${sanitizeTerminalText(message)}`));
  process.exitCode = 1;
}

function setupWarning(message: string): void {
  console.error(chalk.yellow(`Warning: ${sanitizeTerminalText(message)}`));
}

function isEnabled(value: string | boolean | undefined): boolean {
  return value === true || value === "true";
}

function isExecutableAvailable(binary: string, envPath: string | undefined): boolean {
  if (envPath === undefined || envPath.length === 0) return false;
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const directory of envPath.split(path.delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const suffix =
        process.platform === "win32" &&
        !binary.toLowerCase().endsWith(extension.toLowerCase())
          ? extension
          : "";
      const candidate = path.join(directory, `${binary}${suffix}`);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // Try the next directory or extension.
      }
    }
  }
  return false;
}

function warnMissingBinaries(targets: AgentTarget[]): void {
  for (const target of targets) {
    const binary = agentExecutable(target.id);
    if (!isExecutableAvailable(binary, process.env.PATH)) {
      setupWarning(`${target.label} (${target.id}) binary "${binary}" is not installed in PATH`);
    }
  }
}

interface RulesGroup {
  path: string;
  agents: AgentId[];
}

function resolveRulesGroups(
  ids: AgentId[],
  projectPath: string,
): RulesGroup[] {
  const groups = new Map<string, RulesGroup>();
  for (const id of ids) {
    const rulesPath = resolveRulesPath(id, { projectPath });
    const key = path.resolve(rulesPath);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { path: key, agents: [id] });
    } else {
      existing.agents.push(id);
    }
  }
  return [...groups.values()];
}

function printRulesStatus(status: RulesTargetStatus): void {
  console.log(`Muninn rules (${status.agents.join(", ")})`);
  console.log(`  Path:    ${status.path}`);
  console.log(`  State:   ${status.state}`);
  console.log(`  Changed: false`);
  if (status.error) {
    console.error(chalk.red(`Error: ${sanitizeTerminalText(status.error)}`));
  }
}

function printRulesReport(report: RulesTargetReport): void {
  console.log(`Muninn rules (${report.agents.join(", ")})`);
  console.log(`  Path:    ${report.path}`);
  console.log(`  State:   ${report.state}`);
  console.log(`  Outcome: ${report.outcome}`);
  console.log(`  Changed: ${report.changed}`);
  if (report.dryRun) {
    console.log("  Dry run: no files were written");
  }
  if (report.error) {
    console.error(chalk.red(`Error: ${sanitizeTerminalText(report.error)}`));
  }
}

function printStatus(status: PortableStatus): void {
  console.log("Portable MCP configuration");
  console.log(`  Path:    ${status.path}`);
  console.log(`  State:   ${status.state}`);
  if (status.legacyPresent) {
    console.log(`  Legacy:  ${status.legacyPath} (not modified)`);
  }
  console.log(`  Changed: false`);
  if (status.error) {
    console.error(chalk.red(`Error: ${sanitizeTerminalText(status.error)}`));
  }
}

function printReport(report: PortableReport): void {
  console.log("Portable MCP configuration");
  console.log(`  Path:    ${report.path}`);
  console.log(`  State:   ${report.state}`);
  console.log(`  Outcome: ${report.outcome}`);
  console.log(`  Changed: ${report.changed}`);
  if (report.legacyPresent) {
    console.log(`  Legacy:  ${report.legacyPath} (not modified)`);
  }
  if (report.dryRun) {
    console.log("  Dry run: no files were written");
  }
  if (report.error) {
    console.error(chalk.red(`Error: ${sanitizeTerminalText(report.error)}`));
  }
}

function printTomlStatus(status: TomlTargetStatus): void {
  console.log(`${status.target.label} (${status.target.id})`);
  console.log(`  Path:    ${status.path}`);
  console.log(`  Format:  ${status.target.format}`);
  console.log(`  State:   ${status.state}`);
  console.log(`  Changed: false`);
  if (status.error) {
    console.error(chalk.red(`Error: ${sanitizeTerminalText(status.error)}`));
  }
}

function printTomlReport(report: TomlTargetReport): void {
  console.log(`${report.target.label} (${report.target.id})`);
  console.log(`  Path:    ${report.path}`);
  console.log(`  Format:  ${report.target.format}`);
  console.log(`  State:   ${report.state}`);
  console.log(`  Outcome: ${report.outcome}`);
  console.log(`  Changed: ${report.changed}`);
  if (report.dryRun) {
    console.log("  Dry run: no files were written");
  }
  if (report.error) {
    console.error(chalk.red(`Error: ${sanitizeTerminalText(report.error)}`));
  }
}

function printJsonStatus(status: JsonTargetStatus): void {
  console.log(`${status.target.label} (${status.target.id})`);
  console.log(`  Path:    ${status.path}`);
  console.log(`  Format:  ${status.target.format}`);
  console.log(`  State:   ${status.state}`);
  console.log(`  Changed: false`);
  if (status.error) {
    console.error(chalk.red(`Error: ${sanitizeTerminalText(status.error)}`));
  }
}

function printJsonReport(report: JsonTargetReport): void {
  console.log(`${report.target.label} (${report.target.id})`);
  console.log(`  Path:    ${report.path}`);
  console.log(`  Format:  ${report.target.format}`);
  console.log(`  State:   ${report.state}`);
  console.log(`  Outcome: ${report.outcome}`);
  console.log(`  Changed: ${report.changed}`);
  if (report.dryRun) {
    console.log("  Dry run: no files were written");
  }
  if (report.warning) {
    setupWarning(report.warning);
  }
  if (report.error) {
    console.error(chalk.red(`Error: ${sanitizeTerminalText(report.error)}`));
  }
}

function printCatalog(projectPath: string | undefined, homeDir: string | undefined): void {
  console.log("Muninn agent setup catalog");
  for (const id of AGENT_IDS) {
    const target = AGENT_REGISTRY[id];
    let mcps: string[];
    try {
      mcps = resolveMcpPaths(target, { projectPath, homeDir });
    } catch (err) {
      mcps = [`<error: ${(err as Error).message}>`];
    }
    console.log(`${target.id} — ${target.label}`);
    console.log(`  Format:  ${target.format}`);
    console.log(`  MCP:     ${mcps.join(", ")}`);
    console.log(`  Rules:   ${resolveRulesPath(target, { projectPath })}`);
  }
}

function selectedTargets(selection: AgentId[] | undefined): AgentTarget[] {
  return (selection ?? AGENT_IDS).map((id) => AGENT_REGISTRY[id]);
}

export async function handleSetupCommand(
  args: Record<string, string | boolean | undefined>,
): Promise<void> {
  if (args["--help"] || args["-h"]) {
    printSetupUsage();
    return;
  }

  const homeValue = args["--home"];
  if (homeValue !== undefined && typeof homeValue !== "string") {
    setupError("--home requires a path value.");
    printSetupUsage();
    return;
  }

  const projectValue = args["--project"];
  if (projectValue !== undefined && typeof projectValue !== "string") {
    setupError("--project requires a path value.");
    printSetupUsage();
    return;
  }

  const list = isEnabled(args["--list"]);
  const noPortable = isEnabled(args["--no-portable"]);
  const noRules = isEnabled(args["--no-rules"]);
  const status = isEnabled(args["--status"]);
  const dryRun = isEnabled(args["--dry-run"]);
  const force = isEnabled(args["--force"]);
  const agentValue = args["--agent"];
  const hasAgent = agentValue !== undefined && agentValue !== false;

  if (list && (status || dryRun || force || noPortable || hasAgent)) {
    setupError("--list cannot be combined with --status, --dry-run, --force, --agent, or --no-portable.");
    printSetupUsage();
    return;
  }

  if (hasAgent && typeof agentValue !== "string") {
    setupError("--agent requires an agent ID, `all`, or a comma-separated list.");
    printSetupUsage();
    return;
  }

  let selection: AgentId[] | undefined;
  if (typeof agentValue === "string") {
    const parsed = parseAgentSelection(agentValue);
    if (!parsed.ok) {
      setupError(
        `Unknown agent ID${parsed.unknown.length === 1 ? "" : "s"}: ${parsed.unknown.join(", ")}. ` +
          `Valid IDs: ${parsed.valid.join(", ")}, all.`,
      );
      return;
    }
    selection = parsed.ids;
  }

  if (noPortable && selection === undefined) {
    setupError(
      noRules
        ? "--no-portable --no-rules requires --agent; there is nothing to do."
        : "--no-portable requires --agent; there is nothing to do.",
    );
    printSetupUsage();
    return;
  }

  const home = typeof homeValue === "string" ? path.resolve(homeValue) : undefined;
  const projectPath =
    typeof projectValue === "string" ? path.resolve(projectValue) : path.resolve(process.cwd());
  const options = { homeDir: home, force, dryRun };

  if (list) {
    printCatalog(typeof projectValue === "string" ? projectPath : undefined, home);
    return;
  }

  if (status) {
    let fatal = false;
    const targets = selectedTargets(selection);
    if (selection !== undefined) warnMissingBinaries(targets);
    for (const target of targets) {
      let paths: string[];
      try {
        paths = resolveMcpPaths(target, { projectPath, homeDir: home });
      } catch (err) {
        fatal = true;
        setupError((err as Error).message);
        continue;
      }
      for (const configPath of paths) {
        if (target.format === "toml") {
          const result = getTomlTargetStatus({ target, path: configPath, projectPath });
          printTomlStatus(result);
          if (result.error !== undefined || result.errors.length > 0) fatal = true;
        } else {
          const result = getJsonTargetStatus({ target, path: configPath, projectPath });
          printJsonStatus(result);
          if (result.state === "malformed") fatal = true;
        }
      }
    }

    if (selection !== undefined && !noRules) {
      for (const group of resolveRulesGroups(selection, projectPath)) {
        const result = getRulesTargetStatus({
          path: group.path,
          agents: group.agents,
          projectPath,
        });
        printRulesStatus(result);
        if (result.state === "malformed" || result.errors.length > 0) fatal = true;
      }
    }

    if (!noPortable) {
      const result = getPortableStatus(options);
      printStatus(result);
      if (result.error !== undefined || result.errors.length > 0) fatal = true;
    }

    if (fatal) process.exitCode = 1;
    return;
  }

  const includePortable = selection === undefined || !noPortable;

  if (selection !== undefined) {
    const targets = selectedTargets(selection);
    warnMissingBinaries(targets);
    for (const target of targets) {
      let paths: string[];
      try {
        paths = resolveMcpPaths(target, { projectPath, homeDir: home });
      } catch (err) {
        setupError((err as Error).message);
        return;
      }

      for (const configPath of paths) {
        if (target.format === "toml") {
          const report = setupTomlTarget({
            target,
            path: configPath,
            projectPath,
            force,
            dryRun,
          });
          printTomlReport(report);
          if (report.outcome === "failed") {
            process.exitCode = 1;
            return;
          }
        } else {
          const report = setupJsonTarget({
            target,
            path: configPath,
            projectPath,
            force,
            dryRun,
          });
          printJsonReport(report);
          if (report.outcome === "failed") {
            process.exitCode = 1;
            return;
          }
        }
      }
    }

    if (!noRules) {
      for (const group of resolveRulesGroups(selection, projectPath)) {
        const report = setupRulesTarget({
          path: group.path,
          agents: group.agents,
          projectPath,
          force,
          dryRun,
        });
        printRulesReport(report);
        if (report.outcome === "failed") {
          process.exitCode = 1;
          return;
        }
      }
    }
  }

  if (!includePortable) return;

  const report = setupPortable(options);
  printReport(report);
  if (report.outcome === "failed") {
    process.exitCode = 1;
  }
}

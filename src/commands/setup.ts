import path from "node:path";
import chalk from "chalk";
import {
  getPortableStatus,
  setupPortable,
  type PortableReport,
  type PortableStatus,
} from "../setup/portable.js";
import { sanitizeTerminalText } from "../util/text.js";

export function printSetupUsage(): void {
  console.log(`muninn setup — Install and diagnose Muninn agent integrations

Usage:
  muninn setup [--portable] [--force] [--dry-run] [--status] [--home <path>]

Options:
  --portable       Install the portable MCP configuration (default)
  --no-portable    Skip the portable configuration (requires --agent)
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

function isEnabled(value: string | boolean | undefined): boolean {
  return value === true || value === "true";
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

  const agentValue = args["--agent"];
  const hasAgent = agentValue !== undefined && agentValue !== false;
  const noPortable = isEnabled(args["--no-portable"]);
  const status = isEnabled(args["--status"]);
  const dryRun = isEnabled(args["--dry-run"]);
  const force = isEnabled(args["--force"]);

  if (hasAgent && typeof agentValue !== "string") {
    setupError("--agent requires an agent ID, `all`, or a comma-separated list.");
    printSetupUsage();
    return;
  }

  if (noPortable && !hasAgent) {
    setupError("--no-portable requires --agent; there is nothing to do.");
    printSetupUsage();
    return;
  }

  const home =
    typeof homeValue === "string" ? path.resolve(homeValue) : undefined;
  const options = { homeDir: home, force, dryRun };

  if (status) {
    const result = getPortableStatus(options);
    printStatus(result);
    if (result.error !== undefined || result.errors.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  // Agent selection and rules are implemented in later setup iterations. The
  // portable destination is the only destination owned by this slice.
  if (noPortable) {
    return;
  }

  const report = setupPortable(options);
  printReport(report);
  if (report.outcome === "failed") {
    process.exitCode = 1;
  }
}

/**
 * `muninn memory handoff` and `muninn end-session`.
 *
 * The handoff is the record that makes a new session in a *different* agent cheap:
 * goal, current state, files touched, next steps, open questions and blockers.
 * `end-session` fills the mechanical parts (branch, changed files, last commit)
 * so the session can close with one command even when the agent forgot.
 */
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { MemoryService, type Handoff } from "../service/memory-service.js";

function splitList(value: string | boolean | undefined): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[;,]\s*/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

export function printHandoffUsage(): void {
  console.log(`muninn memory handoff — the "where we left off" record

Usage:
  muninn memory handoff status [--project <path>]
  muninn memory handoff --goal <text> --state <text>
        [--next "a;b"] [--question "x;y"] [--blocker "z"]
        [--files a,b] [--decision <id>] [--agent <name>] [--session <id>]
  muninn memory handoff --close [--project <path>]

The active handoff is rendered first in "muninn memory brief", so a new session
in any agent starts from it instead of re-reading the repository.
`);
}

export function printEndSessionUsage(): void {
  console.log(`muninn end-session — close a session with a handoff

Usage:
  muninn end-session [--goal <text>] [--state <text>]
        [--next "a;b"] [--question "x;y"] [--blocker "z"]
        [--agent <name>] [--session <id>] [--project <path>] [--db <path>]

Branch, changed files and the last commit are captured automatically into the
handoff state when --state is not given.
`);
}

function printHandoff(handoff: Handoff): void {
  console.log(chalk.bold("Handoff"), chalk.dim(handoff.id));
  console.log(`  Goal:  ${handoff.goal}`);
  console.log(`  State: ${handoff.state}`);
  if (handoff.agent) console.log(`  Agent: ${handoff.agent}`);
  if (handoff.branch) console.log(`  Branch: ${handoff.branch}`);
  if (handoff.files_touched.length > 0) {
    console.log(`  Files: ${handoff.files_touched.join(", ")}`);
  }
  if (handoff.next_steps.length > 0) {
    console.log("  Next steps:");
    handoff.next_steps.forEach((step, index) => {
      console.log(`    ${index + 1}. ${step}`);
    });
  }
  if (handoff.open_questions.length > 0) {
    console.log("  Open questions:");
    for (const question of handoff.open_questions) console.log(`    - ${question}`);
  }
  if (handoff.blockers.length > 0) {
    console.log("  Blockers:");
    for (const blocker of handoff.blockers) console.log(`    - ${blocker}`);
  }
  console.log(chalk.dim(`  Updated: ${handoff.updated_at}`));
}

export async function handleHandoffCommand(
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  if (args["--help"] || args["-h"]) {
    printHandoffUsage();
    return;
  }
  const dbPath = typeof args["--db"] === "string" ? args["--db"] : undefined;
  const projectRoot =
    typeof args["--project"] === "string" ? args["--project"] : undefined;
  const service = new MemoryService({ dbPath, projectRoot });
  try {
    if (args["--status"]) {
      const handoff = service.getActiveHandoff();
      if (!handoff) {
        console.log("No active handoff for this project.");
        return;
      }
      printHandoff(handoff);
      return;
    }
    if (args["--close"]) {
      const closed = service.closeHandoff();
      console.log(closed ? chalk.green("✔ Handoff closed") : "No active handoff to close.");
      return;
    }
    const goal = typeof args["--goal"] === "string" ? args["--goal"].trim() : "";
    const state = typeof args["--state"] === "string" ? args["--state"].trim() : "";
    if (!goal || !state) {
      throw new Error(
        "--goal and --state are required (or use --status / --close). Run 'muninn memory handoff --help' for the full usage."
      );
    }
    const handoff = service.saveHandoff({
      goal,
      state,
      agent: typeof args["--agent"] === "string" ? args["--agent"] : undefined,
      sessionId: typeof args["--session"] === "string" ? args["--session"] : undefined,
      branch: typeof args["--branch"] === "string" ? args["--branch"] : undefined,
      filesTouched: splitList(args["--files"]),
      nextSteps: splitList(args["--next"]),
      openQuestions: splitList(args["--question"]),
      blockers: splitList(args["--blocker"]),
      decisions: splitList(args["--decision"]),
    });
    console.log(chalk.green("✔ Handoff saved"));
    printHandoff(handoff);
  } finally {
    service.close?.();
  }
}

export async function handleEndSessionCommand(
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  if (args["--help"] || args["-h"]) {
    printEndSessionUsage();
    return;
  }
  const dbPath = typeof args["--db"] === "string" ? args["--db"] : undefined;
  const projectRoot =
    typeof args["--project"] === "string" ? args["--project"] : undefined;
  const service = new MemoryService({ dbPath, projectRoot });
  try {
    const root = service.currentProject.root_path;
    const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) || undefined;
    const lastCommit = git(root, ["log", "-1", "--format=%h %s"]) || undefined;
    const porcelain = git(root, ["status", "--porcelain"]);
    const files = porcelain
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((line) => line.length > 0)
      .slice(0, 200);

    const goal =
      typeof args["--goal"] === "string" && args["--goal"].trim()
        ? args["--goal"].trim()
        : `Continue the work in ${service.currentProject.name}`;
    const state =
      typeof args["--state"] === "string" && args["--state"].trim()
        ? args["--state"].trim()
        : [
            `Session ended${branch ? ` on branch \`${branch}\`` : ""}.`,
            lastCommit ? `Last commit: \`${lastCommit}\`.` : "",
            files.length > 0
              ? `${files.length} file(s) changed: ${files.slice(0, 20).join(", ")}${files.length > 20 ? ", …" : ""}.`
              : "No uncommitted changes.",
          ]
            .filter(Boolean)
            .join(" ");

    const handoff = service.saveHandoff({
      goal,
      state,
      agent: typeof args["--agent"] === "string" ? args["--agent"] : undefined,
      sessionId: typeof args["--session"] === "string" ? args["--session"] : undefined,
      branch,
      filesTouched: files,
      nextSteps: splitList(args["--next"]),
      openQuestions: splitList(args["--question"]),
      blockers: splitList(args["--blocker"]),
      decisions: splitList(args["--decision"]),
    });
    console.log(chalk.green("✔ Session handoff saved"));
    printHandoff(handoff);
    console.log(
      chalk.dim(
        "\nA new session in any agent that calls muninn_bootstrap will see this first."
      )
    );
  } finally {
    service.close?.();
  }
}

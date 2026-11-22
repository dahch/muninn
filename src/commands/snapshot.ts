/**
 * `muninn snapshot` and `muninn restore` — the in-repository memory snapshot.
 *
 * The primary store lives under `MUNINN_HOME`, which is right for daily work but
 * not portable by itself. A snapshot is a deterministic JSONL file inside the
 * project (`.muninn/memory.jsonl`), small enough to commit, and `restore` merges
 * it back by observation id on any machine.
 */
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { MemoryService } from "../service/memory-service.js";
import { PROJECT_MARKER_DIR } from "../project/identity.js";

export function printSnapshotUsage(): void {
  console.log(`muninn snapshot — write a portable memory snapshot into the project

Usage:
  muninn snapshot [--project <path>] [--file <path>] [--db <path>]

Default file: <project>/.muninn/memory.jsonl (deterministic, 0600).
Commit it if you want memory to travel with the repository.
`);
}

export function printRestoreUsage(): void {
  console.log(`muninn restore — merge a portable memory snapshot into the store

Usage:
  muninn restore [--project <path>] [--file <path>] [--db <path>]

Default file: <project>/.muninn/memory.jsonl. Import is idempotent by
observation id: existing records are skipped, never overwritten.
`);
}

function defaultSnapshotPath(root: string): string {
  return path.join(root, PROJECT_MARKER_DIR, "memory.jsonl");
}

export async function handleSnapshotCommand(
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  if (args["--help"] || args["-h"]) {
    printSnapshotUsage();
    return;
  }
  const dbPath = typeof args["--db"] === "string" ? args["--db"] : undefined;
  const projectRoot =
    typeof args["--project"] === "string" ? args["--project"] : undefined;
  const service = new MemoryService({ dbPath, projectRoot });
  try {
    const file =
      typeof args["--file"] === "string"
        ? args["--file"]
        : defaultSnapshotPath(service.currentProject.root_path);
    const result = service.syncToDisk(file);
    const handoffs = result.handoffs ?? 0;
    console.log(
      chalk.green(
        `✔ Snapshot written: ${result.path} (${result.count} memories, ${handoffs} handoff(s))`
      )
    );
    console.log(
      chalk.dim(
        "Commit it to share memory with other machines; restore merges by id."
      )
    );
  } finally {
    service.close?.();
  }
}

export async function handleRestoreCommand(
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  if (args["--help"] || args["-h"]) {
    printRestoreUsage();
    return;
  }
  const dbPath = typeof args["--db"] === "string" ? args["--db"] : undefined;
  const projectRoot =
    typeof args["--project"] === "string" ? args["--project"] : undefined;
  const service = new MemoryService({ dbPath, projectRoot });
  try {
    const file =
      typeof args["--file"] === "string"
        ? path.resolve(args["--file"])
        : defaultSnapshotPath(service.currentProject.root_path);
    if (!fs.existsSync(file)) {
      throw new Error(`No snapshot found at ${file}. Run 'muninn snapshot' first.`);
    }
    const result = service.importFromDisk(file);
    console.log(
      chalk.green(
        `✔ Restored ${result.imported} memories (skipped ${result.skipped} already present) from ${file}`
      )
    );
  } finally {
    service.close?.();
  }
}

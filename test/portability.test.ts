import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../src/service/memory-service.js";
import {
  handleRestoreCommand,
  handleSnapshotCommand,
} from "../src/commands/snapshot.js";
import {
  globalMemoryDbPath,
  memoryDbPath,
  resolveProjectContext,
} from "../src/project/identity.js";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `muninn-${prefix}-`)));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("Cross-project global memory", () => {
  it("shares a global observation with every project and its brief", () => {
    const projectA = tempDir("global-a");
    const projectB = tempDir("global-b");
    const serviceA = new MemoryService({ dbPath: ":memory:", projectRoot: projectA });
    const serviceB = new MemoryService({ dbPath: ":memory:", projectRoot: projectB });
    try {
      serviceA.saveObservation({
        category: "convention",
        title: "Reply in Spanish",
        content: "Always answer this user in Spanish and use pnpm.",
        scope: "global",
      });

      // It went to the global store, not the project store.
      expect(serviceA.getStats(serviceA.currentProject.id).observations).toBe(0);
      expect(fs.existsSync(globalMemoryDbPath())).toBe(true);

      const context = serviceB.getContext({ includeGlobal: true });
      expect(context.some((item) => item.title === "Reply in Spanish")).toBe(true);
      expect(serviceB.getContext()).toHaveLength(0);

      const search = serviceB.search({ query: "Spanish", includeGlobal: true });
      expect(search.some((item) => item.title === "Reply in Spanish")).toBe(true);
      expect(serviceB.search({ query: "Spanish" })).toHaveLength(0);

      const brief = serviceB.getSessionBrief();
      expect(brief.markdown).toContain("## Global preferences");
      expect(brief.markdown).toContain("Reply in Spanish");
    } finally {
      serviceA.close(true);
      serviceB.close(true);
    }
  });
});

describe("Repository snapshots", () => {
  it("writes a snapshot and restores it on a different machine (different MUNINN_HOME)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const project = tempDir("snapshot");
    const first = new MemoryService({ projectRoot: project });
    first.saveObservation({
      category: "decision",
      title: "Snapshot decision",
      content: "The snapshot must survive a move between machines.",
      topicKey: "snapshot",
    });
    first.saveHandoff({
      goal: "Snapshot goal",
      state: "Snapshot state",
      nextSteps: ["Continue on the other machine"],
    });
    first.close(true);

    await handleSnapshotCommand({ "--project": project });
    const snapshot = path.join(project, ".muninn", "memory.jsonl");
    expect(fs.existsSync(snapshot)).toBe(true);
    expect(fs.readFileSync(snapshot, "utf8")).toContain("Snapshot decision");
    expect(fs.statSync(snapshot).mode & 0o777).toBe(0o600);

    const previousHome = process.env.MUNINN_HOME;
    const otherMachineHome = tempDir("snapshot-home");
    process.env.MUNINN_HOME = otherMachineHome;
    try {
      const otherUid = resolveProjectContext({ explicitRoot: project }).uid;
      expect(fs.existsSync(memoryDbPath(otherUid))).toBe(false);

      await handleRestoreCommand({ "--project": project });

      const restored = new MemoryService({ projectRoot: project });
      try {
        const context = restored.getContext();
        expect(context.some((item) => item.title === "Snapshot decision")).toBe(true);
        expect(restored.getActiveHandoff()?.goal).toBe("Snapshot goal");
        // Idempotent: a second restore imports nothing.
        const second = restored.importFromDisk(snapshot);
        expect(second.imported).toBe(0);
        expect(second.skipped).toBeGreaterThanOrEqual(1);
      } finally {
        restored.close(true);
      }
    } finally {
      if (previousHome === undefined) delete process.env.MUNINN_HOME;
      else process.env.MUNINN_HOME = previousHome;
    }
    log.mockRestore();
  });
});

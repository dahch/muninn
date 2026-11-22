import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  MemoryService,
  readSessionBrief,
} from "../src/service/memory-service.js";
import {
  applySeedRecords,
  buildSeedRecords,
} from "../src/commands/seed.js";
import { buildServerInstructions, TOOL_REGISTRY } from "../src/mcp/server.js";
import { handleHookCommand } from "../src/commands/hook.js";
import { resolveProjectContext } from "../src/project/identity.js";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `muninn-${prefix}-`)));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("Session handoffs", () => {
  let service: MemoryService;
  let project: string;

  beforeEach(() => {
    project = tempDir("handoff");
    service = new MemoryService({ dbPath: ":memory:", projectRoot: project });
  });

  afterEach(() => {
    service.close(true);
  });

  it("saves a handoff and supersedes the previous active one", () => {
    const first = service.saveHandoff({
      goal: "Ship auth",
      state: "Middleware written, tests failing",
      nextSteps: ["Fix the token refresh test", "Update the docs"],
      openQuestions: ["Should refresh rotate the token?"],
      filesTouched: ["src/auth.ts"],
    });
    const second = service.saveHandoff({
      goal: "Ship auth",
      state: "Tests green",
      nextSteps: ["Open the PR"],
    });

    expect(second.status).toBe("active");
    expect(service.getActiveHandoff()?.id).toBe(second.id);
    const previous = service.getHandoff(first.id);
    expect(previous?.status).toBe("superseded");
    expect(service.listHandoffs()).toHaveLength(1);
    expect(service.listHandoffs({ includeSuperseded: true })).toHaveLength(2);
  });

  it("requires a goal and a state", () => {
    expect(() => service.saveHandoff({ goal: "", state: "x" })).toThrow(/goal/i);
    expect(() => service.saveHandoff({ goal: "x", state: "  " })).toThrow(/state/i);
  });

  it("closes the active handoff", () => {
    service.saveHandoff({ goal: "g", state: "s" });
    expect(service.closeHandoff()).toBe(true);
    expect(service.getActiveHandoff()).toBeNull();
    expect(service.closeHandoff()).toBe(false);
  });

  it("renders the handoff first in the session brief", () => {
    service.saveObservation({
      category: "decision",
      title: "Auth is a port",
      content: "Tokens are validated behind an AuthPort.",
      topicKey: "auth",
    });
    service.saveHandoff({
      goal: "Add token rotation",
      state: "Half done; the refresh path is broken",
      nextSteps: ["Fix refresh", "Add the rotation test"],
      openQuestions: ["Rotate on every refresh?"],
      blockers: ["No test fixture for expired tokens"],
    });

    const brief = service.getSessionBrief();
    expect(brief.markdown).toContain("## Where we left off");
    expect(brief.markdown).toContain("Add token rotation");
    expect(brief.markdown).toContain("Fix refresh");
    expect(brief.markdown).toContain("Rotate on every refresh?");
    expect(brief.markdown).toContain("## Active Decisions");
    // Continuity precedes the decision log.
    expect(brief.markdown.indexOf("Where we left off")).toBeLessThan(
      brief.markdown.indexOf("Active Decisions")
    );

  });

  it("the read-only bootstrap path sees the handoff", () => {
    const dbPath = path.join(project, "memory.db");
    const fileService = new MemoryService({ dbPath, projectRoot: project });
    try {
      fileService.saveHandoff({
        goal: "Read-only handoff",
        state: "Visible without opening the writable service",
        nextSteps: ["Continue"],
      });
    } finally {
      fileService.close(true);
    }

    const readOnly = readSessionBrief({ dbPath, projectRoot: project });
    expect(readOnly.markdown).toContain("## Where we left off");
    expect(readOnly.markdown).toContain("Read-only handoff");
    expect(readOnly.markdown).toContain("Continue");
  });

  it("omits the section when there is no handoff", () => {
    const brief = service.getSessionBrief();
    expect(brief.markdown).not.toContain("Where we left off");
    expect(brief.handoff ?? null).toBeNull();
  });
});

describe("Deterministic seeding", () => {
  function seedProject(): string {
    const root = tempDir("seed");
    fs.writeFileSync(
      path.join(root, "README.md"),
      "# Acme\n\nAcme is a tiny task manager used to exercise portable memory.\nIt stores tasks in SQLite.\n"
    );
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "acme",
        scripts: { test: "vitest run", build: "tsc -p tsconfig.json" },
      })
    );
    fs.writeFileSync(
      path.join(root, "ADR.md"),
      "# ADR\n\n## ADR-1: Store tasks locally\n\nUse SQLite instead of a server.\n\n## ADR-2: One process\n\nNo daemon.\n"
    );
    fs.writeFileSync(
      path.join(root, "AGENTS.md"),
      "# Agents\n\n- Run npm test before finishing.\n- Do not add network dependencies.\n"
    );
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(root, "src", "b.py"), "x = 1\n");
    return root;
  }

  it("extracts overview, commands, architecture, conventions and ADRs", () => {
    const root = seedProject();
    const records = buildSeedRecords(root, "project-id");
    const keys = records.map((record) => record.key);
    expect(keys).toContain("overview");
    expect(keys).toContain("commands");
    expect(keys).toContain("architecture");
    expect(keys).toContain("conventions");
    expect(keys).toContain("adr-1");
    expect(keys).toContain("adr-2");

    const overview = records.find((record) => record.key === "overview")!;
    expect(overview.content).toContain("tiny task manager");
    const commands = records.find((record) => record.key === "commands")!;
    expect(commands.content).toContain("npm run test");
    expect(commands.content).toContain("npm run build");
    const architecture = records.find((record) => record.key === "architecture")!;
    expect(architecture.content).toContain("TypeScript");
    expect(architecture.content).toContain("src/");
  });

  it("is idempotent: re-applying refreshes records instead of duplicating them", () => {
    const root = seedProject();
    const service = new MemoryService({ dbPath: ":memory:", projectRoot: root });
    try {
      const records = buildSeedRecords(root, service.currentProject.id);
      const first = applySeedRecords(service, records);
      expect(first.written).toBe(records.length);
      const countAfterFirst = service.getStats().observations;

      // The README changes; re-seeding must update the same observation ids.
      fs.writeFileSync(
        path.join(root, "README.md"),
        "# Acme\n\nAcme is now a calendar for teams that plan weekly work.\n"
      );
      const refreshed = buildSeedRecords(root, service.currentProject.id);
      applySeedRecords(service, refreshed);
      expect(service.getStats().observations).toBe(countAfterFirst);

      const overview = service.search({ query: "calendar" });
      expect(overview.some((item) => item.title.includes("what this project is"))).toBe(true);
    } finally {
      service.close(true);
    }
  });
});

describe("MCP activation", () => {
  it("sends project-aware instructions that mention the handoff rule", () => {
    const root = tempDir("instructions");
    const instructions = buildServerInstructions(root);
    expect(instructions).toContain(path.basename(root));
    expect(instructions).toContain("muninn_bootstrap");
    expect(instructions).toContain("muninn_save");
    expect(instructions).toContain("muninn_handoff");
    expect(instructions.length).toBeLessThan(2_000);
  });

  it("exposes handoff and project through the registry", async () => {
    const root = tempDir("registry-handoff");
    const service = new MemoryService({ dbPath: ":memory:", projectRoot: root });
    try {
      const saved = (await TOOL_REGISTRY.muninn_handoff.handler(service, {
        action: "end",
        goal: "Finish the feature",
        state: "Half done",
        nextSteps: ["Write the test"],
      })) as { handoff: { goal: string; next_steps: string[] } };
      expect(saved.handoff.goal).toBe("Finish the feature");
      expect(saved.handoff.next_steps).toEqual(["Write the test"]);

      const status = (await TOOL_REGISTRY.muninn_handoff.handler(service, {
        action: "status",
      })) as { handoff: { id: string } | null };
      expect(status.handoff).not.toBeNull();

      const projectStatus = (await TOOL_REGISTRY.muninn_project.handler(service, {
        action: "status",
        path: root,
      })) as { project: { rootPath: string; uid: string } };
      expect(projectStatus.project.rootPath).toBe(root);
      expect(projectStatus.project.uid).toBe(
        resolveProjectContext({ explicitRoot: root }).uid
      );
    } finally {
      service.close(true);
    }
  });
});

describe("Database compatibility", () => {
  it("keeps reading a v1 database that has neither handoffs nor observation metadata", () => {
    const dir = tempDir("old-db");
    const dbPath = path.join(dir, "muninn.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, git_remote TEXT,
        root_path TEXT NOT NULL UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE observations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, category TEXT NOT NULL,
        title TEXT NOT NULL, content TEXT NOT NULL, topic_key TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO projects (id, name, root_path) VALUES ('p1', 'Old', '${dir}');
      INSERT INTO observations (id, project_id, category, title, content)
        VALUES ('o1', 'p1', 'decision', 'Old decision', 'Old body');
    `);
    legacy.close();

    const brief = readSessionBrief({ dbPath, projectRoot: dir });
    // The read-only brief must degrade gracefully when the schema is older: an
    // explanatory note and unavailable counts, never a thrown exception.
    expect(brief.counts.observations).toBeNull();
    expect(brief.markdown).toContain("unavailable");
  });
});
describe("Agent hooks", () => {
  it("session-start prints the brief and session-end writes a handoff", async () => {
    const project = tempDir("hook");
    const service = new MemoryService({ dbPath: ":memory:", projectRoot: project });
    // The read-only hook needs a real file.
    service.close(true);
    const fileService = new MemoryService({ projectRoot: project });
    fileService.saveHandoff({ goal: "Hook goal", state: "Hook state" });
    fileService.close(true);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleHookCommand("session-start", { "--project": project });
      const startOutput = log.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(startOutput).toContain("Where we left off");
      expect(startOutput).toContain("Hook goal");

      log.mockClear();
      await handleHookCommand("session-end", {
        "--project": project,
        "--goal": "Closed goal",
        "--state": "Closed state",
        "--next": "Next step",
      });

      const check = new MemoryService({ projectRoot: project });
      try {
        expect(check.getActiveHandoff()?.goal).toBe("Closed goal");
        expect(check.getActiveHandoff()?.next_steps).toEqual(["Next step"]);
      } finally {
        check.close(true);
      }
    } finally {
      log.mockRestore();
    }
  });
});

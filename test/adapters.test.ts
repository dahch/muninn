import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MUNINN_DEDICATED_RULES,
  MUNINN_RULES_START,
  getRulesTargetStatus,
  setupRulesTarget,
} from "../src/setup/rules-target.js";
import {
  AGENT_REGISTRY,
  resolveHooksPath,
  resolveRulesPath,
} from "../src/setup/registry.js";
import { handleSetupCommand } from "../src/commands/setup.js";
import { handleHooksCommand } from "../src/commands/hooks.js";

const roots: string[] = [];

function tempDir(prefix = "muninn-adapters-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("dedicated rules strategy", () => {
  let project: string;
  let rulesPath: string;

  beforeEach(() => {
    project = tempDir();
    rulesPath = resolveRulesPath("claude", { projectPath: project });
  });

  it("points Claude at a file Muninn owns instead of the shared CLAUDE.md", () => {
    expect(AGENT_REGISTRY.claude.rulesStrategy).toBe("dedicated");
    expect(rulesPath).toBe(path.join(project, ".claude", "rules", "muninn.md"));
  });

  it("writes the whole file without markers and is idempotent", () => {
    const report = setupRulesTarget({
      path: rulesPath,
      agents: ["claude"],
      projectPath: project,
      strategy: "dedicated",
    });
    expect(report.outcome).toBe("written");
    const raw = fs.readFileSync(rulesPath, "utf8");
    expect(raw).toBe(MUNINN_DEDICATED_RULES);
    expect(raw).not.toContain(MUNINN_RULES_START);

    const second = setupRulesTarget({
      path: rulesPath,
      agents: ["claude"],
      projectPath: project,
      strategy: "dedicated",
    });
    expect(second.outcome).toBe("present");
    expect(fs.readFileSync(rulesPath, "utf8")).toBe(raw);
  });

  it("refreshes a Muninn-owned file whose content drifted", () => {
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.writeFileSync(rulesPath, "# Muninn project memory\n\nold rules\n");
    expect(
      getRulesTargetStatus({
        path: rulesPath,
        agents: ["claude"],
        projectPath: project,
        strategy: "dedicated",
      }).state
    ).toBe("stale");

    const report = setupRulesTarget({
      path: rulesPath,
      agents: ["claude"],
      projectPath: project,
      strategy: "dedicated",
    });
    expect(report.outcome).toBe("written");
    expect(fs.readFileSync(rulesPath, "utf8")).toBe(MUNINN_DEDICATED_RULES);
  });

  it("refuses to overwrite a file it does not own", () => {
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.writeFileSync(rulesPath, "# My own notes\n\nkeep me\n");

    const status = getRulesTargetStatus({
      path: rulesPath,
      agents: ["claude"],
      projectPath: project,
      strategy: "dedicated",
    });
    expect(status.state).toBe("malformed");

    const report = setupRulesTarget({
      path: rulesPath,
      agents: ["claude"],
      projectPath: project,
      strategy: "dedicated",
    });
    expect(report.outcome).toBe("failed");
    expect(fs.readFileSync(rulesPath, "utf8")).toContain("keep me");
  });
});

describe("hook installer descriptors", () => {
  it("resolves Claude user and project scope without special-casing", () => {
    const home = "/home/example";
    const project = "/work/project";
    expect(resolveHooksPath("claude", { scope: "user", homeDir: home })).toBe(
      path.join(home, ".claude", "settings.json")
    );
    expect(
      resolveHooksPath("claude", { scope: "project", projectPath: project, homeDir: home })
    ).toBe(path.join(project, ".claude", "settings.json"));
  });

  it("reports no installer for agents without a hook mechanism", () => {
    expect(AGENT_REGISTRY.cursor.hooks).toBeUndefined();
    expect(resolveHooksPath("cursor")).toBeNull();
  });

  it("installs hooks from the descriptor into the requested scope", async () => {
    const project = tempDir();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleHooksCommand("install", {
        "--agent": "claude",
        "--scope": "project",
        "--project": project,
      });
    } finally {
      logSpy.mockRestore();
    }
    const settingsPath = path.join(project, ".claude", "settings.json");
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const commands = JSON.stringify(parsed.hooks);
    expect(commands).toContain("muninn hook session-start");
    expect(commands).toContain("muninn hook session-end --agent claude");
    expect(commands).toContain("muninn hook after-edit --quiet");
  });

  it("rejects an agent without hooks instead of writing a file", async () => {
    const project = tempDir();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const previous = process.exitCode;
    try {
      await handleHooksCommand("install", {
        "--agent": "cursor",
        "--scope": "project",
        "--project": project,
      });
    } finally {
      errorSpy.mockRestore();
      process.exitCode = previous;
    }
    expect(fs.existsSync(path.join(project, ".claude", "settings.json"))).toBe(false);
  });
});

describe("setup only writes the selected components", () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = tempDir();
    project = tempDir();
  });

  async function run(args: Record<string, string | boolean>): Promise<string[]> {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      logs.push(values.map(String).join(" "));
    });
    try {
      await handleSetupCommand({
        "--home": home,
        "--project": project,
        ...args,
      });
    } finally {
      logSpy.mockRestore();
    }
    return logs;
  }

  it("installs only the MCP entry when rules and portable are not selected", async () => {
    await run({ "--agent": "claude", "--components": "mcp" });

    expect(fs.existsSync(path.join(project, ".mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".claude", "rules", "muninn.md"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".muninn", "mcp.json"))).toBe(false);
  });

  it("installs only the rules file when that is all that was selected", async () => {
    await run({ "--agent": "claude", "--components": "rules" });

    expect(fs.existsSync(path.join(project, ".claude", "rules", "muninn.md"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".muninn", "mcp.json"))).toBe(false);
  });

  it("accepts all as a component list", async () => {
    await run({ "--agent": "claude", "--components": "all" });
    expect(fs.existsSync(path.join(project, ".claude", "rules", "muninn.md"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".muninn", "mcp.json"))).toBe(true);
  });

  it("rejects an unknown component without writing anything", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const previous = process.exitCode;
    try {
      await handleSetupCommand({
        "--agent": "claude",
        "--components": "mcp,nope",
        "--home": home,
        "--project": project,
      });
    } finally {
      errorSpy.mockRestore();
      process.exitCode = previous;
    }
    expect(fs.readdirSync(project)).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("does not report a component in status that it would not write", async () => {
    const logs = await run({
      "--agent": "claude",
      "--components": "mcp",
      "--status": true,
    });
    const text = logs.join("\n");
    expect(text).not.toContain("Portable MCP configuration");
    expect(text).not.toContain("Muninn rules");
  });
});

describe("setup applies the strategy per destination", () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = tempDir();
    project = tempDir();
  });

  it("installs Claude rules in a dedicated file", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleSetupCommand({
        "--agent": "claude",
        "--home": home,
        "--project": project,
      });
    } finally {
      logSpy.mockRestore();
    }
    const dedicated = path.join(project, ".claude", "rules", "muninn.md");
    expect(fs.existsSync(dedicated)).toBe(true);
    expect(fs.readFileSync(dedicated, "utf8")).toContain("# Muninn project memory");
    expect(fs.existsSync(path.join(project, "CLAUDE.md"))).toBe(false);
  });
});

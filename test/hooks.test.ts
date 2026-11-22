import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOOK_END_COMMAND,
  HOOK_START_COMMAND,
  getHooksStatus,
  setupHooks,
  uninstallHooks,
} from "../src/setup/hooks-target.js";

const roots: string[] = [];

function tempSettings(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "muninn-hooks-")));
  roots.push(dir);
  return path.join(dir, "settings.json");
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("Claude Code session hooks", () => {
  it("installs both hooks, preserves unrelated settings, and is idempotent", () => {
    const file = tempSettings();
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          model: "sonnet",
          hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] },
        },
        null,
        2
      )
    );

    const report = setupHooks({ path: file });
    expect(report.outcome).toBe("written");
    expect(report.changed).toBe(true);
    expect(report.state).toBe("present");

    const parsed = readJson(file);
    expect(parsed.model).toBe("sonnet");
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe("echo done");
    expect(parsed.hooks.SessionStart[0].hooks[0]).toEqual({
      type: "command",
      command: HOOK_START_COMMAND,
    });
    expect(parsed.hooks.SessionEnd[0].hooks[0].command).toBe(HOOK_END_COMMAND);

    const before = fs.readFileSync(file, "utf8");
    const second = setupHooks({ path: file });
    expect(second.outcome).toBe("present");
    expect(second.changed).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(getHooksStatus({ path: file }).state).toBe("present");
  });

  it("creates a private settings file when none exists", () => {
    const file = tempSettings();
    const report = setupHooks({ path: file });
    expect(report.outcome).toBe("written");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readJson(file).hooks.SessionStart).toBeDefined();
  });

  it("does not write in a dry run", () => {
    const file = tempSettings();
    const report = setupHooks({ path: file, dryRun: true });
    expect(report.outcome).toBe("written");
    expect(report.dryRun).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("reports a malformed settings file instead of overwriting it", () => {
    const file = tempSettings();
    fs.writeFileSync(file, "{not json", "utf8");
    const report = setupHooks({ path: file });
    expect(report.outcome).toBe("failed");
    expect(report.state).toBe("malformed");
    expect(fs.readFileSync(file, "utf8")).toBe("{not json");
  });

  it("fills a partial installation", () => {
    const file = tempSettings();
    fs.writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: HOOK_START_COMMAND }] }],
        },
      })
    );
    expect(getHooksStatus({ path: file }).state).toBe("partial");
    const report = setupHooks({ path: file });
    expect(report.outcome).toBe("written");
    expect(getHooksStatus({ path: file }).missing).toEqual([]);
  });

  it("skips a conflicting hooks shape without --force", () => {
    const file = tempSettings();
    fs.writeFileSync(file, JSON.stringify({ hooks: [] }));
    const report = setupHooks({ path: file });
    expect(report.outcome).toBe("skipped");
    expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify({ hooks: [] }));
  });

  it("removes only the Muninn hooks on uninstall", () => {
    const file = tempSettings();
    fs.writeFileSync(
      file,
      JSON.stringify({
        model: "sonnet",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] },
      })
    );
    setupHooks({ path: file });
    const report = uninstallHooks({ path: file });
    expect(report.outcome).toBe("written");

    const parsed = readJson(file);
    expect(parsed.model).toBe("sonnet");
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe("echo done");
    expect(parsed.hooks.SessionStart).toBeUndefined();
    expect(parsed.hooks.SessionEnd).toBeUndefined();
    expect(getHooksStatus({ path: file }).state).toBe("absent");
  });
});

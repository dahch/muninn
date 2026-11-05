import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalPortableEntry,
  getPortableStatus,
  resolvePortablePaths,
  setupPortable,
} from "../src/setup/portable.js";
import {
  AGENT_IDS,
  AGENT_REGISTRY,
  isProjectContained,
  parseAgentSelection,
  resolveMcpPaths,
  resolveRulesPath,
} from "../src/setup/registry.js";
import {
  canonicalAgentEntry,
  getJsonTargetStatus,
  setupJsonTarget,
} from "../src/setup/json-target.js";
import {
  getTomlTargetStatus,
  setupTomlTarget,
} from "../src/setup/toml-target.js";
import {
  LEGACY_RULES_END,
  LEGACY_RULES_START,
  MUNINN_RULES_END,
  MUNINN_RULES_START,
  getRulesTargetStatus,
  setupRulesTarget,
} from "../src/setup/rules-target.js";
import { handleSetupCommand, printSetupUsage } from "../src/commands/setup.js";
import { VERSION, main, parseArgs, usage } from "../src/cli.js";

const canonical = { command: "muninn", args: ["mcp", "run"] };

function readConfig(configPath: string): any {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

describe("portable MCP setup (Iteration 1)", () => {
  let home: string;
  let paths: ReturnType<typeof resolvePortablePaths>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-setup-test-"));
    paths = resolvePortablePaths(home);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function loggedText(): string {
    return [
      ...logSpy.mock.calls.map((call: unknown[]) => call.join(" ")),
      ...errorSpy.mock.calls.map((call: unknown[]) => call.join(" ")),
    ].join("\n");
  }

  it("creates {home}/.muninn/mcp.json with the canonical portable entry", () => {
    const report = setupPortable({ homeDir: home });

    expect(report.outcome).toBe("written");
    expect(report.changed).toBe(true);
    expect(report.path).toBe(path.join(home, ".muninn", "mcp.json"));
    expect(fs.existsSync(report.path)).toBe(true);

    const config = readConfig(report.path);
    expect(config.mcpServers.muninn).toEqual(canonical);
    expect(config.mcpServers.muninn.args).not.toContain("--project");

    expect(fs.statSync(path.dirname(report.path)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(report.path).mode & 0o777).toBe(0o600);
  });

  it("merges only mcpServers.muninn and preserves unrelated JSON data", () => {
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    fs.writeFileSync(
      paths.configPath,
      JSON.stringify(
        {
          customRoot: { keep: true },
          mcpServers: {
            other: { command: "other", args: ["serve"] },
            muninn: { command: "old-muninn", args: ["old"] },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const report = setupPortable({ homeDir: home, force: true });
    expect(report.outcome).toBe("written");

    const config = readConfig(report.path);
    expect(config.customRoot).toEqual({ keep: true });
    expect(config.mcpServers.other).toEqual({ command: "other", args: ["serve"] });
    expect(config.mcpServers.muninn).toEqual(canonical);
  });

  it("skips a conflicting entry without --force and replaces it with --force", () => {
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    const original =
      JSON.stringify(
        {
          mcpServers: {
            other: { command: "other", args: [] },
            muninn: { command: "huginn", args: ["mcp", "run"] },
          },
        },
        null,
        2,
      ) + "\n";
    fs.writeFileSync(paths.configPath, original);

    const skipped = setupPortable({ homeDir: home });
    expect(skipped.outcome).toBe("skipped");
    expect(skipped.changed).toBe(false);
    expect(fs.readFileSync(paths.configPath, "utf8")).toBe(original);

    const replaced = setupPortable({ homeDir: home, force: true });
    expect(replaced.outcome).toBe("written");
    expect(replaced.changed).toBe(true);
    const config = readConfig(paths.configPath);
    expect(config.mcpServers.muninn).toEqual(canonical);
    expect(config.mcpServers.other).toEqual({ command: "other", args: [] });
  });

  it("is byte-for-byte idempotent and reports present without changed", async () => {
    setupPortable({ homeDir: home });
    const before = fs.readFileSync(paths.configPath);
    const beforeStat = fs.statSync(paths.configPath);

    const second = setupPortable({ homeDir: home });
    expect(second.outcome).toBe("present");
    expect(second.changed).toBe(false);
    expect(fs.readFileSync(paths.configPath)).toEqual(before);
    expect(fs.statSync(paths.configPath).mtimeMs).toBe(beforeStat.mtimeMs);

    await handleSetupCommand({ "--home": home });
    expect(loggedText()).toContain("Changed: false");
  });

  it("reports malformed JSON with path and cause and exits 1", async () => {
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    fs.writeFileSync(paths.configPath, "{ this is not json\n");

    const status = getPortableStatus({ homeDir: home });
    expect(status.state).toBe("malformed");
    expect(status.error).toContain(paths.configPath);
    expect(status.error?.toLowerCase()).toContain("malformed json");

    const report = setupPortable({ homeDir: home });
    expect(report.outcome).toBe("failed");
    expect(report.changed).toBe(false);
    expect(fs.readFileSync(paths.configPath, "utf8")).toBe("{ this is not json\n");

    await handleSetupCommand({ "--home": home, "--status": true });
    expect(process.exitCode).toBe(1);
    expect(loggedText()).toContain(paths.configPath);
  });

  it("treats malformed containers and entries as malformed rather than conflicts", () => {
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    fs.writeFileSync(paths.configPath, JSON.stringify({ mcpServers: [] }));
    expect(getPortableStatus({ homeDir: home }).state).toBe("malformed");

    fs.writeFileSync(paths.configPath, JSON.stringify({ mcpServers: { muninn: "nope" } }));
    expect(getPortableStatus({ homeDir: home }).state).toBe("malformed");
  });

  it("reports all portable diagnostic states", () => {
    expect(getPortableStatus({ homeDir: home })).toMatchObject({
      state: "absent",
      legacyPresent: false,
    });

    setupPortable({ homeDir: home });
    expect(getPortableStatus({ homeDir: home })).toMatchObject({
      state: "registered",
      legacyPresent: false,
    });

    fs.writeFileSync(
      paths.configPath,
      JSON.stringify({ mcpServers: { muninn: { command: "different", args: [] } } }),
    );
    expect(getPortableStatus({ homeDir: home }).state).toBe("conflict");

    fs.rmSync(paths.configPath);
    fs.mkdirSync(path.dirname(paths.legacyPath), { recursive: true });
    const legacyBytes = JSON.stringify({ mcpServers: { muninn: canonical } }) + "\n";
    fs.writeFileSync(paths.legacyPath, legacyBytes);
    const legacyStatus = getPortableStatus({ homeDir: home });
    expect(legacyStatus.state).toBe("legacy");
    expect(legacyStatus.legacyPresent).toBe(true);
    expect(legacyStatus.legacyPath).toBe(paths.legacyPath);
    expect(fs.readFileSync(paths.legacyPath, "utf8")).toBe(legacyBytes);

    fs.writeFileSync(paths.configPath, "{ broken");
    expect(getPortableStatus({ homeDir: home }).state).toBe("malformed");
  });

  it("does not modify the legacy file when installing the portable configuration", () => {
    fs.mkdirSync(path.dirname(paths.legacyPath), { recursive: true });
    const legacyBytes = '{"mcpServers":{"muninn":{"command":"legacy"}}}\n';
    fs.writeFileSync(paths.legacyPath, legacyBytes);

    const report = setupPortable({ homeDir: home });
    expect(report.outcome).toBe("written");
    expect(report.legacyPresent).toBe(true);
    expect(fs.readFileSync(paths.legacyPath, "utf8")).toBe(legacyBytes);
    expect(readConfig(paths.configPath).mcpServers.muninn).toEqual(canonical);
  });

  it("dry-run plans the write without creating files, directories, or temporaries", () => {
    const report = setupPortable({ homeDir: home, dryRun: true });
    expect(report.outcome).toBe("written");
    expect(report.changed).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(fs.existsSync(path.join(home, ".muninn"))).toBe(false);
    expect(fs.readdirSync(home)).toEqual([]);

    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    fs.writeFileSync(paths.configPath, JSON.stringify({ mcpServers: {} }) + "\n");
    const before = fs.readFileSync(paths.configPath);
    const beforeStat = fs.statSync(paths.configPath);
    const dirBefore = fs.readdirSync(path.dirname(paths.configPath)).sort();

    const existingDryRun = setupPortable({ homeDir: home, dryRun: true });
    expect(existingDryRun.outcome).toBe("written");
    expect(fs.readFileSync(paths.configPath)).toEqual(before);
    expect(fs.statSync(paths.configPath).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(fs.readdirSync(path.dirname(paths.configPath)).sort()).toEqual(dirBefore);
  });

  it("status is read-only for registered, absent, and malformed configurations", () => {
    const absent = getPortableStatus({ homeDir: home });
    expect(absent.changed).toBe(false);
    expect(fs.existsSync(path.join(home, ".muninn"))).toBe(false);

    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    fs.writeFileSync(paths.configPath, JSON.stringify({ mcpServers: {} }) + "\n");
    const before = fs.readFileSync(paths.configPath);
    const beforeStat = fs.statSync(paths.configPath);
    const entries = fs.readdirSync(path.dirname(paths.configPath)).sort();

    getPortableStatus({ homeDir: home });
    expect(fs.readFileSync(paths.configPath)).toEqual(before);
    expect(fs.statSync(paths.configPath).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(fs.readdirSync(path.dirname(paths.configPath)).sort()).toEqual(entries);
  });

  it("preserves existing file permissions and rejects a final-component symlink", () => {
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    fs.writeFileSync(paths.configPath, JSON.stringify({ mcpServers: {} }) + "\n", {
      mode: 0o640,
    });
    fs.chmodSync(paths.configPath, 0o640);

    const report = setupPortable({ homeDir: home });
    expect(report.outcome).toBe("written");
    expect(fs.statSync(paths.configPath).mode & 0o777).toBe(0o640);

    const target = path.join(home, "target.json");
    fs.writeFileSync(target, "{}\n");
    fs.rmSync(paths.configPath);
    fs.symlinkSync(target, paths.configPath);

    const targetBefore = fs.readFileSync(target, "utf8");
    const symlinkReport = setupPortable({ homeDir: home, force: true });
    expect(symlinkReport.outcome).toBe("failed");
    expect(symlinkReport.error?.toLowerCase()).toContain("symlink");
    expect(fs.readFileSync(target, "utf8")).toBe(targetBefore);
    expect(fs.lstatSync(paths.configPath).isSymbolicLink()).toBe(true);

    const status = getPortableStatus({ homeDir: home });
    expect(status.state).toBe("malformed");
    expect(status.errors.join("\n").toLowerCase()).toContain("symlink");
  });

  it("supports --portable and rejects --no-portable without --agent with usage and exit 1", async () => {
    await handleSetupCommand({ "--home": home, "--portable": true });
    expect(fs.existsSync(paths.configPath)).toBe(true);
    expect(readConfig(paths.configPath).mcpServers.muninn).toEqual(canonical);

    const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-setup-noport-"));
    try {
      await handleSetupCommand({ "--home": freshHome, "--no-portable": true });
      expect(process.exitCode).toBe(1);
      expect(loggedText()).toContain("--no-portable requires --agent");
      expect(loggedText()).toContain("Usage:");
      expect(fs.existsSync(path.join(freshHome, ".muninn"))).toBe(false);
    } finally {
      fs.rmSync(freshHome, { recursive: true, force: true });
    }
  });

  it("rejects --home without a path value", async () => {
    await handleSetupCommand({ "--home": true });
    expect(process.exitCode).toBe(1);
    expect(loggedText()).toContain("--home requires a path value");
    expect(loggedText()).toContain("Usage:");
  });

  it("routes setup through the CLI and documents the command and flags", async () => {
    expect(usage()).toContain("muninn setup");
    expect(printSetupUsage).toBeTypeOf("function");

    const parsed = parseArgs(["setup", "--status", "--home", home, "--force"]);
    expect(parsed._command).toBe("setup");
    expect(parsed["--status"]).toBe(true);
    expect(parsed["--home"]).toBe(home);
    expect(parsed["--force"]).toBe(true);

    await main(["setup", "--home", home]);
    expect(fs.existsSync(paths.configPath)).toBe(true);
    expect(readConfig(paths.configPath).mcpServers.muninn).toEqual(canonical);
    expect(loggedText()).toContain("Outcome: written");
  });

  it("prints legacy diagnostics in both status and install reports", async () => {
    fs.mkdirSync(path.dirname(paths.legacyPath), { recursive: true });
    const legacyBytes = '{"mcpServers":{"muninn":{"command":"legacy"}}}\n';
    fs.writeFileSync(paths.legacyPath, legacyBytes);

    await handleSetupCommand({ "--home": home, "--status": true });
    expect(loggedText()).toContain(`Legacy:  ${paths.legacyPath} (not modified)`);
    expect(loggedText()).toContain("State:   legacy");

    logSpy.mockClear();
    await handleSetupCommand({ "--home": home });
    expect(loggedText()).toContain(`Legacy:  ${paths.legacyPath} (not modified)`);
    expect(loggedText()).toContain("Outcome: written");
    expect(fs.readFileSync(paths.legacyPath, "utf8")).toBe(legacyBytes);
  });

  it("exposes the canonical entry without leaking shared mutable state", () => {
    const first = canonicalPortableEntry();
    first.args.push("--project" as never);
    expect(canonicalPortableEntry()).toEqual(canonical);
  });

  it("classifies non-object roots and unusable entries as malformed", () => {
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });

    for (const [raw, cause] of [
      ["[]\n", "root must be an object"],
      ["null\n", "root must be an object"],
      [JSON.stringify({ mcpServers: { muninn: { command: 42, args: [] } } }), "string `command`"],
      [JSON.stringify({ mcpServers: { muninn: { command: "muninn", args: "mcp run" } } }), "string-array `args`"],
    ] as const) {
      fs.writeFileSync(paths.configPath, raw);
      const status = getPortableStatus({ homeDir: home });
      expect(status.state).toBe("malformed");
      expect(status.error).toContain(cause);
      expect(status.error).toContain(paths.configPath);
    }
  });

  it("treats a non-canonical but usable entry as a conflict and preserves extra entry keys", () => {
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    fs.writeFileSync(
      paths.configPath,
      JSON.stringify({
        mcpServers: {
          muninn: { command: "muninn", args: ["mcp", "run"], env: { KEEP: "1" } },
        },
      }),
    );

    const status = getPortableStatus({ homeDir: home });
    expect(status.state).toBe("conflict");

    const skipped = setupPortable({ homeDir: home });
    expect(skipped.outcome).toBe("skipped");
    expect(readConfig(paths.configPath).mcpServers.muninn.env).toEqual({ KEEP: "1" });
  });

  it("reports a directory at the config path as malformed and never writes into it", () => {
    fs.mkdirSync(paths.configPath, { recursive: true });

    const status = getPortableStatus({ homeDir: home });
    expect(status.state).toBe("malformed");
    expect(status.error).toContain("not a regular file");

    const report = setupPortable({ homeDir: home, force: true });
    expect(report.outcome).toBe("failed");
    expect(report.changed).toBe(false);
    expect(fs.statSync(paths.configPath).isDirectory()).toBe(true);
  });

  it("refuses to proceed when the legacy path is a symlink and leaves its target untouched", () => {
    fs.mkdirSync(path.dirname(paths.legacyPath), { recursive: true });
    const target = path.join(home, "legacy-target.json");
    const targetBytes = '{"mcpServers":{}}\n';
    fs.writeFileSync(target, targetBytes);
    fs.symlinkSync(target, paths.legacyPath);

    const report = setupPortable({ homeDir: home });
    expect(report.outcome).toBe("failed");
    expect(report.error?.toLowerCase()).toContain("symlink");
    expect(fs.existsSync(paths.configPath)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(targetBytes);
  });

  it("reports a write failure, leaves no temporary file behind, and exits 1 through the command", async () => {
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("rename denied");
    });
    let report: ReturnType<typeof setupPortable>;
    try {
      report = setupPortable({ homeDir: home });
    } finally {
      renameSpy.mockRestore();
    }

    expect(report!.outcome).toBe("failed");
    expect(report!.changed).toBe(false);
    expect(report!.error).toContain("Cannot write portable MCP configuration");
    expect(report!.error).toContain("rename denied");
    const leftovers = fs
      .readdirSync(path.dirname(paths.configPath))
      .filter((entry) => entry.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(fs.existsSync(paths.configPath)).toBe(false);

    const commandSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("rename denied");
    });
    try {
      await handleSetupCommand({ "--home": home });
    } finally {
      commandSpy.mockRestore();
    }
    expect(process.exitCode).toBe(1);
    expect(loggedText()).toContain("Outcome: failed");
  });

  it("prints setup usage for --help/-h without touching the filesystem", async () => {
    await handleSetupCommand({ "--home": home, "--help": true });
    expect(loggedText()).toContain("muninn setup");
    expect(loggedText()).toContain("Usage:");
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(path.join(home, ".muninn"))).toBe(false);

    logSpy.mockClear();
    await handleSetupCommand({ "--home": home, "-h": true });
    expect(loggedText()).toContain("Usage:");
    expect(fs.existsSync(path.join(home, ".muninn"))).toBe(false);
  });

  it("rejects a non-string --agent value with usage and exit 1", async () => {
    await handleSetupCommand({ "--home": home, "--agent": true });
    expect(process.exitCode).toBe(1);
    expect(loggedText()).toContain("--agent requires an agent ID");
    expect(loggedText()).toContain("Usage:");
    expect(fs.existsSync(path.join(home, ".muninn"))).toBe(false);
  });

  it("allows --no-portable when --agent is supplied and performs no portable write", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-setup-project-"));
    try {
      await handleSetupCommand({
        "--home": home,
        "--project": project,
        "--no-portable": true,
        "--agent": "claude",
      });
      expect(process.exitCode).toBe(0);
      expect(fs.existsSync(path.join(home, ".muninn"))).toBe(false);
      expect(fs.existsSync(path.join(project, ".mcp.json"))).toBe(true);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("reports the intended portable action through --dry-run without writing", async () => {
    await handleSetupCommand({ "--home": home, "--dry-run": true });
    expect(process.exitCode).toBe(0);
    expect(loggedText()).toContain("Outcome: written");
    expect(loggedText()).toContain("Changed: true");
    expect(loggedText()).toContain("Dry run: no files were written");
    expect(fs.existsSync(path.join(home, ".muninn"))).toBe(false);
  });

  it("prints conflict status without failing and exits 1 for malformed installs", async () => {
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    fs.writeFileSync(
      paths.configPath,
      JSON.stringify({ mcpServers: { muninn: { command: "other", args: [] } } }),
    );

    await handleSetupCommand({ "--home": home, "--status": true });
    expect(process.exitCode).toBe(0);
    expect(loggedText()).toContain("State:   conflict");
    expect(loggedText()).toContain("Changed: false");

    fs.writeFileSync(paths.configPath, "{ broken");
    logSpy.mockClear();
    errorSpy.mockClear();
    await handleSetupCommand({ "--home": home });
    expect(process.exitCode).toBe(1);
    expect(loggedText()).toContain("Outcome: failed");
    expect(loggedText()).toContain(paths.configPath);
  });

  it("rejects unknown CLI commands with usage and exit 1", async () => {
    await main(["frobnicate"]);
    expect(process.exitCode).toBe(1);
    expect(loggedText()).toContain("Unknown command: frobnicate");
    expect(loggedText()).toContain("Usage:");
  });
});


describe("JSON agent catalog and setup (Iteration 2)", () => {
  let home: string;
  let project: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-setup2-home-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-setup2-project-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  function loggedText(): string {
    return [
      ...logSpy.mock.calls.map((call: unknown[]) => call.join(" ")),
      ...errorSpy.mock.calls.map((call: unknown[]) => call.join(" ")),
    ].join("\n");
  }

  function readJson(filePath: string): any {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  it("defines exactly the 13 reference destinations with routes, formats, and rules files", () => {
    expect(AGENT_IDS).toEqual([
      "cursor",
      "claude",
      "opencode",
      "devin",
      "qwen",
      "codex",
      "agy",
      "kimi",
      "pi",
      "commandcode",
      "omp",
      "mcode",
      "mimo",
    ]);
    expect(new Set(AGENT_IDS).size).toBe(13);
    expect(AGENT_REGISTRY.opencode).toMatchObject({
      label: "OpenCode",
      format: "opencode",
      mcpPaths: ["{opencodeConfigDir}/opencode.json"],
      rulesFile: "AGENTS.md",
    });
    expect(AGENT_REGISTRY.claude.mcpPaths).toEqual([
      "{project}/.mcp.json",
      "{home}/.claude.json",
      "{home}/.claude/claude_desktop_config.json",
    ]);
    expect(AGENT_REGISTRY.cursor.rulesFile).toBe(".cursorrules");
    expect(AGENT_REGISTRY.codex.format).toBe("toml");
    expect(AGENT_REGISTRY.mimo.format).toBe("opencode");
  });

  it("matches the reference catalog entry-for-entry", () => {
    const expected = {
      cursor: {
        label: "Cursor",
        format: "mcpServers",
        mcpPaths: ["{project}/.cursor/mcp.json", "{home}/.cursor/mcp.json"],
        rulesFile: ".cursorrules",
      },
      claude: {
        label: "Claude Code / Desktop",
        format: "mcpServers",
        mcpPaths: [
          "{project}/.mcp.json",
          "{home}/.claude.json",
          "{home}/.claude/claude_desktop_config.json",
        ],
        rulesFile: "CLAUDE.md",
      },
      opencode: {
        label: "OpenCode",
        format: "opencode",
        mcpPaths: ["{opencodeConfigDir}/opencode.json"],
        rulesFile: "AGENTS.md",
      },
      devin: {
        label: "Devin",
        format: "mcpServers",
        mcpPaths: ["{project}/.devin/mcp_config.json", "{home}/.config/devin/mcp_config.json"],
        rulesFile: ".windsurf/rules/muninn.md",
      },
      qwen: {
        label: "Qwen Code",
        format: "mcpServers",
        mcpPaths: ["{home}/.qwen/settings.json"],
        rulesFile: "QWEN.md",
      },
      codex: {
        label: "OpenAI Codex CLI",
        format: "toml",
        mcpPaths: ["{home}/.codex/config.toml"],
        rulesFile: "AGENTS.md",
      },
      agy: {
        label: "Antigravity CLI (agy)",
        format: "mcpServers",
        mcpPaths: ["{home}/.gemini/config/mcp_config.json", "{project}/.agents/mcp_config.json"],
        rulesFile: "AGENTS.md",
      },
      kimi: {
        label: "Kimi Code CLI",
        format: "mcpServers",
        mcpPaths: ["{home}/.kimi-code/mcp.json", "{project}/.kimi/mcp.json"],
        rulesFile: "AGENTS.md",
      },
      pi: {
        label: "Pi coding agent",
        format: "mcpServers",
        mcpPaths: ["{home}/.pi/agent/mcp.json", "{project}/.pi/mcp.json"],
        rulesFile: "AGENTS.md",
      },
      commandcode: {
        label: "Command Code",
        format: "mcpServers",
        mcpPaths: ["{home}/.commandcode/mcp.json", "{project}/.mcp.json"],
        rulesFile: "AGENTS.md",
      },
      omp: {
        label: "Oh My Pi",
        format: "mcpServers",
        mcpPaths: ["{home}/.omp/mcp.json", "{project}/.omp/mcp.json"],
        rulesFile: "AGENTS.md",
      },
      mcode: {
        label: "MiniMax Code",
        format: "mcpServers",
        mcpPaths: ["{project}/.mcp.json"],
        rulesFile: "AGENTS.md",
      },
      mimo: {
        label: "MiMo Code",
        format: "opencode",
        mcpPaths: ["{home}/.config/mimocode/mimocode.json"],
        rulesFile: "AGENTS.md",
      },
    } as const;

    for (const id of AGENT_IDS) {
      expect(AGENT_REGISTRY[id]).toEqual({ id, ...expected[id] });
    }
  });

  it("expands all three markers with platform path APIs", () => {
    const opencodeDir = path.join(home, "xdg-opencode");
    expect(
      resolveMcpPaths("cursor", { projectPath: project, homeDir: home, opencodeConfigDir: opencodeDir }),
    ).toEqual([
      path.join(project, ".cursor", "mcp.json"),
      path.join(home, ".cursor", "mcp.json"),
    ]);
    expect(
      resolveMcpPaths("opencode", { homeDir: home, opencodeConfigDir: opencodeDir }),
    ).toEqual([path.join(opencodeDir, "opencode.json")]);
    expect(resolveRulesPath("claude", { projectPath: project })).toBe(
      path.join(project, "CLAUDE.md"),
    );
  });

  it("applies colon-separated MUNINN_AGENT_<ID>_MCP_PATH overrides without breaking drive letters", () => {
    const first = path.join(home, "one.json");
    const second = path.join(home, "two.json");
    const env = {
      MUNINN_AGENT_CURSOR_MCP_PATH: `${first}:${second}`,
    };
    expect(resolveMcpPaths("cursor", { homeDir: home, env })).toEqual([first, second]);

    expect(
      resolveMcpPaths("cursor", { homeDir: home, env: { MUNINN_AGENT_CURSOR_MCP_PATH: "C:\\a:D:\\b" } }),
    ).toEqual(["C:\\a", "D:\\b"]);

    expect(() =>
      resolveMcpPaths("cursor", { homeDir: home, env: { MUNINN_AGENT_CURSOR_MCP_PATH: ":" } }),
    ).toThrow(/no usable paths/);

    expect(
      resolveMcpPaths("cursor", {
        homeDir: home,
        env: { HUGINN_AGENT_CURSOR_MCP_PATH: first },
      }),
    ).toEqual([first]);
  });

  it("parses selections, expands all, deduplicates, and reports unknown IDs", () => {
    expect(parseAgentSelection("all")).toEqual({ ok: true, ids: AGENT_IDS });
    expect(parseAgentSelection("pi,cursor,cursor")).toEqual({ ok: true, ids: ["cursor", "pi"] });
    expect(parseAgentSelection("nope,cursor")).toEqual({
      ok: false,
      unknown: ["nope"],
      valid: AGENT_IDS,
    });
    expect(parseAgentSelection("all,nope")).toEqual({
      ok: false,
      unknown: ["nope"],
      valid: AGENT_IDS,
    });
    expect(parseAgentSelection("  ")).toMatchObject({ ok: false, unknown: ["<empty>"] });
  });

  it("writes standard mcpServers entries and pins only project-contained files", () => {
    const projectConfig = path.join(project, ".cursor", "mcp.json");
    const userConfig = path.join(home, ".cursor", "mcp.json");
    const target = AGENT_REGISTRY.cursor;

    const projectReport = setupJsonTarget({
      target,
      path: projectConfig,
      projectPath: project,
    });
    expect(projectReport.outcome).toBe("written");
    expect(readJson(projectConfig).mcpServers.muninn).toEqual({
      command: "muninn",
      args: ["mcp", "run", "--project", project],
    });

    const userReport = setupJsonTarget({ target, path: userConfig, projectPath: project });
    expect(userReport.outcome).toBe("written");
    expect(readJson(userConfig).mcpServers.muninn).toEqual(canonical);

    const before = fs.readFileSync(projectConfig);
    const beforeStat = fs.statSync(projectConfig);
    const again = setupJsonTarget({ target, path: projectConfig, projectPath: project });
    expect(again.outcome).toBe("present");
    expect(again.changed).toBe(false);
    expect(fs.readFileSync(projectConfig)).toEqual(before);
    expect(fs.statSync(projectConfig).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("writes OpenCode's local command-array entry under mcp", () => {
    const configPath = path.join(home, ".config", "opencode", "opencode.json");
    const report = setupJsonTarget({
      target: AGENT_REGISTRY.opencode,
      path: configPath,
      projectPath: project,
    });
    expect(report.outcome).toBe("written");
    expect(readJson(configPath).mcp.muninn).toEqual({
      type: "local",
      command: ["muninn", "mcp", "run"],
      enabled: true,
    });

    const projectConfig = path.join(project, "opencode.json");
    setupJsonTarget({ target: AGENT_REGISTRY.opencode, path: projectConfig, projectPath: project });
    expect(readJson(projectConfig).mcp.muninn.command).toEqual([
      "muninn",
      "mcp",
      "run",
      "--project",
      project,
    ]);
  });

  it("merges unrelated JSON, classifies legacy and conflict entries, and force-replaces them", () => {
    const configPath = path.join(project, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const raw = JSON.stringify(
      {
        customRoot: { keep: true },
        mcpServers: {
          other: { command: "other", args: [] },
          muninn: { command: "huginn", args: ["mcp", "run"] },
        },
      },
      null,
      2,
    ) + "\n";
    fs.writeFileSync(configPath, raw);
    const target = AGENT_REGISTRY.cursor;

    expect(getJsonTargetStatus({ target, path: configPath, projectPath: project }).state).toBe("legacy");
    const skipped = setupJsonTarget({ target, path: configPath, projectPath: project });
    expect(skipped.outcome).toBe("skipped");
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);

    const replaced = setupJsonTarget({ target, path: configPath, projectPath: project, force: true });
    expect(replaced.outcome).toBe("written");
    const config = readJson(configPath);
    expect(config.customRoot).toEqual({ keep: true });
    expect(config.mcpServers.other).toEqual({ command: "other", args: [] });
    expect(config.mcpServers.muninn.command).toBe("muninn");

    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { muninn: { command: "other", args: [] } } }),
    );
    expect(getJsonTargetStatus({ target, path: configPath, projectPath: project }).state).toBe("conflict");
  });

  it("reports malformed JSON and symlinks with the path and cause without writing", () => {
    const configPath = path.join(project, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{ broken");
    const target = AGENT_REGISTRY.cursor;

    const status = getJsonTargetStatus({ target, path: configPath, projectPath: project });
    expect(status.state).toBe("malformed");
    expect(status.error).toContain(configPath);
    expect(status.error?.toLowerCase()).toContain("malformed json");

    const report = setupJsonTarget({ target, path: configPath, projectPath: project });
    expect(report.outcome).toBe("failed");
    expect(fs.readFileSync(configPath, "utf8")).toBe("{ broken");

    const linkPath = path.join(project, ".cursor", "link.json");
    fs.symlinkSync(configPath, linkPath);
    const linked = setupJsonTarget({ target, path: linkPath, projectPath: project, force: true });
    expect(linked.outcome).toBe("failed");
    expect(linked.error?.toLowerCase()).toContain("symlink");
  });

  it("implements --list as a read-only catalog listing", async () => {
    const beforeHome = fs.readdirSync(home).sort();
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--list": true,
    });
    expect(process.exitCode).toBe(0);
    for (const id of AGENT_IDS) expect(loggedText()).toContain(id);
    expect(loggedText()).toContain("Rules:");
    expect(loggedText()).toContain(path.join(project, ".cursor", "mcp.json"));
    expect(fs.readdirSync(home).sort()).toEqual(beforeHome);
    expect(fs.readdirSync(project)).toEqual([]);
  });

  it("rejects --list combined with mutating or selection options", async () => {
    await handleSetupCommand({ "--home": home, "--list": true, "--agent": "cursor" });
    expect(process.exitCode).toBe(1);
    expect(loggedText()).toContain("--list cannot be combined");
    expect(fs.readdirSync(project)).toEqual([]);
  });

  it("rejects unknown agent IDs with the valid list and exit 1 without writing", async () => {
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "not-an-agent",
    });
    expect(process.exitCode).toBe(1);
    expect(loggedText()).toContain("Unknown agent ID");
    expect(loggedText()).toContain("cursor");
    expect(fs.readdirSync(project)).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("includes portable by default with selected agents and suppresses it with --no-portable", async () => {
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "cursor,pi",
    });
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(path.join(project, ".cursor", "mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".pi", "mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".muninn", "mcp.json"))).toBe(true);
    expect(loggedText()).toContain("Outcome: written");

    const secondHome = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-setup2-noport-"));
    try {
      await handleSetupCommand({
        "--home": secondHome,
        "--project": project,
        "--agent": "cursor",
        "--no-portable": true,
      });
      expect(process.exitCode).toBe(0);
      expect(fs.existsSync(path.join(secondHome, ".muninn"))).toBe(false);
    } finally {
      fs.rmSync(secondHome, { recursive: true, force: true });
    }
  });

  it("reports selected agent status plus portable, and excludes portable with --no-portable", async () => {
    setupJsonTarget({
      target: AGENT_REGISTRY.cursor,
      path: path.join(project, ".cursor", "mcp.json"),
      projectPath: project,
    });
    setupPortable({ homeDir: home });

    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--status": true,
      "--agent": "cursor",
    });
    expect(process.exitCode).toBe(0);
    expect(loggedText()).toContain("Cursor (cursor)");
    expect(loggedText()).toContain("State:   registered");
    expect(loggedText()).toContain("Portable MCP configuration");

    logSpy.mockClear();
    errorSpy.mockClear();
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--status": true,
      "--agent": "cursor",
      "--no-portable": true,
    });
    expect(loggedText()).toContain("Cursor (cursor)");
    expect(loggedText()).not.toContain("Portable MCP configuration");
  });

  it("reports every catalog agent plus portable for status without --agent", async () => {
    await handleSetupCommand({ "--home": home, "--project": project, "--status": true });
    expect(process.exitCode).toBe(0);
    const text = loggedText();
    for (const id of AGENT_IDS) expect(text).toContain(`(${id})`);
    expect(text).toContain("Portable MCP configuration");
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.readdirSync(project)).toEqual([]);
  });

  it("keeps --status and --dry-run read-only across agent files", async () => {
    const configPath = path.join(project, ".cursor", "mcp.json");
    setupJsonTarget({
      target: AGENT_REGISTRY.cursor,
      path: configPath,
      projectPath: project,
    });
    const beforeBytes = fs.readFileSync(configPath);
    const beforeStat = fs.statSync(configPath);
    const beforeEntries = fs.readdirSync(path.dirname(configPath)).sort();

    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--status": true,
      "--agent": "cursor",
      "--no-portable": true,
    });
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--dry-run": true,
      "--agent": "pi",
      "--no-portable": true,
    });

    expect(fs.readFileSync(configPath)).toEqual(beforeBytes);
    expect(fs.statSync(configPath).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual(beforeEntries);
    expect(fs.existsSync(path.join(project, ".pi"))).toBe(false);
  });

  it("installs Codex TOML instead of deferring it", async () => {
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "codex",
      "--no-portable": true,
    });
    expect(process.exitCode).toBe(0);
    const text = loggedText();
    expect(text).toContain("OpenAI Codex CLI (codex)");
    expect(text).toContain("Format:  toml");
    expect(text).toContain("Outcome: written");
    expect(text).toContain("Changed: true");

    const configPath = path.join(home, ".codex", "config.toml");
    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain("[mcp_servers.muninn]");
    expect(content).toContain('command = "muninn"');
    expect(content).toContain('args = ["mcp", "run"]');
    expect(content).not.toContain("--project");
  });

  it("returns per-destination reports identifying each file", async () => {
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "opencode",
      "--no-portable": true,
    });
    expect(process.exitCode).toBe(0);
    const text = loggedText();
    expect(text).toContain("OpenCode (opencode)");
    expect(text).toContain(path.join(home, ".config", "opencode", "opencode.json"));
    expect(text).toContain("Format:  opencode");
    expect(text).toContain("Outcome: written");
    expect(text).toContain("Changed: true");
  });


  it("resolves the OpenCode config directory from options, env aliases, and the home default", () => {
    const explicit = path.join(home, "explicit-opencode");
    const fromMuninn = path.join(home, "env-opencode");
    const fromHuginn = path.join(home, "legacy-opencode");

    expect(
      resolveMcpPaths("opencode", { homeDir: home, opencodeConfigDir: explicit }),
    ).toEqual([path.join(explicit, "opencode.json")]);
    expect(
      resolveMcpPaths("opencode", { homeDir: home, env: { MUNINN_OPENCODE_CONFIG_DIR: fromMuninn } }),
    ).toEqual([path.join(fromMuninn, "opencode.json")]);
    expect(
      resolveMcpPaths("opencode", { homeDir: home, env: { HUGINN_OPENCODE_CONFIG_DIR: fromHuginn } }),
    ).toEqual([path.join(fromHuginn, "opencode.json")]);
    expect(resolveMcpPaths("opencode", { homeDir: home, env: {} })).toEqual([
      path.join(home, ".config", "opencode", "opencode.json"),
    ]);
  });

  it("ignores empty override segments and falls back when an override is blank", () => {
    const first = path.join(home, "one.json");
    const second = path.join(home, "two.json");

    expect(
      resolveMcpPaths("cursor", {
        homeDir: home,
        env: { MUNINN_AGENT_CURSOR_MCP_PATH: ` ${first} :: ${second} ` },
      }),
    ).toEqual([first, second]);
    expect(
      resolveMcpPaths("cursor", {
        projectPath: project,
        homeDir: home,
        env: { MUNINN_AGENT_CURSOR_MCP_PATH: "   " },
      }),
    ).toEqual([
      path.join(project, ".cursor", "mcp.json"),
      path.join(home, ".cursor", "mcp.json"),
    ]);
    expect(
      resolveMcpPaths(AGENT_REGISTRY.cursor, {
        homeDir: home,
        env: { MUNINN_AGENT_CURSOR_MCP_PATH: first },
      }),
    ).toEqual([first]);
  });

  it("normalizes selections case-insensitively and deduplicates unknown IDs", () => {
    expect(parseAgentSelection(" CURSOR, ,pi ")).toEqual({
      ok: true,
      ids: ["cursor", "pi"],
    });
    expect(parseAgentSelection("all, cursor")).toEqual({ ok: true, ids: AGENT_IDS });
    expect(parseAgentSelection("nope,NOPE")).toEqual({
      ok: false,
      unknown: ["nope"],
      valid: AGENT_IDS,
    });
  });

  it("uses path.relative so project containment rejects prefixes, parents, and traversal", () => {
    expect(isProjectContained(project, project)).toBe(true);
    expect(isProjectContained(path.join(project, ".cursor", "mcp.json"), project)).toBe(true);
    expect(isProjectContained(`${project}-other`, project)).toBe(false);
    expect(isProjectContained(path.dirname(project), project)).toBe(false);
    expect(isProjectContained(path.join(project, "..", "escape.json"), project)).toBe(false);
  });

  it("does not pin --project for user-level or sibling paths", () => {
    const target = AGENT_REGISTRY.cursor;
    const sibling = `${project}-other`;

    expect(
      canonicalAgentEntry(target, path.join(sibling, ".cursor", "mcp.json"), project),
    ).toEqual(canonical);
    expect(
      canonicalAgentEntry(target, path.join(project, ".cursor", "mcp.json"), project),
    ).toEqual({ command: "muninn", args: ["mcp", "run", "--project", project] });
  });

  it("reports absent and malformed JSON roots, containers, and entries for both formats", () => {
    const cursorPath = path.join(project, ".cursor", "mcp.json");
    expect(
      getJsonTargetStatus({ target: AGENT_REGISTRY.cursor, path: cursorPath, projectPath: project })
        .state,
    ).toBe("absent");

    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    const standardCases: Array<[string, string]> = [
      ["[]\n", "root must be an object"],
      [JSON.stringify({ mcpServers: [] }), "`mcpServers` must be an object"],
      [JSON.stringify({ mcpServers: { muninn: "nope" } }), "`mcpServers.muninn` must be an object"],
      [
        JSON.stringify({ mcpServers: { muninn: { command: 42, args: [] } } }),
        "string `command`",
      ],
      [
        JSON.stringify({ mcpServers: { muninn: { command: "muninn", args: "mcp run" } } }),
        "string-array `args`",
      ],
    ];
    for (const [raw, cause] of standardCases) {
      fs.writeFileSync(cursorPath, raw);
      const status = getJsonTargetStatus({
        target: AGENT_REGISTRY.cursor,
        path: cursorPath,
        projectPath: project,
      });
      expect(status.state).toBe("malformed");
      expect(status.error).toContain(cause);
    }

    const opencodePath = path.join(home, "opencode-malformed.json");
    fs.writeFileSync(opencodePath, "null\n");
    expect(
      getJsonTargetStatus({
        target: AGENT_REGISTRY.opencode,
        path: opencodePath,
        projectPath: project,
      }).error,
    ).toContain("root must be an object");

    fs.writeFileSync(opencodePath, JSON.stringify({ mcp: [] }));
    expect(
      getJsonTargetStatus({
        target: AGENT_REGISTRY.opencode,
        path: opencodePath,
        projectPath: project,
      }).error,
    ).toContain("`mcp` must be an object");

    fs.writeFileSync(opencodePath, JSON.stringify({ mcp: { muninn: "nope" } }));
    expect(
      getJsonTargetStatus({
        target: AGENT_REGISTRY.opencode,
        path: opencodePath,
        projectPath: project,
      }).error,
    ).toContain("`mcp.muninn` must be an object");

    fs.writeFileSync(
      opencodePath,
      JSON.stringify({ mcp: { muninn: { type: "local", command: "muninn" } } }),
    );
    const malformedCommand = getJsonTargetStatus({
      target: AGENT_REGISTRY.opencode,
      path: opencodePath,
      projectPath: project,
    });
    expect(malformedCommand.state).toBe("malformed");
    expect(malformedCommand.error).toContain("`mcp.muninn.command` must be an array of strings");
  });

  it("classifies and force-replaces an OpenCode legacy huginn entry", () => {
    const configPath = path.join(home, ".config", "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const raw =
      JSON.stringify(
        {
          theme: "dark",
          mcp: {
            other: { type: "local", command: ["other"] },
            muninn: { type: "local", command: ["huginn", "mcp", "run"], enabled: true },
          },
        },
        null,
        2,
      ) + "\n";
    fs.writeFileSync(configPath, raw);
    const target = AGENT_REGISTRY.opencode;

    expect(getJsonTargetStatus({ target, path: configPath, projectPath: project }).state).toBe(
      "legacy",
    );
    const skipped = setupJsonTarget({ target, path: configPath, projectPath: project });
    expect(skipped.outcome).toBe("skipped");
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);

    const replaced = setupJsonTarget({
      target,
      path: configPath,
      projectPath: project,
      force: true,
    });
    expect(replaced.outcome).toBe("written");
    const config = readJson(configPath);
    expect(config.theme).toBe("dark");
    expect(config.mcp.other).toEqual({ type: "local", command: ["other"] });
    expect(config.mcp.muninn).toEqual({
      type: "local",
      command: ["muninn", "mcp", "run"],
      enabled: true,
    });
  });

  it("treats a directory at a JSON destination as malformed and never writes into it", () => {
    const configPath = path.join(project, ".cursor", "mcp.json");
    fs.mkdirSync(configPath, { recursive: true });
    const target = AGENT_REGISTRY.cursor;

    const status = getJsonTargetStatus({ target, path: configPath, projectPath: project });
    expect(status.state).toBe("malformed");
    expect(status.error).toContain("not a regular file");

    const report = setupJsonTarget({ target, path: configPath, projectPath: project, force: true });
    expect(report.outcome).toBe("failed");
    expect(report.changed).toBe(false);
    expect(fs.statSync(configPath).isDirectory()).toBe(true);
  });

  it("keeps JSON dry-run read-only for conflicting and absent destinations", () => {
    const configPath = path.join(project, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const original = JSON.stringify({
      mcpServers: { muninn: { command: "other", args: [] } },
    });
    fs.writeFileSync(configPath, original);
    const target = AGENT_REGISTRY.cursor;

    const report = setupJsonTarget({
      target,
      path: configPath,
      projectPath: project,
      force: true,
      dryRun: true,
    });
    expect(report).toMatchObject({
      state: "conflict",
      outcome: "written",
      changed: true,
      dryRun: true,
    });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);

    const absentPath = path.join(project, ".pi", "mcp.json");
    const absent = setupJsonTarget({
      target: AGENT_REGISTRY.pi,
      path: absentPath,
      projectPath: project,
      dryRun: true,
    });
    expect(absent.outcome).toBe("written");
    expect(fs.existsSync(path.join(project, ".pi"))).toBe(false);
  });

  it("reports an atomic JSON write failure without leaving a temporary file", () => {
    const configPath = path.join(project, ".cursor", "mcp.json");
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("rename denied");
    });
    let report: ReturnType<typeof setupJsonTarget>;
    try {
      report = setupJsonTarget({
        target: AGENT_REGISTRY.cursor,
        path: configPath,
        projectPath: project,
      });
    } finally {
      renameSpy.mockRestore();
    }

    expect(report!.outcome).toBe("failed");
    expect(report!.changed).toBe(false);
    expect(report!.error).toContain("Cannot write cursor MCP configuration");
    expect(report!.error).toContain("rename denied");
    expect(fs.existsSync(configPath)).toBe(false);
    const leftovers = fs
      .readdirSync(path.dirname(configPath))
      .filter((entry) => entry.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("sets exit 1 and continues status after malformed JSON to report every target", async () => {
    const cursorPath = path.join(project, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(cursorPath, "{ broken");

    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--status": true,
      "--agent": "cursor,pi",
    });
    expect(process.exitCode).toBe(1);
    const text = loggedText();
    expect(text).toContain("Cursor (cursor)");
    expect(text).toContain("Pi coding agent (pi)");
    expect(text).toContain(cursorPath);
    expect(text).toContain(path.join(home, ".pi", "agent", "mcp.json"));
    expect(text).toContain("State:   malformed");
    expect(text).toContain("State:   absent");
    expect(text).toContain("Portable MCP configuration");
    expect(fs.readFileSync(cursorPath, "utf8")).toBe("{ broken");
  });

  it("reports every file for a multi-path agent and fails status on one malformed file", async () => {
    const projectConfig = path.join(project, ".mcp.json");
    setupJsonTarget({
      target: AGENT_REGISTRY.claude,
      path: projectConfig,
      projectPath: project,
    });
    const desktopConfig = path.join(home, ".claude", "claude_desktop_config.json");
    fs.mkdirSync(path.dirname(desktopConfig), { recursive: true });
    fs.writeFileSync(desktopConfig, "{ broken");

    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--status": true,
      "--agent": "claude",
      "--no-portable": true,
    });

    expect(process.exitCode).toBe(1);
    const text = loggedText();
    expect(text).toContain(projectConfig);
    expect(text).toContain(path.join(home, ".claude.json"));
    expect(text).toContain(desktopConfig);
    expect(text).toContain("State:   registered");
    expect(text).toContain("State:   absent");
    expect(text).toContain("State:   malformed");
    expect(fs.readFileSync(desktopConfig, "utf8")).toBe("{ broken");
  });

  it("inspects Codex TOML status without writing or creating directories", async () => {
    const configPath = path.join(home, ".codex", "config.toml");
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--status": true,
      "--agent": "codex",
      "--no-portable": true,
    });
    expect(process.exitCode).toBe(0);
    let text = loggedText();
    expect(text).toContain("OpenAI Codex CLI (codex)");
    expect(text).toContain(configPath);
    expect(text).toContain("State:   absent");
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "[mcp_servers.muninn\n");
    logSpy.mockClear();
    errorSpy.mockClear();

    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--status": true,
      "--agent": "codex",
      "--no-portable": true,
    });
    expect(process.exitCode).toBe(1);
    text = loggedText();
    expect(text).toContain("State:   malformed");
    expect(text).toContain(configPath);
    expect(text.toLowerCase()).toContain("malformed toml");
    expect(fs.readFileSync(configPath, "utf8")).toBe("[mcp_servers.muninn\n");
  });

  it("stops normal setup at the first fatal JSON error but retains earlier writes", async () => {
    const projectConfig = path.join(project, ".cursor", "mcp.json");
    const homeConfig = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(homeConfig), { recursive: true });
    fs.writeFileSync(homeConfig, "{ broken");

    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "cursor",
      "--no-portable": true,
    });

    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(projectConfig)).toBe(true);
    expect(readJson(projectConfig).mcpServers.muninn).toEqual({
      command: "muninn",
      args: ["mcp", "run", "--project", project],
    });
    expect(fs.readFileSync(homeConfig, "utf8")).toBe("{ broken");
  });

  it("prints present and skipped outcomes per destination while preserving conflicting bytes", async () => {
    const cursorConfig = path.join(project, ".cursor", "mcp.json");
    setupJsonTarget({
      target: AGENT_REGISTRY.cursor,
      path: cursorConfig,
      projectPath: project,
    });
    const piConfig = path.join(project, ".pi", "mcp.json");
    fs.mkdirSync(path.dirname(piConfig), { recursive: true });
    const conflictBytes = JSON.stringify({
      mcpServers: { muninn: { command: "other", args: [] } },
    });
    fs.writeFileSync(piConfig, conflictBytes);

    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "cursor,pi",
      "--no-portable": true,
    });

    expect(process.exitCode).toBe(0);
    const text = loggedText();
    expect(text).toContain("Cursor (cursor)");
    expect(text).toContain(cursorConfig);
    expect(text).toContain("Outcome: present");
    expect(text).toContain("Pi coding agent (pi)");
    expect(text).toContain(piConfig);
    expect(text).toContain("Outcome: skipped");
    expect(fs.readFileSync(piConfig, "utf8")).toBe(conflictBytes);
  });

  it("expands --agent all in dry-run without touching the home or project trees", async () => {
    const homeBefore = fs.readdirSync(home).sort();
    const projectBefore = fs.readdirSync(project).sort();

    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "all",
      "--dry-run": true,
    });

    expect(process.exitCode).toBe(0);
    const text = loggedText();
    for (const id of AGENT_IDS) expect(text).toContain(`(${id})`);
    expect(text).toContain("Dry run: no files were written");
    expect(fs.readdirSync(home).sort()).toEqual(homeBefore);
    expect(fs.readdirSync(project).sort()).toEqual(projectBefore);
  });

  it("parses --flag=value forms and routes version and help without side effects", async () => {
    const parsed = parseArgs(["--home=/tmp/muninn-home", "--agent=cursor,pi", "setup"]);
    expect(parsed["--home"]).toBe("/tmp/muninn-home");
    expect(parsed["--agent"]).toBe("cursor,pi");
    expect(parsed._command).toBe("setup");

    await main(["--version"]);
    expect(loggedText()).toContain(`muninn ${VERSION}`);

    logSpy.mockClear();
    await main(["-h"]);
    expect(loggedText()).toContain("Usage:");
    expect(fs.existsSync(path.join(home, ".muninn"))).toBe(false);
  });

  it("rejects --project without a path value before writing anything", async () => {
    await handleSetupCommand({ "--home": home, "--project": true, "--agent": "cursor" });
    expect(process.exitCode).toBe(1);
    expect(loggedText()).toContain("--project requires a path value");
    expect(loggedText()).toContain("Usage:");
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("uses canonicalAgentEntry without sharing mutable state", () => {
    const first = canonicalAgentEntry(AGENT_REGISTRY.opencode, path.join(project, "opencode.json"), project);
    (first.command as string[]).push("--project");
    expect(canonicalAgentEntry(AGENT_REGISTRY.opencode, path.join(project, "opencode.json"), project)).toEqual({
      type: "local",
      command: ["muninn", "mcp", "run", "--project", project],
      enabled: true,
    });
  });
});

describe("Codex TOML setup (Iteration 3)", () => {
  let home: string;
  let project: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-setup3-home-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-setup3-project-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  function loggedText(): string {
    return [
      ...logSpy.mock.calls.map((call: unknown[]) => call.join(" ")),
      ...errorSpy.mock.calls.map((call: unknown[]) => call.join(" ")),
    ].join("\n");
  }

  function codexPath(): string {
    return path.join(home, ".codex", "config.toml");
  }

  it("creates Codex TOML with the canonical entry and safe permissions", () => {
    const report = setupTomlTarget({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
      projectPath: project,
    });

    expect(report.outcome).toBe("written");
    expect(report.changed).toBe(true);
    expect(fs.statSync(path.dirname(codexPath())).mode & 0o777).toBe(0o700);
    expect(fs.statSync(codexPath()).mode & 0o777).toBe(0o600);
    const content = fs.readFileSync(codexPath(), "utf8");
    expect(content).toContain("[mcp_servers.muninn]");
    expect(content).toContain('command = "muninn"');
    expect(content).toContain('args = ["mcp", "run"]');
  });

  it("merges structurally, preserving unrelated tables, keys, and comments", () => {
    fs.mkdirSync(path.dirname(codexPath()), { recursive: true });
    const original =
      '# user configuration\n' +
      'model = "gpt-5"\n\n' +
      '[mcp_servers.otro]\n' +
      'command = "other"\n' +
      'args = ["serve"]\n';
    fs.writeFileSync(codexPath(), original);

    const report = setupTomlTarget({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
      projectPath: project,
    });
    expect(report.outcome).toBe("written");

    const content = fs.readFileSync(codexPath(), "utf8");
    expect(content).toContain("# user configuration");
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain("[mcp_servers.otro]");
    expect(content).toContain('command = "other"');
    expect(content).toContain('args = ["serve"]');
    expect(content).toContain("[mcp_servers.muninn]");
    expect(content).toContain('command = "muninn"');
    expect(content).toContain('args = ["mcp", "run"]');
  });

  it("pins --project only when the TOML file is inside the selected project", () => {
    const inProject = path.join(project, ".codex", "config.toml");
    const inside = setupTomlTarget({
      target: AGENT_REGISTRY.codex,
      path: inProject,
      projectPath: project,
    });
    expect(inside.outcome).toBe("written");
    const insideContent = fs.readFileSync(inProject, "utf8");
    expect(insideContent).toContain(
      `args = ["mcp", "run", "--project", ${JSON.stringify(project)}]`,
    );

    const outside = setupTomlTarget({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
      projectPath: project,
    });
    expect(outside.outcome).toBe("written");
    expect(fs.readFileSync(codexPath(), "utf8")).not.toContain("--project");
  });

  it("is byte-for-byte idempotent for a correct entry", () => {
    setupTomlTarget({ target: AGENT_REGISTRY.codex, path: codexPath() });
    const before = fs.readFileSync(codexPath());
    const beforeStat = fs.statSync(codexPath());

    const second = setupTomlTarget({ target: AGENT_REGISTRY.codex, path: codexPath() });
    expect(second.outcome).toBe("present");
    expect(second.changed).toBe(false);
    expect(fs.readFileSync(codexPath())).toEqual(before);
    expect(fs.statSync(codexPath()).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("treats an entry with extra keys as a conflict rather than canonical", () => {
    fs.mkdirSync(path.dirname(codexPath()), { recursive: true });
    const original =
      '[mcp_servers.muninn]\ncommand = "muninn"\nargs = ["mcp", "run"]\nenv = { MODE = "x" }\n';
    fs.writeFileSync(codexPath(), original);

    const status = getTomlTargetStatus({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
    });
    expect(status.state).toBe("conflict");

    const skipped = setupTomlTarget({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
    });
    expect(skipped.outcome).toBe("skipped");
    expect(fs.readFileSync(codexPath(), "utf8")).toBe(original);

    const replaced = setupTomlTarget({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
      force: true,
    });
    expect(replaced.outcome).toBe("written");
    const content = fs.readFileSync(codexPath(), "utf8");
    expect(content).toContain('command = "muninn"');
    expect(content).not.toContain("env =");
  });

  it("reports malformed TOML with path and cause without modifying the original", () => {
    fs.mkdirSync(path.dirname(codexPath()), { recursive: true });
    const original = "[mcp_servers.muninn\ncommand = \"muninn\"\n";
    fs.writeFileSync(codexPath(), original);

    const status = getTomlTargetStatus({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
    });
    expect(status.state).toBe("malformed");
    expect(status.error).toContain(codexPath());
    expect(status.error?.toLowerCase()).toContain("malformed toml");

    const report = setupTomlTarget({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
    });
    expect(report.outcome).toBe("failed");
    expect(report.changed).toBe(false);
    expect(fs.readFileSync(codexPath(), "utf8")).toBe(original);
  });

  it("skips a conflicting entry without --force and replaces it with --force", () => {
    fs.mkdirSync(path.dirname(codexPath()), { recursive: true });
    const original =
      '[mcp_servers.muninn]\ncommand = "huginn"\nargs = ["mcp", "run"]\n';
    fs.writeFileSync(codexPath(), original);

    const status = getTomlTargetStatus({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
    });
    expect(status.state).toBe("legacy");

    const skipped = setupTomlTarget({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
    });
    expect(skipped.outcome).toBe("skipped");
    expect(skipped.changed).toBe(false);
    expect(fs.readFileSync(codexPath(), "utf8")).toBe(original);

    const replaced = setupTomlTarget({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
      force: true,
    });
    expect(replaced.outcome).toBe("written");
    expect(replaced.changed).toBe(true);
    const content = fs.readFileSync(codexPath(), "utf8");
    expect(content).toContain('command = "muninn"');
    expect(content).not.toContain("huginn");
  });

  it("preserves existing file permissions on a changed write", () => {
    fs.mkdirSync(path.dirname(codexPath()), { recursive: true });
    fs.writeFileSync(codexPath(), '[mcp_servers.muninn]\ncommand = "old"\n', {
      mode: 0o640,
    });
    fs.chmodSync(codexPath(), 0o640);

    const report = setupTomlTarget({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
      force: true,
    });
    expect(report.outcome).toBe("written");
    expect(fs.statSync(codexPath()).mode & 0o777).toBe(0o640);
  });

  it("refuses a final-component symlink instead of following it", () => {
    fs.mkdirSync(path.dirname(codexPath()), { recursive: true });
    const targetPath = path.join(home, "outside.toml");
    fs.writeFileSync(targetPath, "keep\n");
    fs.symlinkSync(targetPath, codexPath());

    const status = getTomlTargetStatus({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
    });
    expect(status.state).toBe("malformed");
    expect(status.error?.toLowerCase()).toContain("symlink");

    const report = setupTomlTarget({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
    });
    expect(report.outcome).toBe("failed");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("keep\n");
  });

  it("keeps status and dry-run read-only for TOML destinations", () => {
    const status = getTomlTargetStatus({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
    });
    expect(status.state).toBe("absent");
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);

    const dryRun = setupTomlTarget({
      target: AGENT_REGISTRY.codex,
      path: codexPath(),
      dryRun: true,
    });
    expect(dryRun.outcome).toBe("written");
    expect(dryRun.changed).toBe(true);
    expect(dryRun.dryRun).toBe(true);
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
  });

  it("aggregates malformed Codex TOML with other destinations and portable status", async () => {
    const cursorPath = path.join(project, ".cursor", "mcp.json");
    setupJsonTarget({
      target: AGENT_REGISTRY.cursor,
      path: cursorPath,
      projectPath: project,
    });
    fs.mkdirSync(path.dirname(codexPath()), { recursive: true });
    fs.writeFileSync(codexPath(), "[mcp_servers.muninn\n");

    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--status": true,
      "--agent": "codex,cursor",
    });

    expect(process.exitCode).toBe(1);
    const text = loggedText();
    expect(text).toContain("OpenAI Codex CLI (codex)");
    expect(text).toContain("State:   malformed");
    expect(text).toContain("Cursor (cursor)");
    expect(text).toContain("State:   registered");
    expect(text).toContain("Portable MCP configuration");
    expect(text).toContain("State:   absent");
    expect(fs.readFileSync(codexPath(), "utf8")).toBe("[mcp_servers.muninn\n");
  });

  it("writes through the CLI and preserves unrelated TOML", async () => {
    fs.mkdirSync(path.dirname(codexPath()), { recursive: true });
    fs.writeFileSync(codexPath(), '[mcp_servers.other]\ncommand = "other"\n');

    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "codex",
      "--no-portable": true,
    });
    expect(process.exitCode).toBe(0);
    expect(loggedText()).toContain("Outcome: written");
    const content = fs.readFileSync(codexPath(), "utf8");
    expect(content).toContain("[mcp_servers.other]");
    expect(content).toContain('command = "other"');
    expect(content).toContain("[mcp_servers.muninn]");
    expect(content).toContain('args = ["mcp", "run"]');
  });

  it("reports a malformed TOML install as failed and exits 1 without writing", async () => {
    fs.mkdirSync(path.dirname(codexPath()), { recursive: true });
    fs.writeFileSync(codexPath(), 'model = "a"\nmodel = "b"\n');

    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "codex",
      "--no-portable": true,
    });

    expect(process.exitCode).toBe(1);
    const text = loggedText();
    expect(text).toContain("OpenAI Codex CLI (codex)");
    expect(text).toContain("Outcome: failed");
    expect(text.toLowerCase()).toContain("malformed toml");
    expect(fs.readFileSync(codexPath(), "utf8")).toBe('model = "a"\nmodel = "b"\n');
  });

  it("fails status and install when an agent path override resolves to no paths", async () => {
    const previous = process.env.MUNINN_AGENT_CODEX_MCP_PATH;
    process.env.MUNINN_AGENT_CODEX_MCP_PATH = ":";
    try {
      await handleSetupCommand({
        "--home": home,
        "--project": project,
        "--status": true,
        "--agent": "codex",
        "--no-portable": true,
      });
      expect(process.exitCode).toBe(1);
      expect(loggedText()).toContain("contains no usable paths");

      process.exitCode = 0;
      logSpy.mockClear();
      errorSpy.mockClear();

      await handleSetupCommand({
        "--home": home,
        "--project": project,
        "--agent": "codex",
        "--no-portable": true,
      });
      expect(process.exitCode).toBe(1);
      expect(loggedText()).toContain("contains no usable paths");
      expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.MUNINN_AGENT_CODEX_MCP_PATH;
      else process.env.MUNINN_AGENT_CODEX_MCP_PATH = previous;
    }
  });
});

describe("marked agent rules setup (Iteration 4)", () => {
  let home: string;
  let project: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-setup4-home-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-setup4-project-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  function loggedText(): string {
    return [
      ...logSpy.mock.calls.map((call: unknown[]) => call.join(" ")),
      ...errorSpy.mock.calls.map((call: unknown[]) => call.join(" ")),
    ].join("\n");
  }

  function occurrences(raw: string, marker: string): number {
    return raw.split(marker).length - 1;
  }

  function rulesPathFor(id: string): string {
    return path.join(project, AGENT_REGISTRY[id as keyof typeof AGENT_REGISTRY].rulesFile);
  }

  it("installs a marked block by default for selected agents and remains idempotent", async () => {
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "cursor,pi",
      "--no-portable": true,
    });

    expect(process.exitCode).toBe(0);
    for (const rulesPath of [rulesPathFor("cursor"), rulesPathFor("pi")]) {
      const content = fs.readFileSync(rulesPath, "utf8");
      expect(content).toContain(MUNINN_RULES_START);
      expect(content).toContain(MUNINN_RULES_END);
      expect(content).toContain("muninn_bootstrap");
      expect(content).toContain("muninn_search");
      expect(content).toContain("muninn_inspect_symbol");
      expect(content).toContain("muninn_verify_contract");
      expect(content).not.toMatch(/huginn/i);
      expect(occurrences(content, MUNINN_RULES_START)).toBe(1);
    }

    const before = fs.readFileSync(rulesPathFor("cursor"));
    const beforeStat = fs.statSync(rulesPathFor("cursor"));
    logSpy.mockClear();
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "cursor",
      "--no-portable": true,
    });
    expect(process.exitCode).toBe(0);
    expect(loggedText()).toContain("Outcome: present");
    expect(loggedText()).toContain("Changed: false");
    expect(fs.readFileSync(rulesPathFor("cursor"))).toEqual(before);
    expect(fs.statSync(rulesPathFor("cursor")).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("appends to existing rules, preserves surrounding content and permissions, and replaces only its own block", () => {
    const rulesPath = rulesPathFor("cursor");
    const original = "# Project rules\n\nKeep this line.\n";
    fs.writeFileSync(rulesPath, original, { mode: 0o640 });
    fs.chmodSync(rulesPath, 0o640);

    const first = setupRulesTarget({ path: rulesPath, agents: ["cursor"], projectPath: project });
    expect(first.outcome).toBe("written");
    const appended = fs.readFileSync(rulesPath, "utf8");
    expect(appended.startsWith(original)).toBe(true);
    expect(appended).toContain(MUNINN_RULES_START);
    expect(fs.statSync(rulesPath).mode & 0o777).toBe(0o640);

    const edited = appended.replace(
      `${MUNINN_RULES_START}\n## Muninn project memory`,
      `${MUNINN_RULES_START}\nold managed text`,
    );
    fs.writeFileSync(rulesPath, edited);
    const replaced = setupRulesTarget({ path: rulesPath, agents: ["cursor"], projectPath: project });
    expect(replaced.outcome).toBe("written");
    const next = fs.readFileSync(rulesPath, "utf8");
    expect(next.startsWith(original)).toBe(true);
    expect(next).not.toContain("old managed text");
    expect(occurrences(next, MUNINN_RULES_START)).toBe(1);
  });

  it("deduplicates a shared rules file for multiple selected agents", async () => {
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "opencode,codex",
      "--no-portable": true,
    });

    expect(process.exitCode).toBe(0);
    const shared = path.join(project, "AGENTS.md");
    const content = fs.readFileSync(shared, "utf8");
    expect(occurrences(content, MUNINN_RULES_START)).toBe(1);
    expect(loggedText()).toContain(`Muninn rules (opencode, codex)`);
    expect(loggedText()).toContain(shared);
  });

  it("reports a legacy block as stale, preserves it without --force, and replaces it with --force", () => {
    const rulesPath = path.join(project, "AGENTS.md");
    const original =
      "before\n" +
      `${LEGACY_RULES_START}\nold huginn rules\n${LEGACY_RULES_END}\n` +
      "after\n";
    fs.writeFileSync(rulesPath, original);

    const staleStatus = getRulesTargetStatus({ path: rulesPath, agents: ["pi"], projectPath: project });
    expect(staleStatus.state).toBe("stale");

    const stale = setupRulesTarget({ path: rulesPath, agents: ["pi"], projectPath: project });
    expect(stale.outcome).toBe("stale");
    expect(stale.changed).toBe(false);
    expect(fs.readFileSync(rulesPath, "utf8")).toBe(original);

    const forced = setupRulesTarget({
      path: rulesPath,
      agents: ["pi"],
      projectPath: project,
      force: true,
    });
    expect(forced.outcome).toBe("written");
    const next = fs.readFileSync(rulesPath, "utf8");
    expect(next).toContain("before\n");
    expect(next).toContain("after\n");
    expect(next).toContain(MUNINN_RULES_START);
    expect(next).not.toContain(LEGACY_RULES_START);
    expect(occurrences(next, MUNINN_RULES_START)).toBe(1);
  });

  it("treats unmatched, duplicate, and unterminated legacy markers as fatal without writing", () => {
    const rulesPath = path.join(project, ".cursorrules");
    const cases = [
      `${MUNINN_RULES_START}\nmissing end\n`,
      `${MUNINN_RULES_START}\none\n${MUNINN_RULES_END}\n${MUNINN_RULES_START}\ntwo\n${MUNINN_RULES_END}\n`,
      `${LEGACY_RULES_START}\nunterminated\n`,
    ];

    for (const raw of cases) {
      fs.writeFileSync(rulesPath, raw);
      const status = getRulesTargetStatus({ path: rulesPath, agents: ["cursor"], projectPath: project });
      expect(status.state).toBe("malformed");
      const report = setupRulesTarget({
        path: rulesPath,
        agents: ["cursor"],
        projectPath: project,
        force: true,
      });
      expect(report.outcome).toBe("failed");
      expect(fs.readFileSync(rulesPath, "utf8")).toBe(raw);
    }
  });

  it("refuses a symlinked rules file and leaves its target untouched", () => {
    const targetPath = path.join(project, "outside-rules.md");
    const targetBytes = "do not change\n";
    fs.writeFileSync(targetPath, targetBytes);
    const rulesPath = path.join(project, ".cursorrules");
    fs.symlinkSync(targetPath, rulesPath);

    const status = getRulesTargetStatus({ path: rulesPath, agents: ["cursor"], projectPath: project });
    expect(status.state).toBe("malformed");
    expect(status.error?.toLowerCase()).toContain("symlink");

    const report = setupRulesTarget({
      path: rulesPath,
      agents: ["cursor"],
      projectPath: project,
      force: true,
    });
    expect(report.outcome).toBe("failed");
    expect(fs.readFileSync(targetPath, "utf8")).toBe(targetBytes);
  });

  it("supports --no-rules and leaves rules untouched when no agent is selected", async () => {
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "cursor",
      "--no-portable": true,
      "--no-rules": true,
    });
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(path.join(project, ".cursor", "mcp.json"))).toBe(true);
    expect(fs.existsSync(rulesPathFor("cursor"))).toBe(false);

    const sentinel = path.join(project, "AGENTS.md");
    fs.writeFileSync(sentinel, "human rules only\n");
    await handleSetupCommand({ "--home": home, "--project": project });
    expect(fs.readFileSync(sentinel, "utf8")).toBe("human rules only\n");
    expect(loggedText()).not.toContain("Muninn rules (");
  });

  it("rejects --no-portable --no-rules without --agent with usage and exit 1", async () => {
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--no-portable": true,
      "--no-rules": true,
    });
    expect(process.exitCode).toBe(1);
    expect(loggedText()).toContain("--no-portable --no-rules requires --agent");
    expect(loggedText()).toContain("Usage:");
    expect(fs.readdirSync(project)).toEqual([]);
  });

  it("keeps rules status and dry-run read-only", async () => {
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "cursor",
      "--no-portable": true,
      "--status": true,
    });
    expect(process.exitCode).toBe(0);
    expect(loggedText()).toContain("Muninn rules (cursor)");
    expect(loggedText()).toContain("State:   absent");
    expect(fs.existsSync(rulesPathFor("cursor"))).toBe(false);

    logSpy.mockClear();
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "cursor",
      "--no-portable": true,
      "--dry-run": true,
    });
    expect(process.exitCode).toBe(0);
    expect(loggedText()).toContain("Muninn rules (cursor)");
    expect(loggedText()).toContain("Outcome: written");
    expect(loggedText()).toContain("Dry run: no files were written");
    expect(fs.existsSync(rulesPathFor("cursor"))).toBe(false);
  });

  it("stops at the first fatal rules error while retaining earlier MCP writes", async () => {
    fs.mkdirSync(rulesPathFor("cursor"), { recursive: true });

    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "cursor",
    });

    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(project, ".cursor", "mcp.json"))).toBe(true);
    expect(loggedText()).toContain("Muninn rules (cursor)");
    expect(loggedText()).toContain("Outcome: failed");
    expect(fs.existsSync(path.join(home, ".muninn", "mcp.json"))).toBe(false);
    expect(fs.statSync(rulesPathFor("cursor")).isDirectory()).toBe(true);
  });

  it("aggregates rules status errors and continues inspecting all selected rules", async () => {
    fs.mkdirSync(rulesPathFor("cursor"), { recursive: true });
    fs.writeFileSync(rulesPathFor("pi"), `${MUNINN_RULES_START}\nunmatched\n`);

    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "cursor,pi",
      "--no-portable": true,
      "--status": true,
    });

    expect(process.exitCode).toBe(1);
    const text = loggedText();
    expect(text).toContain("Muninn rules (cursor)");
    expect(text).toContain(rulesPathFor("cursor"));
    expect(text).toContain("Muninn rules (pi)");
    expect(text).toContain(rulesPathFor("pi"));
    expect(text).toContain("State:   malformed");
  });

  it("warns when a selected agent binary is not installed without changing the exit code", async () => {
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-empty-bin-"));
    const previousPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      await handleSetupCommand({
        "--home": home,
        "--project": project,
        "--agent": "cursor",
        "--no-portable": true,
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }

    expect(process.exitCode).toBe(0);
    expect(loggedText()).toContain("not installed");
    expect(fs.existsSync(path.join(project, ".cursor", "mcp.json"))).toBe(true);
    expect(fs.existsSync(rulesPathFor("cursor"))).toBe(true);
  });

  it("creates new rules files with restrictive permissions and reports write failures", () => {
    const report = setupRulesTarget({
      path: path.join(project, ".cursorrules"),
      agents: ["cursor"],
      projectPath: project,
    });
    expect(report.outcome).toBe("written");
    expect(fs.statSync(path.join(project, ".cursorrules")).mode & 0o777).toBe(0o600);

    const failedPath = path.join(project, "pi-rules", "AGENTS.md");
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("rename denied");
    });
    let failed: ReturnType<typeof setupRulesTarget>;
    try {
      failed = setupRulesTarget({ path: failedPath, agents: ["pi"], projectPath: project });
    } finally {
      renameSpy.mockRestore();
    }
    expect(failed!.outcome).toBe("failed");
    expect(failed!.error).toContain("rename denied");
    expect(fs.existsSync(failedPath)).toBe(false);
    const leftovers = fs
      .readdirSync(path.dirname(failedPath))
      .filter((entry) => entry.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

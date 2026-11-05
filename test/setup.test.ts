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

  it("reports Codex as deferred instead of silently installing TOML", async () => {
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--agent": "codex",
      "--no-portable": true,
    });
    expect(process.exitCode).toBe(0);
    expect(loggedText()).toContain("OpenAI Codex CLI (codex)");
    expect(loggedText()).toContain("Outcome: skipped");
    expect(loggedText()).toContain("iteration 3");
    expect(fs.existsSync(path.join(home, ".codex", "config.toml"))).toBe(false);
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

  it("reports Codex status as deferred without inspecting or writing TOML", async () => {
    await handleSetupCommand({
      "--home": home,
      "--project": project,
      "--status": true,
      "--agent": "codex",
      "--no-portable": true,
    });
    expect(process.exitCode).toBe(0);
    const text = loggedText();
    expect(text).toContain("OpenAI Codex CLI (codex)");
    expect(text).toContain(path.join(home, ".codex", "config.toml"));
    expect(text).toContain("iteration 3");
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
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

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
import { handleSetupCommand, printSetupUsage } from "../src/commands/setup.js";
import { main, parseArgs, usage } from "../src/cli.js";

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
    await handleSetupCommand({ "--home": home, "--no-portable": true, "--agent": "claude" });
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(path.join(home, ".muninn"))).toBe(false);
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

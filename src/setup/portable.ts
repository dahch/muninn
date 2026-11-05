/**
 * Portable MCP configuration setup.
 *
 * Iteration 1 of the setup feature owns exactly one destination:
 * `{home}/.muninn/mcp.json`, using the standard `mcpServers` container. The
 * portable entry never pins a project path; project-scoped destinations are
 * handled by later setup iterations.
 *
 * Everything here is deliberately dependency-free and uses the same path-safety
 * helper as the rest of Muninn. Reads and writes are per-file, writes are
 * atomic, and a no-op keeps the original bytes untouched.
 */
import fs from "node:fs";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { checkDocPath, lstatOrUndefined } from "../util/path-safety.js";

export type PortableState = "absent" | "registered" | "legacy" | "conflict" | "malformed";
export type PortableOutcome = "written" | "present" | "skipped" | "failed";

export interface PortableEntry {
  command: "muninn";
  args: ["mcp", "run"];
}

export interface PortableOptions {
  /** Selected home directory. `home` is accepted as an alias for callers. */
  homeDir?: string;
  home?: string;
  /** Replace a different existing `mcpServers.muninn` entry. */
  force?: boolean;
  /** Calculate the intended action without touching the filesystem. */
  dryRun?: boolean;
}

export interface PortablePaths {
  homeDir: string;
  configPath: string;
  legacyPath: string;
}

export interface PortableStatus {
  path: string;
  legacyPath: string;
  state: PortableState;
  legacyPresent: boolean;
  changed: false;
  error?: string;
  errors: string[];
}

export interface PortableReport {
  path: string;
  legacyPath: string;
  state: PortableState;
  outcome: PortableOutcome;
  changed: boolean;
  legacyPresent: boolean;
  dryRun: boolean;
  error?: string;
  errors: string[];
}

interface InspectedPortable {
  paths: PortablePaths;
  state: PortableState;
  legacyPresent: boolean;
  raw?: string;
  data?: Record<string, unknown>;
  error?: string;
  errors: string[];
}

export function canonicalPortableEntry(): PortableEntry {
  return { command: "muninn", args: ["mcp", "run"] };
}

export function resolvePortablePaths(homeDir?: string): PortablePaths {
  const selectedHome = resolve(homeDir ?? os.homedir());
  return {
    homeDir: selectedHome,
    configPath: join(selectedHome, ".muninn", "mcp.json"),
    legacyPath: join(selectedHome, ".huginn", "mcp.json"),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * A syntactically usable Muninn entry. It may still differ from the canonical
 * command line; that is classified as a conflict, not malformed input.
 */
function isUsableEntry(entry: Record<string, unknown>): boolean {
  if (hasOwn(entry, "command") && typeof entry.command !== "string") return false;
  if (hasOwn(entry, "args") && !isStringArray(entry.args)) return false;
  return true;
}

function isCanonicalEntry(entry: unknown): entry is PortableEntry {
  if (!isPlainObject(entry)) return false;
  const keys = Object.keys(entry).sort();
  if (keys.length !== 2 || keys[0] !== "args" || keys[1] !== "command") return false;
  return (
    entry.command === "muninn" &&
    Array.isArray(entry.args) &&
    entry.args.length === 2 &&
    entry.args[0] === "mcp" &&
    entry.args[1] === "run"
  );
}

function classifyRoot(data: unknown): { state: PortableState; error?: string } {
  if (!isPlainObject(data)) {
    return { state: "malformed", error: "JSON root must be an object" };
  }

  if (!hasOwn(data, "mcpServers")) return { state: "absent" };

  const servers = data.mcpServers;
  if (!isPlainObject(servers)) {
    return { state: "malformed", error: "`mcpServers` must be an object" };
  }

  if (!hasOwn(servers, "muninn")) return { state: "absent" };

  const entry = servers.muninn;
  if (!isPlainObject(entry)) {
    return { state: "malformed", error: "`mcpServers.muninn` must be an object" };
  }
  if (!isUsableEntry(entry)) {
    return {
      state: "malformed",
      error: "`mcpServers.muninn` must use a string `command` and a string-array `args`",
    };
  }
  return { state: isCanonicalEntry(entry) ? "registered" : "conflict" };
}

function inspectPortable(options: PortableOptions = {}): InspectedPortable {
  const paths = resolvePortablePaths(options.homeDir ?? options.home);
  const errors: string[] = [];

  const configCheck = checkDocPath(paths.configPath, {
    label: "portable MCP configuration",
    action: "read or write",
  });
  if (!configCheck.ok) {
    return {
      paths,
      state: "malformed",
      legacyPresent: false,
      error: configCheck.reason,
      errors: [configCheck.reason],
    };
  }

  let legacyPresent = false;
  const legacyCheck = checkDocPath(paths.legacyPath, {
    label: "legacy MCP configuration",
    action: "read",
  });
  if (legacyCheck.ok) {
    legacyPresent = lstatOrUndefined(legacyCheck.path) !== undefined;
  } else {
    errors.push(legacyCheck.reason);
  }

  const configStat = lstatOrUndefined(configCheck.path);
  if (configStat === undefined) {
    return {
      paths,
      state: legacyPresent ? "legacy" : "absent",
      legacyPresent,
      errors,
    };
  }
  if (!configStat.isFile()) {
    const error = `Portable MCP configuration ${paths.configPath} is not a regular file`;
    return {
      paths,
      state: "malformed",
      legacyPresent,
      error,
      errors: [...errors, error],
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configCheck.path, "utf8");
  } catch (err) {
    const error = `Cannot read portable MCP configuration ${paths.configPath}: ${
      (err as Error).message
    }`;
    return {
      paths,
      state: "malformed",
      legacyPresent,
      error,
      errors: [...errors, error],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const error = `Malformed JSON in ${paths.configPath}: ${(err as Error).message}`;
    return {
      paths,
      state: "malformed",
      legacyPresent,
      raw,
      error,
      errors: [...errors, error],
    };
  }

  const classified = classifyRoot(parsed);
  if (classified.state === "malformed") {
    const error = `Malformed portable MCP configuration ${paths.configPath}: ${classified.error}`;
    return {
      paths,
      state: "malformed",
      legacyPresent,
      raw,
      error,
      errors: [...errors, error],
    };
  }

  const state =
    classified.state === "absent" && legacyPresent ? "legacy" : classified.state;

  return {
    paths,
    state,
    legacyPresent,
    raw,
    data: parsed as Record<string, unknown>,
    errors,
  };
}

/** Read-only diagnostic used by `muninn setup --status`. */
export function getPortableStatus(options: PortableOptions = {}): PortableStatus {
  const inspected = inspectPortable(options);
  return {
    path: inspected.paths.configPath,
    legacyPath: inspected.paths.legacyPath,
    state: inspected.state,
    legacyPresent: inspected.legacyPresent,
    changed: false,
    error: inspected.error,
    errors: inspected.errors,
  };
}

export function indentFrom(raw: string | undefined): string {
  if (!raw) return "  ";
  const match = raw.match(/\n([ \t]+)"/);
  return match?.[1] ?? "  ";
}

export function renderConfig(data: Record<string, unknown>, raw: string | undefined): string {
  const body = JSON.stringify(data, null, indentFrom(raw));
  if (raw === undefined) return `${body}\n`;
  // Preserve the original trailing-newline convention when updating a file.
  return raw.endsWith("\n") ? `${body}\n` : body;
}

function buildUpdatedConfig(data: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...data };
  const currentServers = isPlainObject(data.mcpServers) ? data.mcpServers : {};
  next.mcpServers = {
    ...currentServers,
    muninn: canonicalPortableEntry(),
  };
  return next;
}

export function safeWriteAtomic(targetPath: string, content: string, mode: number): void {
  const directory = dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const temporaryPath = join(
    directory,
    `.${basename(targetPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );

  let fd: number | undefined;
  try {
    fd = fs.openSync(temporaryPath, "wx", mode);
    fs.writeFileSync(fd, content, "utf8");
    // `openSync` honours umask on some platforms; make the intended mode explicit.
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, targetPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore cleanup failure
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // temporary file may not have been created
    }
    throw err;
  }
}

/**
 * Apply (or, with `dryRun`, only plan) the portable configuration update.
 *
 * Returns a structured report. Malformed input and protected paths are reported
 * as `failed` with `error` set; callers turn that into exit code 1. A conflicting
 * entry without `--force` is a nonfatal `skipped`.
 */
export function setupPortable(options: PortableOptions = {}): PortableReport {
  const inspected = inspectPortable(options);
  const dryRun = options.dryRun === true;
  const base = {
    path: inspected.paths.configPath,
    legacyPath: inspected.paths.legacyPath,
    state: inspected.state,
    legacyPresent: inspected.legacyPresent,
    dryRun,
    errors: inspected.errors,
  };

  if (inspected.state === "malformed") {
    return {
      ...base,
      outcome: "failed",
      changed: false,
      error: inspected.error,
    };
  }

  // A protected legacy path is still a fatal setup error even though normal
  // setup never modifies the legacy file.
  if (inspected.errors.length > 0) {
    return {
      ...base,
      outcome: "failed",
      changed: false,
      error: inspected.errors[0],
    };
  }

  if (inspected.state === "registered") {
    return {
      ...base,
      outcome: "present",
      changed: false,
    };
  }

  if (inspected.state === "conflict" && options.force !== true) {
    return {
      ...base,
      outcome: "skipped",
      changed: false,
    };
  }

  const updated = buildUpdatedConfig(inspected.data ?? {});
  const content = renderConfig(updated, inspected.raw);

  if (dryRun) {
    return {
      ...base,
      outcome: "written",
      changed: true,
    };
  }

  const configCheck = checkDocPath(inspected.paths.configPath, {
    label: "portable MCP configuration",
    action: "write",
  });
  if (!configCheck.ok) {
    return {
      ...base,
      outcome: "failed",
      changed: false,
      error: configCheck.reason,
      errors: [...inspected.errors, configCheck.reason],
    };
  }

  // Re-check immediately before writing so a path swapped for a symlink between
  // inspection and the write is still refused.
  const existing = lstatOrUndefined(configCheck.path);
  if (existing?.isSymbolicLink()) {
    const error = `Portable MCP configuration ${inspected.paths.configPath} is a symlink; refusing to write through it`;
    return {
      ...base,
      outcome: "failed",
      changed: false,
      error,
      errors: [...inspected.errors, error],
    };
  }
  if (existing !== undefined && !existing.isFile()) {
    const error = `Portable MCP configuration ${inspected.paths.configPath} is not a regular file`;
    return {
      ...base,
      outcome: "failed",
      changed: false,
      error,
      errors: [...inspected.errors, error],
    };
  }

  const mode = existing === undefined ? 0o600 : existing.mode & 0o777;
  try {
    safeWriteAtomic(configCheck.path, content, mode);
  } catch (err) {
    const error = `Cannot write portable MCP configuration ${inspected.paths.configPath}: ${
      (err as Error).message
    }`;
    return {
      ...base,
      outcome: "failed",
      changed: false,
      error,
      errors: [...inspected.errors, error],
    };
  }

  return {
    ...base,
    outcome: "written",
    changed: true,
  };
}

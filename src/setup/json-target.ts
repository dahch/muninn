/**
 * Shared JSON MCP destination inspection and installation.
 *
 * Standard agents use the `mcpServers` container and OpenCode/MiMo use `mcp`
 * with a local-command entry. Both share the same atomic writer, path screen,
 * conflict rules, and byte-for-byte no-op behavior as the portable destination.
 */
import fs from "node:fs";
import { resolve } from "node:path";
import { checkDocPath, lstatOrUndefined } from "../util/path-safety.js";
import { renderConfig, safeWriteAtomic } from "./portable.js";
import {
  type AgentTarget,
  isProjectContained,
} from "./registry.js";

export type JsonMcpState = "absent" | "registered" | "legacy" | "conflict" | "malformed";
export type JsonMcpOutcome = "written" | "present" | "skipped" | "failed";

export interface JsonTargetOptions {
  target: AgentTarget;
  path: string;
  projectPath?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface JsonTargetStatus {
  target: AgentTarget;
  path: string;
  state: JsonMcpState;
  changed: false;
  error?: string;
  errors: string[];
}

export interface JsonTargetReport extends Omit<JsonTargetStatus, "changed"> {
  outcome: JsonMcpOutcome;
  changed: boolean;
  dryRun: boolean;
  warning?: string;
}

interface Inspection {
  target: AgentTarget;
  path: string;
  state: JsonMcpState;
  desired: Record<string, unknown>;
  raw?: string;
  data?: Record<string, unknown>;
  error?: string;
  errors: string[];
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

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key, index) => key === bKeys[index] && sameValue(a[key], b[key]))
    );
  }
  return false;
}

export function containerKeyFor(target: AgentTarget): "mcpServers" | "mcp" {
  return target.format === "opencode" ? "mcp" : "mcpServers";
}

/** Canonical entry for a target, pinned only for project-contained files. */
export function canonicalAgentEntry(
  target: AgentTarget,
  path: string,
  projectPath?: string,
): Record<string, unknown> {
  const pin =
    projectPath !== undefined && isProjectContained(path, projectPath)
      ? ["--project", resolve(projectPath)]
      : [];
  if (target.format === "opencode") {
    return {
      type: "local",
      command: ["muninn", "mcp", "run", ...pin],
      enabled: true,
    };
  }
  return { command: "muninn", args: ["mcp", "run", ...pin] };
}

function usesLegacyCommand(entry: Record<string, unknown>): boolean {
  if (entry.command === "huginn") return true;
  return (
    Array.isArray(entry.command) &&
    entry.command.length > 0 &&
    entry.command[0] === "huginn"
  );
}

function isUsableEntry(entry: Record<string, unknown>, target: AgentTarget): boolean {
  if (target.format === "opencode") {
    return isStringArray(entry.command);
  }
  if (hasOwn(entry, "command") && typeof entry.command !== "string") return false;
  if (hasOwn(entry, "args") && !isStringArray(entry.args)) return false;
  return true;
}

function classify(
  data: unknown,
  target: AgentTarget,
  desired: Record<string, unknown>,
): { state: JsonMcpState; error?: string } {
  if (!isPlainObject(data)) return { state: "malformed", error: "JSON root must be an object" };
  const containerKey = containerKeyFor(target);
  if (!hasOwn(data, containerKey)) return { state: "absent" };
  const container = data[containerKey];
  if (!isPlainObject(container)) {
    return { state: "malformed", error: `\`${containerKey}\` must be an object` };
  }
  if (!hasOwn(container, "muninn")) return { state: "absent" };
  const entry = container.muninn;
  if (!isPlainObject(entry)) {
    return { state: "malformed", error: `\`${containerKey}.muninn\` must be an object` };
  }
  if (!isUsableEntry(entry, target)) {
    return {
      state: "malformed",
      error:
        target.format === "opencode"
          ? "`mcp.muninn.command` must be an array of strings"
          : "`mcpServers.muninn` must use a string `command` and a string-array `args`",
    };
  }
  if (sameValue(entry, desired)) return { state: "registered" };
  if (usesLegacyCommand(entry)) return { state: "legacy" };
  return { state: "conflict" };
}

function inspect(options: JsonTargetOptions): Inspection {
  const desired = canonicalAgentEntry(options.target, options.path, options.projectPath);
  const label = `${options.target.id} MCP configuration`;
  const errors: string[] = [];
  const check = checkDocPath(options.path, {
    label,
    action: "read or write",
    projectPath: options.projectPath,
  });
  if (!check.ok) {
    return {
      target: options.target,
      path: options.path,
      state: "malformed",
      desired,
      error: check.reason,
      errors: [check.reason],
    };
  }

  const stat = lstatOrUndefined(check.path);
  if (stat === undefined) {
    return {
      target: options.target,
      path: check.path,
      state: "absent",
      desired,
      errors,
    };
  }
  if (!stat.isFile()) {
    const error = `${label} ${check.path} is not a regular file`;
    return {
      target: options.target,
      path: check.path,
      state: "malformed",
      desired,
      error,
      errors: [...errors, error],
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(check.path, "utf8");
  } catch (err) {
    const error = `Cannot read ${label} ${check.path}: ${(err as Error).message}`;
    return {
      target: options.target,
      path: check.path,
      state: "malformed",
      desired,
      error,
      errors: [...errors, error],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const error = `Malformed JSON in ${check.path}: ${(err as Error).message}`;
    return {
      target: options.target,
      path: check.path,
      state: "malformed",
      desired,
      raw,
      error,
      errors: [...errors, error],
    };
  }

  const classified = classify(parsed, options.target, desired);
  if (classified.state === "malformed") {
    const error = `Malformed ${label} ${check.path}: ${classified.error}`;
    return {
      target: options.target,
      path: check.path,
      state: "malformed",
      desired,
      raw,
      error,
      errors: [...errors, error],
    };
  }

  return {
    target: options.target,
    path: check.path,
    state: classified.state,
    desired,
    raw,
    data: parsed as Record<string, unknown>,
    errors,
  };
}

export function getJsonTargetStatus(options: JsonTargetOptions): JsonTargetStatus {
  const inspected = inspect(options);
  return {
    target: options.target,
    path: inspected.path,
    state: inspected.state,
    changed: false,
    error: inspected.error,
    errors: inspected.errors,
  };
}

function buildUpdatedConfig(
  data: Record<string, unknown>,
  target: AgentTarget,
  desired: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...data };
  const key = containerKeyFor(target);
  const current = isPlainObject(data[key]) ? data[key] : {};
  next[key] = { ...current, muninn: desired };
  return next;
}

export function setupJsonTarget(options: JsonTargetOptions): JsonTargetReport {
  const inspected = inspect(options);
  const dryRun = options.dryRun === true;
  const base = {
    target: inspected.target,
    path: inspected.path,
    state: inspected.state,
    dryRun,
    errors: inspected.errors,
  };

  if (inspected.state === "malformed") {
    return { ...base, outcome: "failed", changed: false, error: inspected.error };
  }
  if (inspected.state === "registered") {
    return { ...base, outcome: "present", changed: false };
  }
  if ((inspected.state === "conflict" || inspected.state === "legacy") && options.force !== true) {
    return { ...base, outcome: "skipped", changed: false };
  }

  const updated = buildUpdatedConfig(inspected.data ?? {}, inspected.target, inspected.desired);
  const content = renderConfig(updated, inspected.raw);

  if (dryRun) {
    return { ...base, outcome: "written", changed: true };
  }

  const check = checkDocPath(inspected.path, {
    label: `${inspected.target.id} MCP configuration`,
    action: "write",
    projectPath: options.projectPath,
  });
  if (!check.ok) {
    return { ...base, outcome: "failed", changed: false, error: check.reason };
  }
  const existing = lstatOrUndefined(check.path);
  if (existing?.isSymbolicLink()) {
    const error = `${inspected.target.id} MCP configuration ${check.path} is a symlink; refusing to write through it`;
    return { ...base, outcome: "failed", changed: false, error };
  }
  if (existing !== undefined && !existing.isFile()) {
    const error = `${inspected.target.id} MCP configuration ${check.path} is not a regular file`;
    return { ...base, outcome: "failed", changed: false, error };
  }

  const mode = existing === undefined ? 0o600 : existing.mode & 0o777;
  try {
    safeWriteAtomic(check.path, content, mode);
  } catch (err) {
    const error = `Cannot write ${inspected.target.id} MCP configuration ${check.path}: ${
      (err as Error).message
    }`;
    return { ...base, outcome: "failed", changed: false, error };
  }

  return { ...base, outcome: "written", changed: true };
}


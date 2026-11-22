/**
 * Claude Code session hooks.
 *
 * Hooks are the activation path for agents that do not consume MCP
 * `initialize.instructions` or a rules file: the agent runs a command at session
 * start and end, and Muninn prints the brief / writes the handoff. Only the
 * known-safe structure is merged: a missing or non-array `hooks` slot is never
 * replaced, and unrelated settings and hook entries are preserved byte-order
 * where feasible.
 */
import fs from "node:fs";
import path from "node:path";
import { checkDocPath, lstatOrUndefined } from "../util/path-safety.js";
import { renderConfig, safeWriteAtomic } from "./portable.js";

export const HOOK_START_COMMAND = "muninn hook session-start";
export const HOOK_END_COMMAND = "muninn hook session-end --agent claude";

export interface HookPlanEntry {
  event: "SessionStart" | "SessionEnd";
  command: string;
}

export const CLAUDE_HOOK_PLAN: HookPlanEntry[] = [
  { event: "SessionStart", command: HOOK_START_COMMAND },
  { event: "SessionEnd", command: HOOK_END_COMMAND },
];

export type HooksState =
  | "absent"
  | "present"
  | "partial"
  | "conflict"
  | "malformed";

export type HooksOutcome = "written" | "present" | "skipped" | "failed";

export interface HooksOptions {
  path: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface HooksStatus {
  path: string;
  state: HooksState;
  present: string[];
  missing: string[];
  error?: string;
}

export interface HooksReport extends HooksStatus {
  outcome: HooksOutcome;
  changed: boolean;
  dryRun: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(file: string): {
  data?: Record<string, unknown>;
  raw?: string;
  error?: string;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { raw: undefined };
    return { error: (err as Error).message };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      return { raw, error: "the settings file is not a JSON object" };
    }
    return { data: parsed, raw };
  } catch (err) {
    return { raw, error: (err as Error).message };
  }
}

function eventEntries(
  data: Record<string, unknown>,
  event: string
): unknown[] | null {
  const hooks = data.hooks;
  if (hooks === undefined) return [];
  if (!isPlainObject(hooks)) return null;
  const list = hooks[event];
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  return list;
}

function hasCommand(list: unknown[], command: string): boolean {
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const inner = item.hooks;
    if (!Array.isArray(inner)) continue;
    for (const hook of inner) {
      if (!isPlainObject(hook)) continue;
      if (hook.type !== "command") continue;
      if (typeof hook.command !== "string") continue;
      if (hook.command.trim() === command) return true;
    }
  }
  return false;
}

function inspect(pathname: string): HooksStatus & { data?: Record<string, unknown>; raw?: string } {
  const read = readSettings(pathname);
  if (read.error !== undefined) {
    return {
      path: pathname,
      state: "malformed",
      present: [],
      missing: [],
      error: read.error,
      raw: read.raw,
    };
  }
  const data = read.data ?? {};
  const present: string[] = [];
  const missing: string[] = [];
  let conflict = false;
  for (const plan of CLAUDE_HOOK_PLAN) {
    const list = eventEntries(data, plan.event);
    if (list === null) {
      conflict = true;
      missing.push(plan.command);
      continue;
    }
    if (hasCommand(list, plan.command)) present.push(plan.command);
    else missing.push(plan.command);
  }
  const state: HooksState = conflict
    ? "conflict"
    : present.length === CLAUDE_HOOK_PLAN.length
      ? "present"
      : present.length > 0
        ? "partial"
        : "absent";
  return { path: pathname, state, present, missing, data, raw: read.raw };
}

export function getHooksStatus(options: { path: string }): HooksStatus {
  const status = inspect(options.path);
  return {
    path: status.path,
    state: status.state,
    present: status.present,
    missing: status.missing,
    error: status.error,
  };
}

export function setupHooks(options: HooksOptions): HooksReport {
  const dryRun = options.dryRun === true;
  const inspected = inspect(options.path);
  const base: HooksReport = {
    path: options.path,
    state: inspected.state,
    present: inspected.present,
    missing: inspected.missing,
    error: inspected.error,
    outcome: "failed",
    changed: false,
    dryRun,
  };

  if (inspected.state === "malformed") {
    return { ...base, outcome: "failed" };
  }
  if (inspected.state === "conflict" && options.force !== true) {
    return { ...base, outcome: "skipped" };
  }
  if (inspected.missing.length === 0) {
    return { ...base, state: "present", outcome: "present" };
  }

  const data = inspected.data ?? {};
  const hooks: Record<string, unknown> = isPlainObject(data.hooks)
    ? { ...(data.hooks as Record<string, unknown>) }
    : {};
  for (const plan of CLAUDE_HOOK_PLAN) {
    const current = hooks[plan.event];
    const list = Array.isArray(current) ? [...current] : [];
    if (hasCommand(list, plan.command)) continue;
    list.push({ hooks: [{ type: "command", command: plan.command }] });
    hooks[plan.event] = list;
  }
  data.hooks = hooks;

  const content = renderConfig(data, inspected.raw);
  if (dryRun) {
    return {
      ...base,
      state: "present",
      missing: [],
      present: CLAUDE_HOOK_PLAN.map((plan) => plan.command),
      outcome: "written",
      changed: true,
    };
  }

  try {
    const screen = checkDocPath(options.path, {
      label: "the Claude settings file",
      action: "write",
    });
    if (!screen.ok) return { ...base, outcome: "failed", error: screen.reason };
    fs.mkdirSync(path.dirname(options.path), { recursive: true, mode: 0o700 });
    const existing = lstatOrUndefined(options.path);
    const mode = existing ? existing.mode & 0o777 : 0o600;
    safeWriteAtomic(options.path, content, mode);
  } catch (err) {
    return { ...base, outcome: "failed", error: (err as Error).message };
  }

  return {
    ...base,
    state: "present",
    missing: [],
    present: CLAUDE_HOOK_PLAN.map((plan) => plan.command),
    outcome: "written",
    changed: true,
  };
}

export function uninstallHooks(options: { path: string; dryRun?: boolean }): HooksReport {
  const inspected = inspect(options.path);
  const base: HooksReport = {
    path: options.path,
    state: inspected.state,
    present: inspected.present,
    missing: inspected.missing,
    error: inspected.error,
    outcome: "present",
    changed: false,
    dryRun: options.dryRun === true,
  };
  if (inspected.state === "malformed") return { ...base, outcome: "failed" };
  if (inspected.present.length === 0) return { ...base, state: "absent", outcome: "present" };

  const data = inspected.data ?? {};
  const hooks = isPlainObject(data.hooks)
    ? { ...(data.hooks as Record<string, unknown>) }
    : {};
  for (const plan of CLAUDE_HOOK_PLAN) {
    const current = hooks[plan.event];
    if (!Array.isArray(current)) continue;
    const next = current.filter((item) => {
      if (!isPlainObject(item) || !Array.isArray(item.hooks)) return true;
      return !item.hooks.some(
        (hook) =>
          isPlainObject(hook) &&
          typeof hook.command === "string" &&
          hook.command.trim() === plan.command
      );
    });
    if (next.length > 0) hooks[plan.event] = next;
    else delete hooks[plan.event];
  }
  if (Object.keys(hooks).length > 0) data.hooks = hooks;
  else delete data.hooks;

  if (base.dryRun) {
    return { ...base, state: "absent", present: [], outcome: "written", changed: true };
  }

  try {
    const screen = checkDocPath(options.path, {
      label: "the Claude settings file",
      action: "write",
    });
    if (!screen.ok) return { ...base, outcome: "failed", error: screen.reason };
    const existing = lstatOrUndefined(options.path);
    const mode = existing ? existing.mode & 0o777 : 0o600;
    safeWriteAtomic(options.path, renderConfig(data, inspected.raw), mode);
  } catch (err) {
    return { ...base, outcome: "failed", error: (err as Error).message };
  }

  return { ...base, state: "absent", present: [], outcome: "written", changed: true };
}

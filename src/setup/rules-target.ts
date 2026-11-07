/**
 * Marked, human-authored agent rules.
 *
 * Rules are appended as a delimited Markdown block instead of replacing the
 * file: the surrounding prose belongs to the user. A complete prior Huginn block
 * is detected as stale and only replaced with `--force`. Unmatched, duplicate, or
 * otherwise ambiguous markers are fatal because their safe replacement boundary
 * cannot be determined.
 */
import fs from "node:fs";
import { resolve } from "node:path";
import { assertDocPath, checkDocPath, lstatOrUndefined } from "../util/path-safety.js";
import { safeWriteAtomic } from "./portable.js";
import type { AgentId } from "./registry.js";

export const MUNINN_RULES_START = "<!-- muninn:rules:start -->";
export const MUNINN_RULES_END = "<!-- muninn:rules:end -->";
export const LEGACY_RULES_START = "<!-- huginn:muninn-rules:start -->";
export const LEGACY_RULES_END = "<!-- huginn:muninn-rules:end -->";

export const MUNINN_RULES_BLOCK = [
  MUNINN_RULES_START,
  "## Muninn project memory",
  "",
  "- Call `muninn_bootstrap` once at the start of a session to load the project brief.",
  "- Before designing a change, use `muninn_search` and `muninn_inspect_symbol` to check prior decisions and the relevant code.",
  "- When a session settles something the project should remember — a convention, a tradeoff, a",
  "  discovered constraint, or a bug that took real work — record it with `muninn_save` before you",
  "  finish. Use a `topicKey` for anything a later decision could replace, so the newer one supersedes",
  "  it instead of contradicting it.",
  "- Before completing code, use `muninn_verify_contract` to verify the execution contract.",
  MUNINN_RULES_END,
].join("\n");

export type RulesState = "absent" | "present" | "stale" | "malformed";
export type RulesOutcome = "written" | "present" | "stale" | "skipped" | "failed";

export interface RulesTargetOptions {
  path: string;
  agents: AgentId[];
  projectPath?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface RulesTargetStatus {
  path: string;
  agents: AgentId[];
  state: RulesState;
  changed: false;
  error?: string;
  errors: string[];
}

export interface RulesTargetReport extends Omit<RulesTargetStatus, "changed"> {
  outcome: RulesOutcome;
  changed: boolean;
  dryRun: boolean;
}

interface MarkerRange {
  start: number;
  end: number;
}

interface Inspection {
  path: string;
  agents: AgentId[];
  state: RulesState;
  raw?: string;
  managed?: MarkerRange;
  legacy?: MarkerRange;
  error?: string;
  errors: string[];
}

function positions(raw: string, marker: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const index = raw.indexOf(marker, from);
    if (index === -1) return found;
    found.push(index);
    from = index + marker.length;
  }
}

function markerRange(
  raw: string,
  startMarker: string,
  endMarker: string,
  label: string,
): { range?: MarkerRange; error?: string } {
  const starts = positions(raw, startMarker);
  const ends = positions(raw, endMarker);
  if (starts.length === 0 && ends.length === 0) return {};
  if (starts.length !== ends.length) {
    return {
      error: `unmatched ${label} marker: found ${starts.length} start marker(s) and ${ends.length} end marker(s)`,
    };
  }
  if (starts.length > 1 || ends.length > 1) {
    return { error: `duplicate ${label} markers; refusing to guess which block to manage` };
  }
  const start = starts[0]!;
  const end = ends[0]!;
  if (end < start) {
    return { error: `${label} end marker appears before its start marker` };
  }
  return { range: { start, end: end + endMarker.length } };
}

function inspectRules(options: RulesTargetOptions): Inspection {
  const label = "Muninn rules file";
  const base = { path: resolve(options.path), agents: options.agents, errors: [] as string[] };
  const check = checkDocPath(options.path, {
    label,
    action: "read or write",
    projectPath: options.projectPath,
  });
  if (!check.ok) {
    return {
      ...base,
      path: resolve(options.path),
      state: "malformed",
      error: check.reason,
      errors: [check.reason],
    };
  }

  const stat = lstatOrUndefined(check.path);
  if (stat === undefined) {
    return { ...base, path: check.path, state: "absent" };
  }
  if (!stat.isFile()) {
    const error = `${label} ${check.path} is not a regular file`;
    return {
      ...base,
      path: check.path,
      state: "malformed",
      error,
      errors: [error],
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(check.path, "utf8");
  } catch (err) {
    const error = `Cannot read ${label} ${check.path}: ${(err as Error).message}`;
    return {
      ...base,
      path: check.path,
      state: "malformed",
      error,
      errors: [error],
    };
  }

  const managed = markerRange(raw, MUNINN_RULES_START, MUNINN_RULES_END, "Muninn rules");
  const legacy = markerRange(raw, LEGACY_RULES_START, LEGACY_RULES_END, "legacy Huginn rules");
  const markerErrors = [managed.error, legacy.error].filter(
    (entry): entry is string => entry !== undefined,
  );
  if (markerErrors.length > 0) {
    const error = `Malformed ${label} ${check.path}: ${markerErrors.join("; ")}`;
    return {
      ...base,
      path: check.path,
      state: "malformed",
      raw,
      error,
      errors: [error],
    };
  }

  // Marker ranges are half-open intervals. The managed and legacy blocks must
  // be disjoint: crossed or nested ranges make the replacement boundary
  // ambiguous, so reject them before any edit is planned.
  if (
    managed.range !== undefined &&
    legacy.range !== undefined &&
    managed.range.start < legacy.range.end &&
    legacy.range.start < managed.range.end
  ) {
    const error =
      `Malformed ${label} ${check.path}: managed and legacy Huginn marker ranges ` +
      `overlap or nest (${managed.range.start}-${managed.range.end} and ` +
      `${legacy.range.start}-${legacy.range.end}); refusing to guess which block to replace`;
    return {
      ...base,
      path: check.path,
      state: "malformed",
      raw,
      error,
      errors: [error],
    };
  }

  const state: RulesState =
    legacy.range !== undefined
      ? "stale"
      : managed.range !== undefined
        ? "present"
        : "absent";
  return {
    ...base,
    path: check.path,
    state,
    raw,
    managed: managed.range,
    legacy: legacy.range,
  };
}

function appendBlock(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) return `${MUNINN_RULES_BLOCK}\n`;
  return `${raw}${raw.endsWith("\n") ? "\n" : "\n\n"}${MUNINN_RULES_BLOCK}\n`;
}

function applyEdits(
  raw: string,
  edits: Array<{ start: number; end: number; text: string }>,
): string {
  let next = raw;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`;
  }
  return next;
}

function desiredContent(inspected: Inspection, force: boolean): string {
  const raw = inspected.raw;
  const managed = inspected.managed;
  const legacy = inspected.legacy;

  // No file or no block yet: append a fresh managed block.
  if (raw === undefined || (managed === undefined && legacy === undefined)) {
    return appendBlock(raw);
  }

  // A legacy block only: leave it untouched unless a forced replacement was
  // requested, in which case it is replaced in place.
  if (legacy !== undefined && managed === undefined) {
    if (!force) return raw;
    return applyEdits(raw, [{ ...legacy, text: MUNINN_RULES_BLOCK }]);
  }

  // Managed block only: refresh it in place.
  if (managed !== undefined && legacy === undefined) {
    return applyEdits(raw, [{ ...managed, text: MUNINN_RULES_BLOCK }]);
  }

  // Both blocks exist (inspection guarantees they do not overlap). Without
  // --force the stale legacy block is preserved; with --force replace the
  // managed block and remove the legacy block.
  if (legacy !== undefined && managed !== undefined) {
    if (!force) return raw;
    return applyEdits(raw, [
      { ...managed, text: MUNINN_RULES_BLOCK },
      { ...legacy, text: "" },
    ]);
  }

  return appendBlock(raw);
}

export function getRulesTargetStatus(options: RulesTargetOptions): RulesTargetStatus {
  const inspected = inspectRules(options);
  return {
    path: inspected.path,
    agents: inspected.agents,
    state: inspected.state,
    changed: false,
    error: inspected.error,
    errors: inspected.errors,
  };
}

export function setupRulesTarget(options: RulesTargetOptions): RulesTargetReport {
  const inspected = inspectRules(options);
  const dryRun = options.dryRun === true;
  const base = {
    path: inspected.path,
    agents: inspected.agents,
    state: inspected.state,
    dryRun,
    errors: inspected.errors,
  };

  if (inspected.state === "malformed") {
    return { ...base, outcome: "failed", changed: false, error: inspected.error };
  }
  if (inspected.state === "stale" && options.force !== true) {
    return { ...base, outcome: "stale", changed: false };
  }

  const content = desiredContent(inspected, options.force === true);
  if (content === inspected.raw) {
    return { ...base, outcome: "present", changed: false };
  }
  if (dryRun) {
    return { ...base, outcome: "written", changed: true };
  }

  const label = "Muninn rules file";
  const check = checkDocPath(options.path, {
    label,
    action: "write",
    projectPath: options.projectPath,
  });
  if (!check.ok) {
    return {
      ...base,
      outcome: "failed",
      changed: false,
      error: check.reason,
      errors: [...base.errors, check.reason],
    };
  }

  // Re-check immediately before the atomic write, mirroring the MCP writers.
  const existing = lstatOrUndefined(check.path);
  if (existing?.isSymbolicLink()) {
    const error = `${label} ${check.path} is a symlink; refusing to write through it`;
    return { ...base, outcome: "failed", changed: false, error, errors: [...base.errors, error] };
  }
  if (existing !== undefined && !existing.isFile()) {
    const error = `${label} ${check.path} is not a regular file`;
    return { ...base, outcome: "failed", changed: false, error, errors: [...base.errors, error] };
  }

  const mode = existing === undefined ? 0o600 : existing.mode & 0o777;
  try {
    // assertDocPath is the fail-closed final gate, after inspection and before
    // the write, so a path swapped for a link cannot be followed.
    const writePath = assertDocPath(options.path, {
      label,
      action: "write",
      projectPath: options.projectPath,
    });
    safeWriteAtomic(writePath, content, mode);
  } catch (err) {
    const error = `Cannot write ${label} ${inspected.path}: ${(err as Error).message}`;
    return { ...base, outcome: "failed", changed: false, error, errors: [...base.errors, error] };
  }

  return { ...base, outcome: "written", changed: true };
}

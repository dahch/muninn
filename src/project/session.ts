/**
 * DSH session workspace detection.
 *
 * DSH mounts an MCP server once per profile, so the server process cannot inherit
 * a per-session working directory from the protocol. DSH does record each
 * session's `cwd` on disk (session project cache), so when autodetection is
 * enabled the server can follow the most recently updated session.
 *
 * If that directory is itself a project, it is used automatically. If it is a
 * container of repositories (for example a workspace with several checkouts),
 * the server reports the candidates instead of guessing; the agent chooses one
 * with `muninn_project { action: "use" }`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_MARKER_DIR, PROJECT_MARKER_FILE } from "./identity.js";

export interface ProjectCandidate {
  name: string;
  rootPath: string;
}

export interface SessionWorkspace {
  cwd: string;
  /** The session cwd when it is a real project root; null for a container. */
  projectRoot: string | null;
  candidates: ProjectCandidate[];
}

interface SessionCache {
  at: number;
  cwd: string | null;
}

let cache: SessionCache = { at: 0, cwd: null };
const CACHE_MS = 2_000;

/** Clears the cached session cwd (tests and long-lived diagnostics). */
export function resetSessionCache(): void {
  cache = { at: 0, cwd: null };
}

export function sessionAutodetectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MUNINN_SESSION_AUTODETECT === "dsh";
}

/** Newest session `cwd` recorded by DSH, cached for two seconds. */
export function findDshSessionCwd(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now()
): string | null {
  if (now - cache.at < CACHE_MS) return cache.cwd;
  const dshHome = env.DSH_HOME?.trim()
    ? path.resolve(env.DSH_HOME.trim())
    : path.join(os.homedir(), ".dsh");
  const dir = path.join(dshHome, "storages", "session_projcache", "sessions");
  let best: { mtime: number; cwd: string } | null = null;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    cache = { at: now, cwd: null };
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (best && stat.mtimeMs <= best.mtime) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        record?: { identity?: { cwd?: unknown } };
      };
      const cwd = parsed.record?.identity?.cwd;
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) continue;
      best = { mtime: stat.mtimeMs, cwd: path.resolve(cwd) };
    } catch {
      continue;
    }
  }
  cache = { at: now, cwd: best?.cwd ?? null };
  return cache.cwd;
}

/** True when the directory carries a project marker or a Git repository. */
export function isProjectRoot(dir: string): boolean {
  try {
    const marker = path.join(dir, PROJECT_MARKER_DIR, PROJECT_MARKER_FILE);
    if (fs.existsSync(marker)) return true;
    if (fs.existsSync(path.join(dir, ".git"))) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Finds project roots at or below a workspace directory: the directory itself,
 * immediate children, and grandchildren (monorepos such as `packages/app`).
 * Bounded to keep the first session call cheap.
 */
export function listProjectCandidates(
  workspace: string,
  limit = 30
): ProjectCandidate[] {
  const root = path.resolve(workspace);
  const found: ProjectCandidate[] = [];
  const seen = new Set<string>();
  let visited = 0;

  function add(dir: string): void {
    if (found.length >= limit || seen.has(dir)) return;
    if (!isProjectRoot(dir)) return;
    seen.add(dir);
    found.push({ name: path.basename(dir) || dir, rootPath: dir });
  }

  function scan(dir: string, depth: number): void {
    if (depth > 2 || found.length >= limit || visited > 600) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (!entry.isDirectory()) continue;
      visited += 1;
      const child = path.join(dir, entry.name);
      add(child);
      if (!seen.has(child)) scan(child, depth + 1);
    }
  }

  add(root);
  if (!seen.has(root)) scan(root, 1);
  return found;
}

/**
 * Markdown returned by `muninn_bootstrap` when the session folder is a
 * container of repositories. It names the candidates so the agent can switch
 * with `muninn_project { action: "use" }` instead of guessing.
 */
export function renderWorkspaceGuidance(workspace: SessionWorkspace): string {
  const lines = [
    "# Session workspace: " + path.basename(workspace.cwd),
    "",
    "Muninn is not bound to a project: the session folder is a workspace, not a single repository.",
  ];
  if (workspace.candidates.length > 0) {
    lines.push("", "Projects found in this workspace:");
    for (const candidate of workspace.candidates) {
      lines.push("- " + candidate.name + " — " + candidate.rootPath);
    }
    lines.push(
      "",
      'Call muninn_project with action "use" and the path of the project you are working on, then call muninn_bootstrap again.'
    );
  } else {
    lines.push(
      "",
      "No project marker or Git repository was found at or under this folder. Initialize one with muninn memory init --project <folder>, or switch with muninn_project."
    );
  }
  return lines.join("\n");
}

/** Resolves the active session workspace into a project root or candidates. */
export function resolveSessionWorkspace(
  env: NodeJS.ProcessEnv = process.env
): SessionWorkspace | null {
  const cwd = findDshSessionCwd(env);
  if (!cwd) return null;
  if (isProjectRoot(cwd)) return { cwd, projectRoot: cwd, candidates: [] };
  return { cwd, projectRoot: null, candidates: listProjectCandidates(cwd) };
}

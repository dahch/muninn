/**
 * Project identity and portable storage.
 *
 * Muninn used to identify a project by its `root_path` and to keep the database
 * inside the repository (`<git-root>/.huginn/muninn.db`), with a single shared
 * file in the home directory for anything that is not a Git repository. That
 * made identity path-dependent (moving or cloning a project lost its memory)
 * and made every non-Git project share one database.
 *
 * This module replaces that with three independent pieces:
 *
 * 1. A committed marker, `<project>/.muninn/project.json`, carrying a stable
 *    `uid`. It is small, human-readable and the only thing a repository needs
 *    to carry so its memory survives a move, a reclone or another machine.
 * 2. A user registry, `$MUNINN_HOME/registry.json`, mapping uids to the paths
 *    and Git remotes they have been seen at. It is a convenience for resolution
 *    and diagnosis, never the source of truth.
 * 3. Storage outside the repository: `$MUNINN_HOME/projects/<uid>/memory.db`.
 *    Every project — Git or not, worktree or clone — gets its own file.
 *
 * Resolution is deterministic and read-only: resolving never writes a marker or
 * the registry. Callers that want to remember a project call
 * {@link registerProjectContext}.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { isInside, lstatOrUndefined, realpathAllowingMissing } from "../util/path-safety.js";

/** Directory that carries the committed project marker. */
export const PROJECT_MARKER_DIR = ".muninn";
/** Marker file name inside {@link PROJECT_MARKER_DIR}. */
export const PROJECT_MARKER_FILE = "project.json";
/** Marker schema version written by this module. */
export const PROJECT_MARKER_VERSION = 1;
/** Legacy in-repository directory, kept only for migration and diagnostics. */
export const LEGACY_STORAGE_DIR = ".huginn";
/** Registry schema version. */
export const REGISTRY_VERSION = 1;

export interface ProjectMarker {
  version: number;
  uid: string;
  name: string;
}

export type ProjectKind = "git" | "directory";

export type ProjectResolutionSource =
  | "explicit"
  | "marker"
  | "git"
  | "registry"
  | "fallback";

export interface ProjectContext {
  /** Canonical project root (marker directory, Git common root, or the path given). */
  rootPath: string;
  /** Stable identity used for storage and for the `projects.uid` column. */
  uid: string;
  /** Human name (marker name, directory basename, or "project"). */
  name: string;
  kind: ProjectKind;
  /** Git common root when the project lives in a repository. */
  gitRoot: string | null;
  /** Sanitized origin remote of the repository, when there is one. */
  gitRemote: string | null;
  /** Absolute path of the marker file, when one was found. */
  markerPath: string | null;
  source: ProjectResolutionSource;
}

export interface RegistryEntry {
  uid: string;
  name: string;
  kind: ProjectKind;
  rootPaths: string[];
  gitRemotes: string[];
  lastSeenAt: string;
}

export interface RegistryFile {
  version: number;
  projects: RegistryEntry[];
}

/** Resolves the Muninn home (`MUNINN_HOME` or `~/.muninn`). */
export function muninnHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MUNINN_HOME?.trim();
  return raw ? path.resolve(raw) : path.join(os.homedir(), ".muninn");
}

/** `$MUNINN_HOME/projects`. */
export function projectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(muninnHome(env), "projects");
}

/** Per-project storage directory: `$MUNINN_HOME/projects/<uid>`. */
export function projectStorageDir(
  uid: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!isValidUid(uid)) {
    throw new Error(`Invalid project uid "${uid}"`);
  }
  return path.join(projectsRoot(env), uid);
}

/** Default memory database for a project. */
export function memoryDbPath(
  uid: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(projectStorageDir(uid, env), "memory.db");
}

/** Directory of the cross-project memory store. */
export function globalMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(muninnHome(env), "global");
}

/** Database that holds `scope = global` observations shared by every project. */
export function globalMemoryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(globalMemoryDir(env), "memory.db");
}

/** Default deterministic JSONL snapshot for a project. */
export function memoryJsonlPath(
  uid: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(projectStorageDir(uid, env), "memories.jsonl");
}

/**
 * Per-worktree code index path. The memory is shared by the repository, but the
 * code graph is not: two worktrees contain different files.
 */
export function codeIndexPath(
  uid: string,
  worktreeRoot: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const key = crypto
    .createHash("sha256")
    .update(realpathAllowingMissing(path.resolve(worktreeRoot)))
    .digest("hex")
    .slice(0, 16);
  return path.join(projectStorageDir(uid, env), "index", `${key}.db`);
}

/** Legacy per-repository database path used before portable storage. */
export function legacyProjectDbPath(rootPath: string): string {
  return path.join(path.resolve(rootPath), LEGACY_STORAGE_DIR, "muninn.db");
}

/** Legacy shared database used when no Git root was found. */
export function legacyHomeDbPath(): string {
  return path.join(os.homedir(), LEGACY_STORAGE_DIR, "muninn.db");
}

const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidUid(value: unknown): value is string {
  return typeof value === "string" && UID_PATTERN.test(value);
}

/** True when `child` is `root` or lives inside it. */
export function isSameOrInside(child: string, root: string): boolean {
  const resolvedChild = path.resolve(child);
  const resolvedRoot = path.resolve(root);
  return resolvedChild === resolvedRoot || isInside(resolvedChild, resolvedRoot);
}

/**
 * Normalizes a Git remote so the same repository over SSH and HTTPS produces the
 * same identity where it reasonably can: trims whitespace, drops a trailing
 * `.git` and trailing slashes, and lowercases the host part.
 */
export function normalizeGitRemote(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return trimmed;
  let normalized = trimmed.replace(/\/+$/, "");
  if (normalized.endsWith(".git")) normalized = normalized.slice(0, -4);
  const scpLike = normalized.match(/^([A-Za-z0-9._-]+)@([^:]+):(.+)$/);
  if (scpLike) {
    return `${scpLike[2].toLowerCase()}/${scpLike[3]}`;
  }
  try {
    const parsed = new URL(normalized);
    parsed.hash = "";
    parsed.search = "";
    parsed.username = "";
    parsed.password = "";
    // Scheme and user are deliberately dropped: `git@host:org/repo` and
    // `https://host/org/repo` are the same repository and must share identity.
    const host = parsed.host.toLowerCase();
    return `${host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return normalized;
  }
}

/** Strips embedded credentials from a Git remote before it is stored. */
export function sanitizeGitRemote(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      if (parsed.protocol === "ssh:" && !parsed.password) {
        return rawUrl;
      }
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    return rawUrl;
  } catch {
    return rawUrl.replace(/^([a-zA-Z+-]+:\/\/)[^/@]+@/, "$1");
  }
}

/**
 * Derives a stable uid when no marker exists: the Git remote first (so clones
 * share memory), the resolved path otherwise.
 */
export function deriveProjectUid(input: {
  markerUid?: string | null;
  gitRemote?: string | null;
  rootPath: string;
}): string {
  if (isValidUid(input.markerUid)) return input.markerUid;
  const hash = crypto.createHash("sha256");
  if (input.gitRemote && input.gitRemote.trim()) {
    hash.update(`git:${normalizeGitRemote(input.gitRemote)}`);
    return `g-${hash.digest("hex").slice(0, 20)}`;
  }
  hash.update(`path:${realpathAllowingMissing(path.resolve(input.rootPath))}`);
  return `p-${hash.digest("hex").slice(0, 20)}`;
}

/** Reads a marker from a directory without throwing. */
export function readProjectMarker(dir: string): ProjectMarker | null {
  const markerPath = path.join(dir, PROJECT_MARKER_DIR, PROJECT_MARKER_FILE);
  const stat = lstatOrUndefined(markerPath);
  if (!stat || !stat.isFile()) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const uid = record.uid;
    if (!isValidUid(uid)) return null;
    const name =
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : path.basename(dir) || "project";
    const version =
      typeof record.version === "number" ? record.version : PROJECT_MARKER_VERSION;
    return { version, uid, name };
  } catch {
    return null;
  }
}

/** Walks up from `startDir` looking for the nearest project marker. */
export function findProjectMarker(
  startDir: string
): { dir: string; marker: ProjectMarker } | null {
  let current = path.resolve(startDir);
  for (;;) {
    const marker = readProjectMarker(current);
    if (marker) return { dir: current, marker };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Writes the project marker atomically. The marker is committed by the user, so
 * it is created with regular file permissions; the `.muninn` directory is
 * private to the user like the rest of Muninn's on-disk state.
 */
export function writeProjectMarker(
  rootPath: string,
  marker: { uid: string; name?: string }
): string {
  if (!isValidUid(marker.uid)) {
    throw new Error(`Invalid project uid "${marker.uid}"`);
  }
  const root = path.resolve(rootPath);
  const dir = path.join(root, PROJECT_MARKER_DIR);
  const markerPath = path.join(dir, PROJECT_MARKER_FILE);
  const existing = lstatOrUndefined(markerPath);
  if (existing?.isSymbolicLink()) {
    throw new Error(
      `Refusing to write the project marker ${markerPath}: it is a symlink`
    );
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload: ProjectMarker = {
    version: PROJECT_MARKER_VERSION,
    uid: marker.uid,
    name: marker.name?.trim() || path.basename(root) || "project",
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const temp = path.join(dir, `.project.json.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, body, { mode: 0o644 });
  fs.renameSync(temp, markerPath);
  return markerPath;
}

/**
 * Reads `commondir` from a worktree's git directory. Returns the directory that
 * holds `config` and `objects` (the main `.git`), or the given gitdir itself
 * when it is not a worktree.
 */
function resolveGitCommonDir(worktreeGitDir: string): string | null {
  const commonFile = path.join(worktreeGitDir, "commondir");
  const stat = lstatOrUndefined(commonFile);
  if (!stat || !stat.isFile()) return null;
  try {
    const raw = fs.readFileSync(commonFile, "utf8").trim();
    if (!raw) return null;
    const resolved = path.resolve(worktreeGitDir, raw);
    return fs.existsSync(resolved) ? realpathAllowingMissing(resolved) : null;
  } catch {
    return null;
  }
}

/** Parses the `gitdir: <path>` line of a `.git` file. */
export function readGitDirFile(gitFilePath: string): string | null {
  try {
    const raw = fs.readFileSync(gitFilePath, "utf8");
    const match = raw.match(/^gitdir:\s*(.+)$/im);
    if (!match) return null;
    const target = path.resolve(path.dirname(gitFilePath), match[1].trim());
    return fs.existsSync(target) ? realpathAllowingMissing(target) : null;
  } catch {
    return null;
  }
}

/**
 * Finds the Git **common** root: for a normal repository that is the directory
 * containing `.git`; for a linked worktree it is the main repository root, so
 * every worktree shares one project identity.
 */
export function findGitCommonRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    const gitPath = path.join(current, ".git");
    const stat = lstatOrUndefined(gitPath);
    if (stat?.isDirectory()) return realpathAllowingMissing(current);
    if (stat?.isFile()) {
      const gitDir = readGitDirFile(gitPath);
      if (gitDir) {
        const commonDir = resolveGitCommonDir(gitDir);
        const resolvedCommon = commonDir ?? gitDir;
        if (path.basename(resolvedCommon) === ".git") {
          return realpathAllowingMissing(path.dirname(resolvedCommon));
        }
        return realpathAllowingMissing(current);
      }
      return realpathAllowingMissing(current);
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Reads the sanitized `origin` remote of the repository containing `rootPath`. */
export function readGitRemote(rootPath: string): string | null {
  const gitPath = path.join(path.resolve(rootPath), ".git");
  const stat = lstatOrUndefined(gitPath);
  let configPath: string | null = null;
  if (stat?.isDirectory()) {
    configPath = path.join(gitPath, "config");
  } else if (stat?.isFile()) {
    const gitDir = readGitDirFile(gitPath);
    if (gitDir) {
      const commonDir = resolveGitCommonDir(gitDir) ?? gitDir;
      configPath = path.join(commonDir, "config");
    }
  }
  if (!configPath || !fs.existsSync(configPath)) return null;
  try {
    const content = fs.readFileSync(configPath, "utf8");
    const match = content.match(/\[remote "origin"\][^\[]*?url\s*=\s*([^\n\r]+)/);
    if (!match || !match[1]) return null;
    return sanitizeGitRemote(match[1].trim());
  } catch {
    return null;
  }
}

/** `$MUNINN_HOME/registry.json`. */
export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(muninnHome(env), "registry.json");
}

function normalizeRegistryEntry(value: unknown): RegistryEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!isValidUid(record.uid)) return null;
  const rootPaths = Array.isArray(record.rootPaths)
    ? record.rootPaths.filter((item): item is string => typeof item === "string")
    : [];
  const gitRemotes = Array.isArray(record.gitRemotes)
    ? record.gitRemotes.filter((item): item is string => typeof item === "string")
    : [];
  const kind: ProjectKind = record.kind === "git" ? "git" : "directory";
  return {
    uid: record.uid,
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : record.uid,
    kind,
    rootPaths: [...new Set(rootPaths.map((item) => path.resolve(item)))],
    gitRemotes: [...new Set(gitRemotes)],
    lastSeenAt:
      typeof record.lastSeenAt === "string" ? record.lastSeenAt : new Date(0).toISOString(),
  };
}

/** Reads the registry, returning an empty one when missing or corrupt. */
export function readRegistry(env: NodeJS.ProcessEnv = process.env): RegistryFile {
  const file = registryPath(env);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const record = parsed as Record<string, unknown> | null;
    const projects = Array.isArray(record?.projects)
      ? (record!.projects as unknown[])
          .map(normalizeRegistryEntry)
          .filter((entry): entry is RegistryEntry => entry !== null)
      : [];
    return { version: REGISTRY_VERSION, projects };
  } catch {
    return { version: REGISTRY_VERSION, projects: [] };
  }
}

/** Writes the registry atomically with user-only permissions. */
export function writeRegistry(
  registry: RegistryFile,
  env: NodeJS.ProcessEnv = process.env
): void {
  const file = registryPath(env);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = lstatOrUndefined(file);
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to write the Muninn registry ${file}: it is a symlink`);
  }
  const body = `${JSON.stringify(
    {
      version: REGISTRY_VERSION,
      projects: registry.projects.slice().sort((a, b) => a.uid.localeCompare(b.uid)),
    },
    null,
    2
  )}\n`;
  const temp = path.join(dir, `.registry.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, body, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Inserts or updates a registry entry. Best effort: never breaks resolution. */
export function upsertRegistryEntry(
  context: ProjectContext,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    const registry = readRegistry(env);
    const index = registry.projects.findIndex((entry) => entry.uid === context.uid);
    const next: RegistryEntry = {
      uid: context.uid,
      name: context.name,
      kind: context.kind,
      rootPaths: [...new Set([context.rootPath])],
      gitRemotes: context.gitRemote ? [context.gitRemote] : [],
      lastSeenAt: new Date().toISOString(),
    };
    if (index >= 0) {
      const previous = registry.projects[index];
      next.rootPaths = [...new Set([...previous.rootPaths, context.rootPath])];
      next.gitRemotes = [
        ...new Set([...previous.gitRemotes, ...(context.gitRemote ? [context.gitRemote] : [])]),
      ];
      next.name = previous.name || next.name;
      next.kind = previous.kind ?? next.kind;
      registry.projects[index] = next;
    } else {
      registry.projects.push(next);
    }
    writeRegistry(registry, env);
    return true;
  } catch {
    return false;
  }
}

/** Removes a registry entry by uid. Returns true when something was removed. */
export function forgetRegistryEntry(
  uid: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const registry = readRegistry(env);
  const next = registry.projects.filter((entry) => entry.uid !== uid);
  if (next.length === registry.projects.length) return false;
  writeRegistry({ ...registry, projects: next }, env);
  return true;
}

/** Renames a registry entry. Returns false when the uid is unknown. */
export function renameRegistryEntry(
  uid: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!name.trim()) throw new Error("Project name cannot be empty");
  const registry = readRegistry(env);
  const entry = registry.projects.find((item) => item.uid === uid);
  if (!entry) return false;
  entry.name = name.trim();
  writeRegistry(registry, env);
  return true;
}

/**
 * Finds the registry entry that owns `startDir`: the entry with the longest
 * root path that is an ancestor of the directory. Worktree paths are matched
 * through their common root too.
 */
export function findRegistryMatch(
  registry: RegistryFile,
  startDir: string | null,
  gitRoot: string | null
): RegistryEntry | null {
  const candidates = [startDir, gitRoot].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  let best: { entry: RegistryEntry; depth: number } | null = null;
  for (const entry of registry.projects) {
    for (const root of entry.rootPaths) {
      for (const candidate of candidates) {
        if (!isSameOrInside(candidate, root)) continue;
        const depth = root.split(path.sep).length;
        if (!best || depth > best.depth) best = { entry, depth };
      }
    }
  }
  return best?.entry ?? null;
}

export interface ResolveProjectOptions {
  /** Directory to start from (defaults to the process working directory). */
  startDir?: string;
  /** Explicit project root (CLI `--project`). Normalised to the real root. */
  explicitRoot?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the project context for a directory. Read-only: it never writes a
 * marker or the registry.
 *
 * Order: explicit root → nearest marker → Git common root → registry entry that
 * owns the directory → the directory itself.
 */
export function resolveProjectContext(
  options: ResolveProjectOptions = {}
): ProjectContext {
  const env = options.env ?? process.env;
  const explicit = options.explicitRoot?.trim()
    ? path.resolve(options.explicitRoot.trim())
    : undefined;
  const start = explicit ?? path.resolve(options.startDir ?? process.cwd());
  const markerHit = findProjectMarker(start);
  const gitRootAtStart = findGitCommonRoot(start);
  const registry = readRegistry(env);
  const registryMatch = findRegistryMatch(registry, start, gitRootAtStart);

  let rootPath: string;
  let source: ProjectResolutionSource;
  if (markerHit) {
    rootPath = realpathAllowingMissing(markerHit.dir);
    source = "marker";
  } else if (gitRootAtStart) {
    rootPath = gitRootAtStart;
    source = "git";
  } else if (registryMatch) {
    const owner = registryMatch.rootPaths
      .filter((root) => isSameOrInside(start, root))
      .sort((a, b) => b.length - a.length)[0];
    rootPath = owner ?? start;
    source = "registry";
  } else {
    rootPath = start;
    source = explicit ? "explicit" : "fallback";
  }

  const gitRoot = findGitCommonRoot(rootPath) ?? gitRootAtStart;
  const kind: ProjectKind = gitRoot ? "git" : "directory";
  const gitRemote = gitRoot ? readGitRemote(gitRoot) : null;
  const uid =
    (markerHit?.marker.uid && isValidUid(markerHit.marker.uid)
      ? markerHit.marker.uid
      : undefined) ??
    registryMatch?.uid ??
    deriveProjectUid({ gitRemote, rootPath });
  const name =
    markerHit?.marker.name?.trim() ||
    registryMatch?.name ||
    (path.basename(rootPath) || "project");
  const markerPath = markerHit
    ? path.join(markerHit.dir, PROJECT_MARKER_DIR, PROJECT_MARKER_FILE)
    : null;

  return { rootPath, uid, name, kind, gitRoot, gitRemote, markerPath, source };
}

/** Normalises a path to its project root without side effects. */
export function normalizeProjectRoot(inputPath: string): string {
  return resolveProjectContext({ explicitRoot: inputPath }).rootPath;
}

/** Records a resolved project in the registry (best effort). */
export function registerProjectContext(
  context: ProjectContext,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return upsertRegistryEntry(context, env);
}

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Extensions the graph indexes. Tier A is parsed precisely; the rest heuristically. */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".dart": "dart",
  ".lua": "lua",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".ex": "elixir",
  ".exs": "elixir",
  ".hs": "haskell",
  ".clj": "clojure",
  ".zig": "zig",
  ".nim": "nim",
  ".r": "r",
  ".jl": "julia",
  ".pl": "perl",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".sql": "sql",
};

export const SUPPORTED_EXTENSIONS = new Set(Object.keys(LANGUAGE_BY_EXTENSION));

export const DEFAULT_EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".muninn",
  ".huginn",
  ".harness",
  "dist",
  "build",
  "target",
  "out",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".cache",
  "vendor",
  "Pods",
  "coverage",
  "__pycache__",
  ".gradle",
  ".idea",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "bin",
  "obj",
]);

export function detectLanguage(filePath: string): string | null {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null;
}

export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function isTestFile(relativePath: string): boolean {
  const normalized = normalizePath(relativePath).toLowerCase();
  const base = normalized.split("/").pop() ?? normalized;
  return (
    /(^|\/)(__tests__|tests?|spec|testdata|fixtures)(\/|$)/.test(normalized) ||
    /[._-](test|spec)\.[a-z0-9]+$/.test(base) ||
    /(^test_|_test\.[a-z0-9]+$|_spec\.rb$)/.test(base)
  );
}

export function isGeneratedFile(relativePath: string): boolean {
  const normalized = normalizePath(relativePath).toLowerCase();
  const base = normalized.split("/").pop() ?? normalized;
  return (
    /(^|\/)(generated|gen|__generated__)(\/|$)/.test(normalized) ||
    /(\.min\.(js|css)|\.pb\.go|\.g\.dart|_generated\.go|\.generated\.(ts|js|cs))$/.test(
      base
    )
  );
}

interface IgnoreRule {
  negated: boolean;
  regex: RegExp;
  dirOnly: boolean;
}

function globToRegExp(pattern: string, nested = false): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(nested ? `(^|/)${source}` : `^${source}`);
}

/** Reads the root `.gitignore` (best effort) into simple glob rules. */
export function readGitignore(root: string): IgnoreRule[] {
  const file = path.join(root, ".gitignore");
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const body = (negated ? line.slice(1) : line).trim();
    if (!body) continue;
    const dirOnly = body.endsWith("/");
    const pattern = body.replace(/^\//, "").replace(/\/$/, "");
    if (!pattern) continue;
    rules.push({
      negated,
      dirOnly,
      // A pattern without a slash matches at any depth (`node_modules` ignores
      // every `node_modules` directory); one with a slash is root-relative.
      regex: globToRegExp(pattern, !pattern.includes("/")),
    });
  }
  return rules;
}

export function isIgnored(
  relativePath: string,
  rules: IgnoreRule[],
  isDirectory: boolean
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDirectory) {
      // A directory rule still ignores everything underneath it through the
      // parent-directory check the walker performs; a file line is not matched.
      continue;
    }
    if (rule.regex.test(relativePath)) ignored = !rule.negated;
  }
  return ignored;
}

export interface DiscoverOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  exclude?: string[];
}

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  /** Change time: a content rewrite updates it even when mtime is restored. */
  ctimeMs: number;
}

function gitFileList(root: string): string[] | null {
  const inWorkTree = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
  });
  if (inWorkTree.status !== 0) return null;
  const listed = spawnSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (listed.status !== 0) return null;
  return listed.stdout.split("\0").filter(Boolean);
}

/**
 * Lists indexable files. In a Git work tree the list comes from `git ls-files`
 * (tracked + untracked, minus everything ignored), which is exact, fast and
 * works for linked worktrees. Otherwise the walker honours `.gitignore` itself,
 * so a non-Git project is not forced to index build output.
 */
export function discoverFiles(
  root: string,
  options: DiscoverOptions = {}
): { files: DiscoveredFile[]; truncated: boolean; skipped: number } {
  const maxFiles = options.maxFiles ?? 50_000;
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  const excluded = new Set([
    ...DEFAULT_EXCLUDED_DIRS,
    ...(options.exclude ?? []),
  ]);
  const files: DiscoveredFile[] = [];
  let skipped = 0;
  let truncated = false;

  const accept = (relativePath: string): void => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    const language = detectLanguage(relativePath);
    if (!language) return;
    const absolutePath = path.join(root, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size > maxFileBytes) {
      skipped += 1;
      return;
    }
    files.push({
      absolutePath,
      relativePath: normalizePath(relativePath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    });
  };

  const gitFiles = gitFileList(root);
  if (gitFiles) {
    for (const relativePath of gitFiles) accept(relativePath);
    return { files, truncated, skipped };
  }

  const rules = readGitignore(root);
  const walk = (dir: string, depth: number): void => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = normalizePath(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (depth > 20) continue;
        if (excluded.has(entry.name)) continue;
        if (isIgnored(relative, rules, true)) continue;
        walk(absolute, depth + 1);
      } else if (entry.isFile()) {
        if (isIgnored(relative, rules, false)) continue;
        accept(relative);
      }
    }
  };
  walk(root, 0);
  return { files, truncated, skipped };
}

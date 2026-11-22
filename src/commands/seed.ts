/**
 * `muninn seed` — deterministic project bootstrap.
 *
 * A new project starts with no memory, so the first session would otherwise have
 * to read the repository. `seed` turns the repository's own structured knowledge
 * into observations: the README overview, the build/verification commands, a
 * language and directory map, the agent conventions, and every ADR. It is
 * deterministic and idempotent (stable ids + upsert), and it never invents facts:
 * every record is an extract of a file the project already ships.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import chalk from "chalk";
import {
  MemoryService,
  type ObservationCategory,
} from "../service/memory-service.js";
import { resolveProjectContext } from "../project/identity.js";
import { plural } from "../util/plural.js";

const SEED_AGENT = "muninn-seed";
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ADRS = 50;
const MAX_README_CHARS = 1_800;
const MAX_ADR_CHARS = 3_000;
const MAX_CONVENTIONS_CHARS = 1_500;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".muninn",
  ".huginn",
  ".harness",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "env",
  ".next",
  ".nuxt",
  "vendor",
  "Pods",
  ".cache",
  "coverage",
  "__pycache__",
  ".gradle",
  ".idea",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".c": "C",
  ".h": "C/C++ header",
  ".cpp": "C++",
  ".cc": "C++",
  ".cxx": "C++",
  ".hpp": "C++",
  ".cs": "C#",
  ".rb": "Ruby",
  ".php": "PHP",
  ".swift": "Swift",
  ".dart": "Dart",
  ".scala": "Scala",
  ".lua": "Lua",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
  ".sql": "SQL",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".astro": "Astro",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".hs": "Haskell",
  ".clj": "Clojure",
  ".zig": "Zig",
  ".nim": "Nim",
  ".r": "R",
  ".jl": "Julia",
  ".pl": "Perl",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "CSS",
  ".md": "Markdown",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".toml": "TOML",
};

export interface SeedRecord {
  key: string;
  category: ObservationCategory;
  title: string;
  content: string;
  topicKey?: string;
  files?: string[];
}

export interface SeedResult {
  written: number;
  skipped: number;
  records: Array<{ key: string; title: string; category: string; chars: number }>;
}

export function printSeedUsage(): void {
  console.log(`muninn seed — bootstrap project memory from the repository itself

Usage:
  muninn seed [--project <path>] [--dry-run] [--json]

Reads README, AGENTS.md, ADR files, package.json/Makefile/justfile and the
directory tree, then writes deterministic observations (overview, commands,
architecture map, conventions, decisions). Re-running refreshes them in place:
the ids are stable and the write is an upsert.

It never invents facts and never calls a model: every record is an extract.
`);
}

function readBounded(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function firstExisting(root: string, names: string[]): string | null {
  for (const name of names) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[>#]+\s?/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function summarizeReadme(root: string): string | null {
  const file = firstExisting(root, [
    "README.md",
    "README.mdx",
    "readme.md",
    "README.rst",
    "README.txt",
  ]);
  if (!file) return null;
  const raw = readBounded(file);
  if (!raw) return null;
  const text = stripMarkdown(raw);
  // Skip the leading title, then keep the first meaningful block(s).
  const withoutTitle = text.replace(/^[^\n]*\n+/, "");
  const trimmed = withoutTitle.slice(0, MAX_README_CHARS).trim();
  return trimmed.length >= 40 ? trimmed : null;
}

function readAgentConventions(root: string): string | null {
  const file = firstExisting(root, ["AGENTS.md", "CLAUDE.md", ".agents.md"]);
  if (!file) return null;
  const raw = readBounded(file);
  if (!raw) return null;
  const lines = raw.split("\n");
  const bullets: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-*]\s+/.test(trimmed)) {
      const bullet = trimmed.replace(/^[-*]\s+/, "").trim();
      if (bullet.length >= 8 && !bullets.includes(bullet)) bullets.push(bullet);
    }
    if (bullets.join("\n").length > MAX_CONVENTIONS_CHARS) break;
  }
  if (bullets.length === 0) return null;
  return bullets.join("\n").slice(0, MAX_CONVENTIONS_CHARS);
}

function collectCommands(root: string): string[] {
  const commands: string[] = [];
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        commands.push(`- \`npm run ${name}\` — ${command}`);
      }
    } catch {
      // A malformed manifest is reported by the project itself, not by Muninn.
    }
  }
  for (const [file, prefix] of [
    ["Makefile", "make"],
    ["makefile", "make"],
    ["justfile", "just"],
  ] as const) {
    const raw = readBounded(path.join(root, file));
    if (!raw) continue;
    const targets = new Set<string>();
    for (const line of raw.split("\n")) {
      const match = line.match(/^([A-Za-z0-9_.-]+)\s*:(?!=)/);
      if (match) targets.add(match[1]);
    }
    for (const target of [...targets].sort()) {
      commands.push(`- \`${prefix} ${target}\``);
    }
  }
  for (const [file, run] of [
    ["Cargo.toml", ["cargo build", "cargo test"]],
    ["pyproject.toml", ["pytest"]],
    ["go.mod", ["go build ./...", "go test ./..."]],
  ] as const) {
    if (fs.existsSync(path.join(root, file))) {
      for (const command of run) commands.push(`- \`${command}\``);
    }
  }
  return [...new Set(commands)];
}

interface TreeSummary {
  directories: Array<{ name: string; files: number }>;
  totalFiles: number;
  languages: Array<{ language: string; files: number }>;
}

function summarizeTree(root: string): TreeSummary {
  const languages = new Map<string, number>();
  let totalFiles = 0;
  const directories: Array<{ name: string; files: number }> = [];

  function walk(dir: string, depth: number, budget: { remaining: number }): number {
    let files = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (budget.remaining <= 0) break;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        files += walk(path.join(dir, entry.name), depth + 1, budget);
        continue;
      }
      if (!entry.isFile()) continue;
      budget.remaining -= 1;
      files += 1;
      totalFiles += 1;
      const language = LANGUAGE_BY_EXT[path.extname(entry.name).toLowerCase()];
      if (language) languages.set(language, (languages.get(language) ?? 0) + 1);
    }
    return files;
  }

  let topEntries: fs.Dirent[] = [];
  try {
    topEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    topEntries = [];
  }
  for (const entry of topEntries) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
    const count = walk(path.join(root, entry.name), 1, { remaining: 25_000 });
    directories.push({ name: entry.name, files: count });
  }
  directories.sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
  const languageRows = [...languages.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));

  return {
    directories: directories.slice(0, 25),
    totalFiles,
    languages: languageRows.slice(0, 12),
  };
}

interface AdrRecord {
  key: string;
  title: string;
  content: string;
}

function extractAdrFile(raw: string, source: string): AdrRecord[] {
  const records: AdrRecord[] = [];
  const headingPattern = /^##\s+(ADR[-\s]?\d+[^\n]*)$/gim;
  const matches = [...raw.matchAll(headingPattern)];
  if (matches.length === 0) return records;
  for (let i = 0; i < matches.length && records.length < MAX_ADRS; i++) {
    const match = matches[i];
    const start = match.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? raw.length) : raw.length;
    const title = match[1].trim();
    const body = raw
      .slice(start + match[0].length, end)
      .replace(/^\s*\n/, "")
      .trim();
    const keyMatch = title.match(/ADR[-\s]?(\d+)/i);
    records.push({
      key: `adr-${keyMatch ? keyMatch[1] : records.length + 1}`,
      title,
      content: [`Source: \`${source}\``, body.slice(0, MAX_ADR_CHARS)]
        .filter(Boolean)
        .join("\n\n"),
    });
  }
  return records;
}

function collectAdrs(root: string): AdrRecord[] {
  const files: string[] = [];
  for (const candidate of ["ADR.md", "adr.md", "docs/ADR.md", "docs/adr.md"]) {
    const full = path.join(root, candidate);
    if (fs.existsSync(full)) files.push(full);
  }
  const adrDirs = ["docs/adr", "adr", "docs/decisions"];
  for (const dir of adrDirs) {
    const full = path.join(root, dir);
    try {
      for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(path.join(full, entry.name));
        }
      }
    } catch {
      // Directory does not exist.
    }
  }
  const records: AdrRecord[] = [];
  for (const file of [...new Set(files)]) {
    if (records.length >= MAX_ADRS) break;
    const raw = readBounded(file);
    if (!raw) continue;
    const relative = path.relative(root, file).split(path.sep).join("/");
    records.push(...extractAdrFile(raw, relative));
  }
  return records.slice(0, MAX_ADRS);
}

function seedId(projectId: string, key: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${projectId}:${key}`)
    .digest("hex")
    .slice(0, 32);
  return `seed-${digest}`;
}

export function buildSeedRecords(root: string, projectId: string): SeedRecord[] {
  const records: SeedRecord[] = [];
  const name = path.basename(root) || "project";

  const overview = summarizeReadme(root);
  if (overview) {
    records.push({
      key: "overview",
      category: "discovery",
      title: `${name}: what this project is`,
      content: overview,
      topicKey: "seed:overview",
      files: ["README.md"],
    });
  }

  const commands = collectCommands(root);
  if (commands.length > 0) {
    records.push({
      key: "commands",
      category: "convention",
      title: "Build, test and verification commands",
      content: commands.join("\n"),
      topicKey: "seed:commands",
    });
  }

  const tree = summarizeTree(root);
  if (tree.totalFiles > 0) {
    const directoryLines = tree.directories
      .map((entry) => `- \`${entry.name}/\` — ${entry.files} files`)
      .join("\n");
    const languageLines = tree.languages
      .map((entry) => `${entry.language}: ${entry.files}`)
      .join(", ");
    records.push({
      key: "architecture",
      category: "architecture",
      title: "Repository map and languages",
      content: [
        `Root: \`${root}\``,
        `Indexable files: ${tree.totalFiles}`,
        languageLines ? `Languages by file count: ${languageLines}` : "",
        directoryLines ? `Top-level directories:\n${directoryLines}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      topicKey: "seed:architecture",
    });
  }

  const conventions = readAgentConventions(root);
  if (conventions) {
    records.push({
      key: "conventions",
      category: "convention",
      title: "Agent conventions and invariants",
      content: conventions,
      topicKey: "seed:conventions",
      files: ["AGENTS.md"],
    });
  }

  for (const adr of collectAdrs(root)) {
    records.push({
      key: adr.key,
      category: "decision",
      title: adr.title,
      content: adr.content,
      topicKey: `seed:${adr.key}`,
    });
  }

  return records.map((record) => ({ ...record }));
}

export function applySeedRecords(
  service: MemoryService,
  records: SeedRecord[]
): SeedResult {
  const projectId = service.currentProject.id;
  let written = 0;
  for (const record of records) {
    service.upsertObservation({
      id: seedId(projectId, record.key),
      category: record.category,
      title: record.title,
      content: record.content,
      topicKey: record.topicKey ?? null,
      agent: SEED_AGENT,
      files: record.files ?? null,
    });
    written += 1;
  }
  return {
    written,
    skipped: 0,
    records: records.map((record) => ({
      key: record.key,
      title: record.title,
      category: record.category,
      chars: record.content.length,
    })),
  };
}

export async function handleSeedCommand(
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  if (args["--help"] || args["-h"]) {
    printSeedUsage();
    return;
  }
  const dbPath = typeof args["--db"] === "string" ? args["--db"] : undefined;
  const projectRoot =
    typeof args["--project"] === "string" ? args["--project"] : undefined;
  const dryRun = Boolean(args["--dry-run"]);
  const json = Boolean(args["--json"]);
  const context = resolveProjectContext({
    explicitRoot: projectRoot ?? process.cwd(),
  });
  const service = new MemoryService({ dbPath, projectRoot: context.rootPath });
  try {
    const records = buildSeedRecords(
      service.currentProject.root_path,
      service.currentProject.id
    );
    if (records.length === 0) {
      console.log("Nothing to seed: no README, ADR, manifest or conventions found.");
      return;
    }
    if (dryRun) {
      if (json) {
        console.log(JSON.stringify(records, null, 2));
        return;
      }
      console.log(chalk.bold(`Would seed ${plural(records.length, "record")}:`));
      for (const record of records) {
        console.log(`- [${record.category}] ${record.title} (${record.content.length} chars)`);
      }
      console.log(chalk.dim("\nDry run: nothing was written."));
      return;
    }
    const result = applySeedRecords(service, records);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      chalk.green(`✔ Seeded ${plural(result.written, "record")} into ${service.currentProject.name}`)
    );
    for (const record of result.records) {
      console.log(`- [${record.category}] ${record.title} (${record.chars} chars)`);
    }
    console.log(
      chalk.dim(
        "\nRe-run any time: the ids are stable, so records are refreshed in place."
      )
    );
  } finally {
    service.close?.();
  }
}

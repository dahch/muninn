/**
 * Incremental code-graph indexing.
 *
 * The graph is derived state: files, symbols and edges can always be rebuilt
 * from the source. Indexing is therefore content-addressed (a hash per file),
 * incremental (only changed files are parsed), transactional (a failed run
 * leaves the previous graph intact) and pruned (deleted files and dangling
 * edges are removed).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { symbolSearchTokens } from "../util/text.js";
import type Database from "better-sqlite3";
import {
  detectLanguage,
  discoverFiles,
  isGeneratedFile,
  isTestFile,
  normalizePath,
} from "./languages.js";
import { extractFile } from "./extractor.js";
import { extractWithTreeSitter, treeSitterAvailable } from "./treesitter.js";
import type {
  CodeEdgeKind,
  EdgeConfidence,
  EdgeResolution,
  ExtractedEdge,
  ExtractedFile,
  GraphServiceLike,
  IndexOptions,
  IndexSummary,
} from "./types.js";

export const INDEXER_VERSION = 2;

const SOURCE_EXTENSION_CANDIDATES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".astro",
  ".py",
  ".pyi",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".scala",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".dart",
  ".lua",
  ".sh",
];

/** Module entry file names per ecosystem, tried when a specifier names a folder. */
const INDEX_BASENAMES = ["index", "__init__", "mod", "main"];

function sha(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileId(projectId: string, indexRoot: string, filePath: string): string {
  return `cf-${sha(`${projectId}|${indexRoot}|${filePath}`).slice(0, 32)}`;
}

function symbolId(projectId: string, qualifiedName: string): string {
  return `cs-${sha(`${projectId}|${qualifiedName}`).slice(0, 32)}`;
}

function edgeId(
  projectId: string,
  srcId: string | null,
  dstId: string | null,
  kind: string,
  line: number | null,
  targetName: string | null
): string {
  return `ce-${sha(`${projectId}|${srcId ?? ""}|${dstId ?? ""}|${kind}|${line ?? 0}|${targetName ?? ""}`).slice(0, 32)}`;
}

export interface IndexStatus {
  indexRoot: string;
  files: number;
  symbols: number;
  edges: number;
  languages: Array<{ language: string; files: number }>;
  indexedAt: string | null;
  indexerVersion: number | null;
  exists: boolean;
}

function indexRootFor(service: GraphServiceLike, options?: IndexOptions): string {
  return normalizePath(
    path.resolve(options?.projectRoot ?? service.currentProject.root_path)
  );
}

export function getIndexStatus(
  service: GraphServiceLike,
  options?: IndexOptions
): IndexStatus {
  const db = service.db;
  const projectId = service.currentProject.id;
  const indexRoot = indexRootFor(service, options);
  const files = db
    .prepare<[string, string], { count: number }>(
      "SELECT count(*) AS count FROM code_files WHERE project_id = ? AND index_root = ?"
    )
    .get(projectId, indexRoot)?.count ?? 0;
  const symbols = db
    .prepare<[string], { count: number }>(
      "SELECT count(*) AS count FROM code_symbols WHERE project_id = ?"
    )
    .get(projectId)?.count ?? 0;
  const edges = db
    .prepare<[string], { count: number }>(
      "SELECT count(*) AS count FROM code_edges WHERE project_id = ?"
    )
    .get(projectId)?.count ?? 0;
  const languages = db
    .prepare<[string, string], { language: string; files: number }>(
      `SELECT language, count(*) AS files
       FROM code_files WHERE project_id = ? AND index_root = ?
       GROUP BY language ORDER BY files DESC, language ASC`
    )
    .all(projectId, indexRoot);
  const state = db
    .prepare<
      [string, string],
      { indexed_at: string | null; indexer_version: number | null }
    >(
      `SELECT max(indexed_at) AS indexed_at, max(indexer_version) AS indexer_version
       FROM code_index_state WHERE project_id = ? AND index_root = ?`
    )
    .get(projectId, indexRoot);
  return {
    indexRoot,
    files,
    symbols,
    edges,
    languages,
    indexedAt: state?.indexed_at ?? null,
    indexerVersion: state?.indexer_version ?? null,
    exists: files > 0,
  };
}

interface FileStateRow {
  path: string;
  content_hash: string;
  mtime_ms: number | null;
  ctime_ms: number | null;
  bytes: number | null;
}

interface SymbolRow {
  id: string;
  file_id: string;
  name: string;
  qualified_name: string;
  kind: string;
}

function resolveCandidates(
  targetFile: string,
  fileIdByPath: Map<string, string>
): string | null {
  const base = targetFile.replace(/\/$/, "");
  const withoutExtension = base.replace(/\.[a-z0-9]+$/i, "");
  const candidates = new Set<string>();
  for (const extension of SOURCE_EXTENSION_CANDIDATES) {
    candidates.add(base + extension);
    candidates.add(withoutExtension + extension);
    for (const basename of INDEX_BASENAMES) {
      candidates.add(`${base}/${basename}${extension}`);
      candidates.add(`${withoutExtension}/${basename}${extension}`);
    }
  }
  for (const candidate of candidates) {
    const id = fileIdByPath.get(normalizePath(candidate));
    if (id) return id;
  }
  return null;
}

/** HEAD commit of a Git worktree, or `null` outside Git. */
export function gitHeadSha(root: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/** Indexable paths that `git status --porcelain` reports as dirty. */
function dirtyGitFiles(root: string): string[] | null {
  const result = spawnSync("git", ["status", "--porcelain", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  const entries = result.stdout.split("\0").filter(Boolean);
  const dirty: string[] = [];
  for (const entry of entries) {
    const candidate = entry.slice(3).trim();
    if (!candidate) continue;
    const target = candidate.includes(" -> ")
      ? candidate.split(" -> ").pop()!
      : candidate;
    const normalized = normalizePath(target.replace(/^"|"$/g, ""));
    if (detectLanguage(normalized)) dirty.push(normalized);
  }
  return dirty;
}

interface StoredFingerprint {
  path: string;
  mtime_ms: number | null;
  ctime_ms: number | null;
  bytes: number | null;
}

/** Count stored files whose current stat no longer matches the indexed one. */
function fingerprintDrift(
  root: string,
  rows: StoredFingerprint[],
  paths?: string[]
): number {
  const wanted = paths ? new Set(paths) : null;
  let drift = 0;
  for (const row of rows) {
    if (wanted && !wanted.has(row.path)) continue;
    try {
      const stat = fs.statSync(path.join(root, row.path));
      if (
        Math.floor(stat.mtimeMs) !== row.mtime_ms ||
        Math.floor(stat.ctimeMs) !== row.ctime_ms ||
        stat.size !== row.bytes
      ) {
        drift += 1;
      }
    } catch {
      drift += 1;
    }
  }
  return drift;
}

export interface IndexFreshness {
  fresh: boolean;
  reason: string;
  indexRoot: string;
  files: number;
  staleFiles: number;
  indexedAt: string | null;
  ageSeconds: number | null;
  indexerVersion: number | null;
  headSha: string | null;
  indexedHeadSha: string | null;
}

/**
 * Cheap, bounded freshness check: a stored root fingerprint plus `git status`,
 * never a full rescan. A non-Git project falls back to stat-ing the indexed
 * files, which is linear in the number of already-indexed files only.
 */
export function checkIndexFreshness(
  service: GraphServiceLike,
  options?: IndexOptions
): IndexFreshness {
  const db = service.db;
  const projectId = service.currentProject.id;
  const root = path.resolve(options?.projectRoot ?? service.currentProject.root_path);
  const indexRoot = normalizePath(root);
  const status = getIndexStatus(service, { ...options, projectRoot: root });
  let row:
    | {
        head_sha: string | null;
        indexed_at: string | null;
        indexer_version: number | null;
        files: number;
      }
    | undefined;
  try {
    row = db
      .prepare<
        [string, string],
        {
          head_sha: string | null;
          indexed_at: string | null;
          indexer_version: number | null;
          files: number;
        }
      >(
        `SELECT head_sha, indexed_at, indexer_version, files
         FROM code_index_roots WHERE project_id = ? AND index_root = ?`
      )
      .get(projectId, indexRoot);
  } catch {
    // A database created before v5 has no fingerprint table yet; the migration
    // creates it on the next writable open. Report staleness from file state.
    row = undefined;
  }
  const headSha = gitHeadSha(root);
  const indexedAt = row?.indexed_at ?? status.indexedAt;
  const ageSeconds = indexedAt
    ? Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(indexedAt.replace(" ", "T") + "Z").getTime()) / 1000
        )
      )
    : null;
  const base = {
    indexRoot,
    files: status.files,
    staleFiles: 0,
    indexedAt,
    ageSeconds: Number.isFinite(ageSeconds as number) ? ageSeconds : null,
    indexerVersion: row?.indexer_version ?? status.indexerVersion,
    headSha,
    indexedHeadSha: row?.head_sha ?? null,
  };

  if (status.files === 0) {
    return { ...base, fresh: false, reason: "the code graph is empty" };
  }
  if (base.indexerVersion !== INDEXER_VERSION) {
    return {
      ...base,
      fresh: false,
      reason: `the graph was built by indexer v${base.indexerVersion ?? 0}, current is v${INDEXER_VERSION}`,
    };
  }
  const rows = db
    .prepare<[string, string], StoredFingerprint>(
      `SELECT path, mtime_ms, ctime_ms, bytes FROM code_files
       WHERE project_id = ? AND index_root = ?`
    )
    .all(projectId, indexRoot);
  const headMoved = Boolean(row?.head_sha && headSha && row.head_sha !== headSha);
  const dirty = dirtyGitFiles(root);

  let stale = 0;
  if (dirty !== null) {
    // A dirty worktree is not stale by itself: files edited after the last index
    // are exactly what the previous run indexed. Compare their fingerprints, and
    // treat an unindexed dirty path as a new file.
    const indexed = new Set(rows.map((entry) => entry.path));
    const unknown = dirty.filter((entry) => !indexed.has(entry));
    stale = fingerprintDrift(root, rows, dirty) + unknown.length;
    if (stale === 0 && headMoved) {
      stale = fingerprintDrift(root, rows);
    }
  } else {
    stale = fingerprintDrift(root, rows);
  }

  return {
    ...base,
    staleFiles: stale,
    fresh: stale === 0,
    reason:
      stale === 0
        ? "up to date"
        : `${stale} file(s) changed since the last index`,
  };
}

export async function indexProject(
  service: GraphServiceLike,
  options: IndexOptions = {}
): Promise<IndexSummary> {
  const startedAt = Date.now();
  const db = service.db;
  const projectId = service.currentProject.id;
  const root = path.resolve(options.projectRoot ?? service.currentProject.root_path);
  const indexRoot = normalizePath(root);
  const mode = options.mode ?? "changed";
  const discovered = discoverFiles(root, {
    maxFiles: options.maxFiles,
    maxFileBytes: options.maxFileBytes,
    exclude: options.exclude,
  });

  const existingRows = db
    .prepare<[string, string], FileStateRow>(
      `SELECT path, content_hash, mtime_ms, ctime_ms, bytes
       FROM code_files WHERE project_id = ? AND index_root = ?`
    )
    .all(projectId, indexRoot);
  const existingByPath = new Map(existingRows.map((row) => [row.path, row]));
  const stateVersions = new Map(
    db
      .prepare<[string, string], { path: string; indexer_version: number | null }>(
        `SELECT path, indexer_version FROM code_index_state
         WHERE project_id = ? AND index_root = ?`
      )
      .all(projectId, indexRoot)
      .map((row) => [row.path, row.indexer_version])
  );

  const discoveredPaths = new Set(discovered.files.map((file) => file.relativePath));
  const removed = existingRows
    .map((row) => row.path)
    .filter((existingPath) => !discoveredPaths.has(existingPath));

  const toParse: Array<{
    relativePath: string;
    absolutePath: string;
    hash: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    content: string;
  }> = [];
  // Files whose bytes did not change but whose fingerprint is stale: only the
  // fast-path metadata is refreshed, no parse is needed.
  const metadataOnly: Array<{
    path: string;
    mtimeMs: number;
    ctimeMs: number;
    size: number;
  }> = [];
  for (const file of discovered.files) {
    const existing = existingByPath.get(file.relativePath);
    const stateVersion = stateVersions.get(file.relativePath);
    const versionMatches =
      stateVersion === undefined || stateVersion === INDEXER_VERSION;
    const mtimeMs = Math.floor(file.mtimeMs);
    const ctimeMs = Math.floor(file.ctimeMs);
    const fastUnchanged =
      mode !== "full" &&
      versionMatches &&
      existing !== undefined &&
      existing.mtime_ms === mtimeMs &&
      existing.ctime_ms === ctimeMs &&
      existing.bytes === file.size;
    if (fastUnchanged) continue;
    let content: string;
    try {
      content = fs.readFileSync(file.absolutePath, "utf8");
    } catch {
      continue;
    }
    const hash = sha(content);
    const sameBytes =
      mode !== "full" &&
      versionMatches &&
      existing !== undefined &&
      existing.content_hash === hash;
    if (sameBytes) {
      metadataOnly.push({
        path: file.relativePath,
        mtimeMs,
        ctimeMs,
        size: file.size,
      });
      continue;
    }
    toParse.push({
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      hash,
      size: file.size,
      mtimeMs,
      ctimeMs,
      content,
    });
  }

  // Parsing happens outside the transaction: a syntax error in one file must not
  // roll back the rest, and the transaction stays short.
  const parsed: Array<{
    relativePath: string;
    hash: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    extracted: ExtractedFile;
  }> = [];
  const preciseAvailable = await treeSitterAvailable();
  let preciseFiles = 0;
  for (const file of toParse) {
    const content = file.content;
    try {
      const precise = preciseAvailable
        ? await extractWithTreeSitter(file.relativePath, content)
        : null;
      if (precise) preciseFiles += 1;
      parsed.push({
        ...file,
        extracted: precise ?? extractFile(file.relativePath, content),
      });
    } catch {
      // A file the extractor cannot handle is skipped, not fatal.
    }
  }

  let changedFiles = 0;
  let removedFiles = 0;
  let symbolCount = 0;
  let edgeCount = 0;

  db.transaction(() => {
    for (const entry of metadataOnly) {
      db.prepare(
        `UPDATE code_files
         SET mtime_ms = ?, ctime_ms = ?, bytes = ?, indexed_at = CURRENT_TIMESTAMP
         WHERE project_id = ? AND index_root = ? AND path = ?`
      ).run(
        entry.mtimeMs,
        entry.ctimeMs,
        entry.size,
        projectId,
        indexRoot,
        entry.path
      );
    }

    const deleteEdgesForIds = (ids: string[]): void => {
      if (ids.length === 0) return;
      for (const id of ids) {
        db.prepare("DELETE FROM code_edges WHERE src_id = ? OR dst_id = ?").run(id, id);
      }
    };

    const selectFileSymbols = db.prepare<[string], { id: string }>(
      "SELECT id FROM code_symbols WHERE file_id = ?"
    );

    for (const removedPath of removed) {
      const row = existingByPath.get(removedPath);
      if (!row) continue;
      const id = fileId(projectId, indexRoot, removedPath);
      const symbolIds = selectFileSymbols.all(id).map((symbol) => symbol.id);
      deleteEdgesForIds([id, ...symbolIds]);
      db.prepare("DELETE FROM code_symbols WHERE file_id = ?").run(id);
      db.prepare("DELETE FROM code_files WHERE id = ?").run(id);
      db.prepare(
        "DELETE FROM code_index_state WHERE project_id = ? AND index_root = ? AND path = ?"
      ).run(projectId, indexRoot, removedPath);
      removedFiles += 1;
    }

    // Resolve maps are rebuilt from the database after the file rows and symbols
    // for the changed files are written.
    const insertFile = db.prepare(
      `INSERT OR REPLACE INTO code_files
         (id, project_id, index_root, path, language, content_hash, bytes, lines,
          mtime_ms, ctime_ms, is_test, is_generated, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    );
    const insertSymbol = db.prepare(
      `INSERT OR REPLACE INTO code_symbols
         (id, project_id, file_id, name, qualified_name, kind, start_line, end_line,
          start_col, signature, doc, visibility, is_exported, parent_symbol_id,
          language, search_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertEdge = db.prepare(
      `INSERT OR IGNORE INTO code_edges
         (id, project_id, src_id, dst_id, kind, line, confidence, resolution, target_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertState = db.prepare(
      `INSERT OR REPLACE INTO code_index_state
         (project_id, index_root, path, hash, indexed_at, indexer_version)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`
    );
    const selectFileSymbolsForFile = selectFileSymbols;

    // 1. Replace rows for changed files.
    const parseByPath = new Map(parsed.map((entry) => [entry.relativePath, entry]));
    for (const entry of parsed) {
      const id = fileId(projectId, indexRoot, entry.relativePath);
      const previousSymbolIds = selectFileSymbolsForFile
        .all(id)
        .map((symbol) => symbol.id);
      deleteEdgesForIds([id, ...previousSymbolIds]);
      db.prepare("DELETE FROM code_symbols WHERE file_id = ?").run(id);
      db.prepare("DELETE FROM code_files WHERE id = ?").run(id);

      const language = entry.extracted.language || detectLanguage(entry.relativePath) || "unknown";
      insertFile.run(
        id,
        projectId,
        indexRoot,
        entry.relativePath,
        language,
        entry.hash,
        entry.size,
        null,
        entry.mtimeMs,
        entry.ctimeMs,
        isTestFile(entry.relativePath) ? 1 : 0,
        isGeneratedFile(entry.relativePath) ? 1 : 0
      );
      insertState.run(projectId, indexRoot, entry.relativePath, entry.hash, INDEXER_VERSION);

      const qualifiedToId = new Map<string, string>();
      for (const symbol of entry.extracted.symbols) {
        const qualified = symbol.qualified ?? `${entry.relativePath}::${symbol.name}`;
        const id2 = symbolId(projectId, qualified);
        qualifiedToId.set(qualified, id2);
        insertSymbol.run(
          id2,
          projectId,
          id,
          symbol.name,
          qualified,
          symbol.kind,
          symbol.startLine,
          Math.max(symbol.endLine, symbol.startLine),
          symbol.startCol ?? null,
          symbol.signature ?? null,
          symbol.doc ?? null,
          symbol.visibility ?? null,
          symbol.isExported ? 1 : 0,
          null,
          language,
          symbolSearchTokens(symbol.name, qualified, symbol.signature ?? null)
        );
        symbolCount += 1;
      }
      // Contains edges are inserted here so the file has a shape even when the
      // resolution pass below has nothing else to add.
      for (const symbol of entry.extracted.symbols) {
        const qualified = symbol.qualified ?? `${entry.relativePath}::${symbol.name}`;
        insertEdge.run(
          edgeId(projectId, id, qualifiedToId.get(qualified) ?? null, "contains", symbol.startLine, null),
          projectId,
          id,
          qualifiedToId.get(qualified) ?? null,
          "contains",
          symbol.startLine,
          "exact",
          "resolved",
          null
        );
        edgeCount += 1;
      }
    }

    // 2. Rebuild the resolution maps from the database.
    const allFiles = db
      .prepare<[string, string], { id: string; path: string }>(
        "SELECT id, path FROM code_files WHERE project_id = ? AND index_root = ?"
      )
      .all(projectId, indexRoot);
    const fileIdByPath = new Map(allFiles.map((file) => [file.path, file.id]));
    const allSymbols = db
      .prepare<[string], SymbolRow>(
        `SELECT id, file_id, name, qualified_name, kind
         FROM code_symbols WHERE project_id = ?`
      )
      .all(projectId);
    const symbolIdByQualified = new Map(allSymbols.map((row) => [row.qualified_name, row.id]));
    const symbolByFileAndName = new Map<string, SymbolRow>();
    // `null` means the name exists in more than one place: ambiguous.
    const uniqueSymbolByName = new Map<string, SymbolRow | null>();
    for (const row of allSymbols) {
      const key = `${row.file_id}\u0000${row.name}`;
      if (!symbolByFileAndName.has(key)) symbolByFileAndName.set(key, row);
      if (uniqueSymbolByName.has(row.name)) uniqueSymbolByName.set(row.name, null);
      else uniqueSymbolByName.set(row.name, row);
    }

    // 3. Resolve the raw edges of every changed file.
    for (const entry of parsed) {
      const sourceFileId = fileIdByPath.get(entry.relativePath) ?? null;
      for (const raw of entry.extracted.edges) {
        if (raw.kind === "contains") continue;
        let srcId: string | null = null;
        if (raw.src === entry.relativePath) srcId = sourceFileId;
        else srcId = symbolIdByQualified.get(raw.src) ?? sourceFileId;

        let dstId: string | null = null;
        let resolution: EdgeResolution = "unresolved";
        let confidence: EdgeConfidence = raw.confidence ?? "heuristic";

        if (raw.targetFile) {
          dstId = resolveCandidates(raw.targetFile, fileIdByPath);
          if (dstId) {
            resolution = "resolved";
            confidence = raw.confidence ?? "exact";
          } else {
            resolution = "external";
          }
        }
        if (!dstId && (raw.kind === "calls" || raw.kind === "references" || raw.kind === "extends" || raw.kind === "implements")) {
          const sameFile = sourceFileId
            ? symbolByFileAndName.get(`${sourceFileId}\u0000${raw.target}`)
            : undefined;
          const unique = uniqueSymbolByName.get(raw.target) ?? undefined;
          const candidate = sameFile ?? unique;
          if (candidate) {
            dstId = candidate.id;
            resolution = "resolved";
            confidence = raw.confidence ?? "heuristic";
          } else if (uniqueSymbolByName.has(raw.target) && !unique) {
            resolution = "ambiguous";
          }
        }

        insertEdge.run(
          edgeId(projectId, srcId, dstId, raw.kind, raw.line ?? null, raw.target),
          projectId,
          srcId,
          dstId,
          raw.kind,
          raw.line ?? null,
          confidence,
          resolution,
          raw.target
        );
        edgeCount += 1;
      }
    }

    // 4. Remove edges whose endpoints no longer exist.
    db.prepare(
      `DELETE FROM code_edges
       WHERE project_id = ?
         AND ((src_id IS NOT NULL AND src_id NOT IN (SELECT id FROM code_files UNION SELECT id FROM code_symbols))
           OR (dst_id IS NOT NULL AND dst_id NOT IN (SELECT id FROM code_files UNION SELECT id FROM code_symbols)))`
    ).run(projectId);
    changedFiles = parsed.length;

    const totalFiles =
      db
        .prepare<[string, string], { count: number }>(
          "SELECT count(*) AS count FROM code_files WHERE project_id = ? AND index_root = ?"
        )
        .get(projectId, indexRoot)?.count ?? 0;
    db.prepare(
      `INSERT OR REPLACE INTO code_index_roots
         (project_id, index_root, head_sha, indexed_at, indexer_version, files)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`
    ).run(projectId, indexRoot, gitHeadSha(root), INDEXER_VERSION, totalFiles);
  })();

  return {
    indexedFiles: discovered.files.length,
    changedFiles,
    removedFiles,
    symbols: symbolCount,
    edges: edgeCount,
    preciseFiles,
    skippedFiles: discovered.skipped,
    truncated: discovered.truncated,
    durationMs: Date.now() - startedAt,
    indexRoot,
  };
}

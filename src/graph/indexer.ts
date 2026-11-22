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

export const INDEXER_VERSION = 1;

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
      `SELECT path, content_hash, mtime_ms, bytes
       FROM code_files WHERE project_id = ? AND index_root = ?`
    )
    .all(projectId, indexRoot);
  const existingByPath = new Map(existingRows.map((row) => [row.path, row]));

  const discoveredPaths = new Set(discovered.files.map((file) => file.relativePath));
  const removed = existingRows
    .map((row) => row.path)
    .filter((existingPath) => !discoveredPaths.has(existingPath));

  const toParse: Array<{ relativePath: string; absolutePath: string; hash: string; size: number; mtimeMs: number }> = [];
  for (const file of discovered.files) {
    const existing = existingByPath.get(file.relativePath);
    const unchanged =
      mode !== "full" &&
      existing &&
      existing.mtime_ms === Math.floor(file.mtimeMs) &&
      existing.bytes === file.size;
    if (unchanged) continue;
    let content: string;
    try {
      content = fs.readFileSync(file.absolutePath, "utf8");
    } catch {
      continue;
    }
    toParse.push({
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      hash: sha(content),
      size: file.size,
      mtimeMs: Math.floor(file.mtimeMs),
    });
  }

  // Parsing happens outside the transaction: a syntax error in one file must not
  // roll back the rest, and the transaction stays short.
  const parsed: Array<{ relativePath: string; hash: string; size: number; mtimeMs: number; extracted: ExtractedFile }> = [];
  const preciseAvailable = await treeSitterAvailable();
  let preciseFiles = 0;
  for (const file of toParse) {
    let content: string;
    try {
      content = fs.readFileSync(file.absolutePath, "utf8");
    } catch {
      continue;
    }
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
          mtime_ms, is_test, is_generated, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    );
    const insertSymbol = db.prepare(
      `INSERT OR REPLACE INTO code_symbols
         (id, project_id, file_id, name, qualified_name, kind, start_line, end_line,
          start_col, signature, doc, visibility, is_exported, parent_symbol_id, language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          language
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

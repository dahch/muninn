/**
 * Code-graph queries used by the CLI and the MCP tools.
 *
 * Every query is bounded (a node limit and a character budget), deterministic
 * (stable ordering) and database-only: the repository is never walked at query
 * time. Source text is read only for the symbols that were selected.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { CodeEdgeRow, CodeSymbolRow } from "./types.js";
import { symbolSearchTokens } from "../util/text.js";

export interface SymbolHit {
  symbol: CodeSymbolRow;
  file_path: string;
  score: number | null;
}

export interface GraphEdgeView {
  kind: string;
  line: number | null;
  confidence: string;
  resolution: string;
  target_name: string | null;
  symbol: (CodeSymbolRow & { file_path: string }) | null;
  file_path: string | null;
}

const MAX_EXPLORE_BUDGET = 20_000;

export function expandCodeQueryTokens(query: string): string[] {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && token.length < 80)
    .slice(0, 12);
  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    // Split camelCase/snake_case so "contract" reaches verifyTypeScriptContracts
    // through the symbol's search_tokens column.
    for (const part of symbolSearchTokens(token).split(" ")) {
      if (part.length > 1) expanded.add(part);
    }
  }
  return [...expanded].slice(0, 16);
}

/**
 * Build the FTS expression for code search. The conjunction of every token is
 * tried first by {@link searchSymbols}; this helper yields the OR fallback.
 */
export function sanitizeCodeQuery(query: string): string {
  return expandCodeQueryTokens(query)
    .map((token) => `"${token.replace(/"/g, "")}"*`)
    .join(" OR ");
}

export function searchSymbols(
  db: Database.Database,
  projectId: string,
  query: string,
  options: { limit?: number | null; kind?: string | null; language?: string | null } = {}
): SymbolHit[] {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 20), 1), 100);
  const tokens = expandCodeQueryTokens(query);
  const kindFilter = options.kind ? " AND s.kind = ?" : "";
  const languageFilter = options.language ? " AND s.language = ?" : "";

  const runFts = (ftsQuery: string): Array<CodeSymbolRow & { file_path: string; score: number }> => {
    const extra: Array<string | number> = [];
    if (options.kind) extra.push(options.kind);
    if (options.language) extra.push(options.language);
    return db
      .prepare<Array<string | number>, CodeSymbolRow & { file_path: string; score: number }>(
        `SELECT s.*, f.path AS file_path, bm25(code_symbols_fts, 8.0, 4.0, 1.0, 1.0, 3.0) AS score
         FROM code_symbols_fts
         JOIN code_symbols s ON s.rowid = code_symbols_fts.rowid
         JOIN code_files f ON f.id = s.file_id
         WHERE code_symbols_fts MATCH ? AND s.project_id = ?${kindFilter}${languageFilter}
         ORDER BY score ASC, s.qualified_name ASC
         LIMIT ?`
      )
      .all(ftsQuery, projectId, ...extra, limit);
  };

  if (tokens.length > 0) {
    // Conjunction first (precise), then the OR fallback only if it could not fill
    // the page. Prefix expansion makes morphological variants and subwords reach
    // the same symbol.
    const tiers = [
      tokens.map((token) => `"${token.replace(/"/g, "")}"*`).join(" "),
      tokens.map((token) => `"${token.replace(/"/g, "")}"*`).join(" OR "),
    ];
    const collected: Array<CodeSymbolRow & { file_path: string; score: number }> = [];
    const seen = new Set<string>();
    for (const ftsQuery of tiers) {
      if (collected.length >= limit) break;
      try {
        for (const row of runFts(ftsQuery)) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          collected.push(row);
          if (collected.length >= limit) break;
        }
      } catch {
        // Fall through to LIKE: a malformed FTS query must not break the tool.
      }
    }
    if (collected.length > 0) {
      return collected.map((row) => ({
        symbol: row,
        file_path: row.file_path,
        score: row.score,
      }));
    }
  }

  const like = `%${query.replace(/[%_]/g, (match) => `\\${match}`)}%`;
  return db
    .prepare<[string, string, string, string, number], CodeSymbolRow & { file_path: string }>(
      `SELECT s.*, f.path AS file_path
       FROM code_symbols s JOIN code_files f ON f.id = s.file_id
       WHERE s.project_id = ? AND (s.name LIKE ? ESCAPE '\\' OR s.qualified_name LIKE ? ESCAPE '\\')
       ORDER BY (s.name = ?) DESC, length(s.name) ASC, s.qualified_name ASC
       LIMIT ?`
    )
    .all(projectId, like, like, query, limit)
    .map((row) => ({ symbol: row, file_path: row.file_path, score: null }));
}

export function findSymbol(
  db: Database.Database,
  projectId: string,
  identifier: string
): (CodeSymbolRow & { file_path: string }) | null {
  const query = identifier.trim();
  if (!query) return null;
  const exact = db
    .prepare<[string, string], CodeSymbolRow & { file_path: string }>(
      `SELECT s.*, f.path AS file_path
       FROM code_symbols s JOIN code_files f ON f.id = s.file_id
       WHERE s.project_id = ? AND s.qualified_name = ?`
    )
    .get(projectId, query);
  if (exact) return exact;
  const byName = db
    .prepare<[string, string, string], CodeSymbolRow & { file_path: string }>(
      `SELECT s.*, f.path AS file_path
       FROM code_symbols s JOIN code_files f ON f.id = s.file_id
       WHERE s.project_id = ? AND (s.name = ? OR s.qualified_name LIKE '%::' || ?)
       ORDER BY length(s.qualified_name) ASC LIMIT 1`
    )
    .get(projectId, query, query);
  if (byName) return byName;
  return (
    db
      .prepare<[string, string], CodeSymbolRow & { file_path: string }>(
        `SELECT s.*, f.path AS file_path
         FROM code_symbols s JOIN code_files f ON f.id = s.file_id
         WHERE s.project_id = ? AND s.name LIKE ?
         ORDER BY length(s.name) ASC LIMIT 1`
      )
      .get(projectId, `%${query}%`) ?? null
  );
}

export function listFileSymbols(
  db: Database.Database,
  projectId: string,
  filePath: string
): Array<CodeSymbolRow & { file_path: string }> {
  return db
    .prepare<[string, string], CodeSymbolRow & { file_path: string }>(
      `SELECT s.*, f.path AS file_path
       FROM code_symbols s JOIN code_files f ON f.id = s.file_id
       WHERE s.project_id = ? AND f.path = ?
       ORDER BY s.start_line ASC, s.name ASC`
    )
    .all(projectId, filePath);
}

function symbolFileRow(
  db: Database.Database,
  id: string
): (CodeSymbolRow & { file_path: string }) | null {
  return (
    db
      .prepare<[string], CodeSymbolRow & { file_path: string }>(
        `SELECT s.*, f.path AS file_path
         FROM code_symbols s JOIN code_files f ON f.id = s.file_id
         WHERE s.id = ?`
      )
      .get(id) ?? null
  );
}

export function getEdges(
  db: Database.Database,
  projectId: string,
  symbolId: string,
  direction: "incoming" | "outgoing",
  options: { kinds?: string[]; limit?: number | null } = {}
): GraphEdgeView[] {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 500);
  const kinds = options.kinds ?? ["calls", "references", "extends", "implements", "imports"];
  const placeholders = kinds.map(() => "?").join(",");
  const column = direction === "incoming" ? "dst_id" : "src_id";
  const otherColumn = direction === "incoming" ? "src_id" : "dst_id";
  const rows = db
    .prepare<Array<string | number>, CodeEdgeRow>(
      `SELECT * FROM code_edges
       WHERE project_id = ? AND ${column} = ? AND kind IN (${placeholders})
       ORDER BY kind ASC, line ASC
       LIMIT ?`
    )
    .all(projectId, symbolId, ...kinds, limit);

  return rows.map((row) => {
    const otherId = (row as unknown as Record<string, string | null>)[otherColumn];
    const symbol = otherId ? symbolFileRow(db, otherId) : null;
    return {
      kind: row.kind,
      line: row.line,
      confidence: row.confidence,
      resolution: row.resolution,
      target_name: row.target_name,
      symbol,
      file_path: symbol?.file_path ?? null,
    };
  });
}

export function getImpact(
  db: Database.Database,
  projectId: string,
  symbolId: string,
  options: { depth?: number | null; limit?: number | null } = {}
): Array<{ depth: number; symbol: CodeSymbolRow & { file_path: string } }> {
  const maxDepth = Math.min(Math.max(Math.floor(options.depth ?? 2), 1), 3);
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
  const seen = new Set<string>([symbolId]);
  const result: Array<{ depth: number; symbol: CodeSymbolRow & { file_path: string } }> = [];
  let frontier = [symbolId];
  for (let depth = 1; depth <= maxDepth && result.length < limit; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const edges = getEdges(db, projectId, id, "incoming", {
        kinds: ["calls", "references", "extends", "implements"],
        limit: 200,
      });
      for (const edge of edges) {
        if (!edge.symbol || seen.has(edge.symbol.id)) continue;
        seen.add(edge.symbol.id);
        result.push({ depth, symbol: edge.symbol });
        next.push(edge.symbol.id);
        if (result.length >= limit) break;
      }
      if (result.length >= limit) break;
    }
    frontier = next;
  }
  return result;
}

export function getImplementations(
  db: Database.Database,
  projectId: string,
  symbolId: string,
  options: { limit?: number | null } = {}
): Array<CodeSymbolRow & { file_path: string }> {
  return getEdges(db, projectId, symbolId, "incoming", {
    kinds: ["extends", "implements"],
    limit: options.limit ?? 100,
  })
    .map((edge) => edge.symbol)
    .filter((symbol): symbol is CodeSymbolRow & { file_path: string } => Boolean(symbol));
}

export function getFileImports(
  db: Database.Database,
  projectId: string,
  filePath: string
): Array<{ path: string | null; target_name: string | null; resolution: string; line: number | null }> {
  return db
    .prepare<[string, string], { path: string | null; target_name: string | null; resolution: string; line: number | null }>(
      `SELECT dst.path AS path, e.target_name, e.resolution, e.line
       FROM code_edges e
       JOIN code_files src ON src.id = e.src_id
       LEFT JOIN code_files dst ON dst.id = e.dst_id
       WHERE e.project_id = ? AND src.path = ? AND e.kind = 'imports'
       ORDER BY e.line ASC`
    )
    .all(projectId, filePath);
}

export function findImportCycles(
  db: Database.Database,
  projectId: string,
  limit = 20
): string[][] {
  const edges = db
    .prepare<[string], { from: string; to: string }>(
      `SELECT src.path AS "from", dst.path AS "to"
       FROM code_edges e
       JOIN code_files src ON src.id = e.src_id
       JOIN code_files dst ON dst.id = e.dst_id
       WHERE e.project_id = ? AND e.kind = 'imports' AND e.dst_id IS NOT NULL`
    )
    .all(projectId);
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from);
    if (list) list.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function walk(node: string): void {
    if (cycles.length >= limit) return;
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = stack.slice(start).concat(node);
      const key = [...cycle].sort().join(">");
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) walk(next);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of adjacency.keys()) walk(node);
  return cycles;
}

export function getAffectedTests(
  db: Database.Database,
  projectId: string,
  changedFiles: string[],
  limit = 50
): Array<{ test_file: string; source_file: string }> {
  const results: Array<{ test_file: string; source_file: string }> = [];
  const seen = new Set<string>();
  for (const changed of changedFiles) {
    const rows = db
      .prepare<[string, string], { path: string }>(
        `SELECT DISTINCT src.path AS path
         FROM code_edges e
         JOIN code_files src ON src.id = e.src_id
         JOIN code_files dst ON dst.id = e.dst_id
         WHERE e.project_id = ? AND dst.path = ? AND src.is_test = 1`
      )
      .all(projectId, changed);
    for (const row of rows) {
      const key = `${row.path}>${changed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ test_file: row.path, source_file: changed });
      if (results.length >= limit) return results;
    }
    const base = path.basename(changed).replace(/\.[a-z0-9]+$/i, "");
    const convention = db
      .prepare<[string, string], { path: string }>(
        `SELECT path FROM code_files
         WHERE project_id = ? AND is_test = 1 AND path LIKE ? ESCAPE '\\'
         LIMIT 5`
      )
      .all(projectId, `%${base}%`);
    for (const row of convention) {
      const key = `${row.path}>${changed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ test_file: row.path, source_file: changed });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

export interface FileTreeEntry {
  path: string;
  language: string;
  symbols: number;
  bytes: number | null;
  is_test: number;
}

export function getFileTree(
  db: Database.Database,
  projectId: string,
  options: { indexRoot?: string | null; limit?: number | null } = {}
): FileTreeEntry[] {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 500), 1), 5_000);
  const params: Array<string | number> = [projectId];
  let filter = "";
  if (options.indexRoot) {
    filter = " AND f.index_root = ?";
    params.push(options.indexRoot);
  }
  params.push(limit);
  return db
    .prepare<Array<string | number>, FileTreeEntry>(
      `SELECT f.path, f.language, f.bytes, f.is_test,
              (SELECT count(*) FROM code_symbols s WHERE s.file_id = f.id) AS symbols
       FROM code_files f
       WHERE f.project_id = ?${filter}
       ORDER BY f.path ASC
       LIMIT ?`
    )
    .all(...params);
}

export function readSourceSlice(
  root: string,
  relativePath: string,
  startLine: number,
  endLine: number,
  options: { maxLines?: number } = {}
): string | null {
  const maxLines = options.maxLines ?? 60;
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  let content: string;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 1_000_000) return null;
    content = fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Math.min(Math.floor(startLine), lines.length));
  const end = Math.max(start, Math.min(Math.floor(endLine), start + maxLines - 1, lines.length));
  const numbered: string[] = [];
  for (let index = start; index <= end; index++) {
    numbered.push(`${String(index).padStart(5, " ")}| ${lines[index - 1]}`);
  }
  const truncated = endLine > end ? "\n... (truncated)" : "";
  return numbered.join("\n") + truncated;
}

interface ObservationHit {
  title: string;
  content: string;
  category: string;
}

function relatedObservations(
  db: Database.Database,
  projectId: string,
  query: string,
  limit = 5
): ObservationHit[] {
  const fts = sanitizeCodeQuery(query);
  if (!fts) return [];
  try {
    return db
      .prepare<[string, string, number], ObservationHit>(
        `SELECT o.title, o.content, o.category
         FROM observations_fts f
         JOIN observations o ON o.rowid = f.rowid
         WHERE observations_fts MATCH ? AND o.project_id = ? AND o.status = 'active'
         ORDER BY bm25(observations_fts) ASC
         LIMIT ?`
      )
      .all(fts, projectId, limit);
  } catch {
    return [];
  }
}

export function buildExplore(
  db: Database.Database,
  projectId: string,
  root: string,
  query: string,
  options: { budget?: number | null; limit?: number | null } = {}
): string {
  const budget = Math.min(
    Math.max(Math.floor(options.budget ?? 8_000), 500),
    MAX_EXPLORE_BUDGET
  );
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 6), 1), 20);
  const sections: string[] = [];
  let used = 0;
  const push = (text: string): boolean => {
    if (used + text.length > budget) return false;
    sections.push(text);
    used += text.length;
    return true;
  };

  const directFile = db
    .prepare<[string, string, string], { path: string }>(
      `SELECT path FROM code_files
       WHERE project_id = ? AND (path = ? OR path LIKE '%/' || ?) LIMIT 1`
    )
    .get(projectId, query.trim(), query.trim());

  if (directFile) {
    const symbols = listFileSymbols(db, projectId, directFile.path);
    push(`# File: \`${directFile.path}\` ${symbols.length} symbol(s)\n`);
    for (const symbol of symbols.slice(0, 40)) {
      push(`- \`${symbol.name}\` (${symbol.kind}) L${symbol.start_line}-${symbol.end_line}`);
    }
    const slice = readSourceSlice(root, directFile.path, 1, 120, { maxLines: 120 });
    if (slice) push("\n```\n" + slice + "\n```");
    return sections.join("\n");
  }

  const symbols = searchSymbols(db, projectId, query, { limit });
  if (symbols.length === 0) {
    return `No indexed symbol matched "${query}". The code index may be empty or stale: run muninn_project with action "index".`;
  }

  push(`# Explore: ${query}\n`);
  for (const hit of symbols) {
    const symbol = hit.symbol;
    const header = `## \`${symbol.qualified_name}\` (${symbol.kind}) - \`${symbol.file_path}\` L${symbol.start_line}-${symbol.end_line}`;
    if (!push(header)) break;
    const callers = getEdges(db, projectId, symbol.id, "incoming", {
      kinds: ["calls", "references"],
      limit: 8,
    }).filter((edge) => edge.symbol);
    const callees = getEdges(db, projectId, symbol.id, "outgoing", {
      kinds: ["calls", "references"],
      limit: 8,
    });
    if (callers.length > 0) {
      push(
        "Callers: " +
          callers
            .map((edge) => `\`${edge.symbol!.name}\` (\`${edge.symbol!.file_path}\`)`)
            .join(", ")
      );
    }
    if (callees.length > 0) {
      push(
        "Calls: " +
          callees
            .map((edge) => (edge.symbol ? `\`${edge.symbol.name}\`` : `\`${edge.target_name}\` (unresolved)`))
            .join(", ")
      );
    }
    const slice = readSourceSlice(
      root,
      symbol.file_path ?? hit.file_path,
      symbol.start_line,
      symbol.end_line,
      { maxLines: 40 }
    );
    if (slice) push("\n```\n" + slice + "\n```\n");
  }

  const observations = relatedObservations(db, projectId, query, 5);
  if (observations.length > 0) {
    push("## Related memory");
    for (const observation of observations) {
      push(`- [${observation.category}] ${observation.title}`);
    }
  }

  return sections.join("\n");
}

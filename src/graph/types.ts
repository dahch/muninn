import type Database from "better-sqlite3";

export type CodeSymbolKind =
  | "file"
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "module"
  | "constant"
  | "field"
  | "macro"
  | "unknown";

export type CodeEdgeKind =
  | "imports"
  | "calls"
  | "extends"
  | "implements"
  | "references"
  | "contains"
  | "exports"
  | "tests";

export type EdgeConfidence = "exact" | "heuristic";
export type EdgeResolution = "resolved" | "ambiguous" | "external" | "unresolved";

export interface ExtractedSymbol {
  name: string;
  /** Canonical name: `<file>::<Class.method>`. The indexer appends a line for duplicates. */
  qualified?: string;
  kind: CodeSymbolKind;
  startLine: number;
  endLine: number;
  startCol?: number;
  signature?: string | null;
  doc?: string | null;
  visibility?: string | null;
  isExported: boolean;
  parentName?: string | null;
}

export interface ExtractedEdge {
  /** Qualified symbol name, or the file path for a file-level edge. */
  src: string;
  kind: CodeEdgeKind;
  target: string;
  /** Resolved relative file path when the extractor already knows it. */
  targetFile?: string | null;
  line?: number | null;
  confidence?: EdgeConfidence;
}

export interface ExtractedFile {
  path: string;
  language: string;
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
}

export interface IndexOptions {
  projectRoot?: string;
  mode?: "changed" | "full";
  maxFiles?: number;
  maxFileBytes?: number;
  exclude?: string[];
}

export interface IndexSummary {
  indexedFiles: number;
  changedFiles: number;
  removedFiles: number;
  symbols: number;
  edges: number;
  /** Files parsed with tree-sitter (Tier B); the rest used the heuristic scan. */
  preciseFiles: number;
  skippedFiles: number;
  truncated: boolean;
  durationMs: number;
  indexRoot: string;
}

export interface CodeFileRow {
  id: string;
  project_id: string;
  index_root: string;
  path: string;
  language: string;
  content_hash: string;
  bytes: number | null;
  lines: number | null;
  mtime_ms: number | null;
  is_test: number;
  is_generated: number;
  indexed_at: string;
}

export interface CodeSymbolRow {
  id: string;
  project_id: string;
  file_id: string;
  name: string;
  qualified_name: string;
  kind: CodeSymbolKind;
  start_line: number;
  end_line: number;
  start_col: number | null;
  signature: string | null;
  doc: string | null;
  visibility: string | null;
  is_exported: number;
  parent_symbol_id: string | null;
  language: string | null;
  file_path?: string;
}

export interface CodeEdgeRow {
  id: string;
  project_id: string;
  src_id: string | null;
  dst_id: string | null;
  kind: CodeEdgeKind;
  line: number | null;
  confidence: EdgeConfidence;
  resolution: EdgeResolution;
  target_name: string | null;
}

export interface GraphServiceLike {
  db: Database.Database;
  currentProject: { id: string; root_path: string; name: string };
}

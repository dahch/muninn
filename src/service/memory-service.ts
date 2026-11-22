import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { assertDocPath } from "../util/path-safety.js";
import {
  deriveProjectUid,
  globalMemoryDbPath,
  globalMemoryDir,
  memoryJsonlPath,
  registerProjectContext,
  resolveProjectContext,
  type ProjectContext,
} from "../project/identity.js";
import {
  getDatabase,
  getReadOnlyDatabase,
  ensureProject,
  findGitRoot,
  tryGetGitRemote,
  type Project,
  type Observation,
  type Entity,
  type ObservationCategory,
  type EntityType,
  type ObservationEntity,
  type DependencyRelationType,
  type EntityDependency,
} from "../db/client.js";

export {
  type Project,
  type Observation,
  type Entity,
  type ObservationCategory,
  type EntityType,
  type ObservationEntity,
  type DependencyRelationType,
  type EntityDependency,
};

export const VALID_CATEGORIES: ReadonlyArray<ObservationCategory> = [
  "decision",
  "convention",
  "discovery",
  "bugfix",
  "architecture",
] as const;

export const VALID_ENTITY_TYPES: ReadonlyArray<EntityType> = [
  "file",
  "function",
  "class",
  "interface",
  "module",
] as const;

export interface SymbolInput {
  name?: string | null;
  filePath?: string | null;
  file_path?: string | null;
  identifier?: string | null;
  type?: EntityType | null;
  entity_type?: EntityType | null;
  id?: string | null;
}

export interface ObservationWithEntities extends Observation {
  entities: Entity[];
}

export interface SaveObservationInput {
  category: ObservationCategory | string;
  title: string;
  content: string;
  topicKey?: string | null;
  topic_key?: string | null;
  supersedesTopicKey?: string | null;
  supersedes_topic_key?: string | null;
  projectId?: string;
  project_id?: string;
  symbols?: Array<SymbolInput | string> | null;
  /** Agent that produced the observation (provenance, never required). */
  agent?: string | null;
  sessionId?: string | null;
  session_id?: string | null;
  /** `project` (default) or `global`. */
  scope?: "project" | "global" | null;
  tags?: string[] | null;
  files?: string[] | null;
  /** Explicit id, used by deterministic seed/upsert flows. */
  id?: string;
}

/**
 * A session handoff: the structured "where we left off" record a new session
 * reads before doing anything else. One handoff is active per project; saving a
 * new one supersedes the previous active handoff.
 */
export interface HandoffInput {
  goal: string;
  state: string;
  projectId?: string;
  project_id?: string;
  agent?: string | null;
  sessionId?: string | null;
  session_id?: string | null;
  branch?: string | null;
  filesTouched?: string[] | null;
  files_touched?: string[] | null;
  openQuestions?: string[] | null;
  open_questions?: string[] | null;
  nextSteps?: string[] | null;
  next_steps?: string[] | null;
  decisions?: string[] | null;
  blockers?: string[] | null;
  /** Mark the handoff closed instead of active (it is no longer "current"). */
  closed?: boolean;
}

export interface Handoff {
  id: string;
  project_id: string;
  goal: string;
  state: string;
  status: "active" | "superseded" | "closed";
  agent: string | null;
  session_id: string | null;
  branch: string | null;
  files_touched: string[];
  open_questions: string[];
  next_steps: string[];
  decisions: string[];
  blockers: string[];
  created_at: string;
  updated_at: string;
}

export interface SearchOptions {
  query: string;
  category?: ObservationCategory | string | null;
  projectId?: string | null;
  project_id?: string | null;
  allProjects?: boolean | null;
  includeSuperseded?: boolean | null;
  include_superseded?: boolean | null;
  /** Include `scope = global` observations from the cross-project store. */
  includeGlobal?: boolean | null;
  include_global?: boolean | null;
  limit?: number | null;
}

export interface SearchResult extends ObservationWithEntities {
  rank: number;
}

export interface ContextOptions {
  limit?: number | null;
  category?: ObservationCategory | string | null;
  topicKey?: string | null;
  topic_key?: string | null;
  projectId?: string | null;
  project_id?: string | null;
  allProjects?: boolean | null;
  includeSuperseded?: boolean | null;
  include_superseded?: boolean | null;
  /** Include `scope = global` observations from the cross-project store. */
  includeGlobal?: boolean | null;
  include_global?: boolean | null;
}

export interface SyncToDiskOptions {
  projectId?: string;
  allProjects?: boolean;
}

export interface LinkSymbolInput {
  observationId?: string;
  observation_id?: string;
  symbol: SymbolInput | string;
  projectId?: string;
}

export interface MemoryStats {
  projects: number;
  observations: number;
  entities: number;
  links: number;
}

export interface MemoryServiceOptions {
  db?: Database.Database;
  dbPath?: string;
  projectRoot?: string;
}

export const DEFAULT_SESSION_BRIEF_BUDGET = 8_000;
export const MAX_SESSION_BRIEF_BUDGET = 20_000;
export const MAX_SESSION_BRIEF_PATHS = 20;
export const SESSION_BRIEF_RECENT_ACTIVITY_LIMIT = 20;

export const DEFAULT_NEIGHBOR_DEPTH = 1;
export const MAX_NEIGHBOR_DEPTH = 2;
export const DEFAULT_NEIGHBOR_LIMIT = 20;
export const MAX_NEIGHBOR_LIMIT = 50;
export const SESSION_BRIEF_RELATED_LIMIT = MAX_NEIGHBOR_LIMIT;

export type NeighborDirection = "outgoing" | "incoming";

export interface NeighborOptions {
  depth?: number | null;
  limit?: number | null;
}

export interface SymbolNeighbor {
  entity: Entity;
  relationType: DependencyRelationType;
  direction: NeighborDirection;
  /** BFS distance from the inspected entity, starting at 1. */
  depth: number;
}

export interface SymbolNeighborGroup {
  direction: NeighborDirection;
  relationType: DependencyRelationType;
  neighbors: SymbolNeighbor[];
}

export interface SymbolNeighbors {
  entity: Entity;
  depth: number;
  limit: number;
  groups: SymbolNeighborGroup[];
  /** Flat, deterministically ordered view of `groups` without duplicate entities. */
  neighbors: SymbolNeighbor[];
  truncated: boolean;
}

export interface SessionBriefOptions {
  paths?: string[] | null;
  budgetChars?: number | null;
  expandGraph?: boolean | null;
}

export interface SessionBriefRequest extends SessionBriefOptions {
  dbPath?: string;
  projectRoot?: string;
  /** An already-open connection, used by the service method and test adapters. */
  db?: Database.Database;
}

export interface SessionBriefProject {
  id: string | null;
  name: string;
  rootPath: string;
  gitRemote: string | null;
}

export interface SessionBriefDecisionGroup {
  topicKey: string;
  decisions: Observation[];
}

export interface SessionBriefCounts {
  /** `null` means the count could not be read; zero is a real, successful count. */
  observations: number | null;
  entities: number | null;
  links: number | null;
}

export interface SessionBriefContent {
  project: SessionBriefProject;
  activeDecisions: {
    keyed: SessionBriefDecisionGroup[];
    unkeyed: Observation[];
  };
  recentActivity: Observation[];
  symbols: Entity[];
  /** Deduplicated graph neighbors of the path-selected symbols. */
  related: SymbolNeighbor[];
  /** The project's active session handoff, when one exists. */
  handoff?: Handoff | null;
  /** Cross-project `scope = global` observations, when the store exists. */
  globalObservations?: Observation[];
  counts: SessionBriefCounts;
  notes: string[];
  budgetChars: number;
}

export interface SessionBrief extends SessionBriefContent {
  truncated: boolean;
  markdown: string;
}

export interface SymbolInspectionDependency {
  entity: Entity;
  relationType: DependencyRelationType;
}

export interface SymbolInspection {
  entity: Entity;
  dependencies: {
    outgoing: SymbolInspectionDependency[];
    incoming: SymbolInspectionDependency[];
  };
  /** Bounded depth-1 traversal over the same dependency graph as `neighbors`. */
  neighbors: SymbolNeighbors;
  observations: Observation[];
}

export interface IMemoryService {
  readonly currentProject: Project;
  readonly db: Database.Database;
  saveObservation(input: SaveObservationInput): ObservationWithEntities;
  search(options: SearchOptions): SearchResult[];
  getContext(options?: ContextOptions): ObservationWithEntities[];
  linkSymbol(
    inputOrObsId: LinkSymbolInput | string,
    symbol?: SymbolInput | string
  ): { observation: Observation; entity: Entity };
  inspectSymbol(
    symbol: string,
    projectId?: string
  ): SymbolInspection | null;
  neighbors(
    identifier: string,
    options?: NeighborOptions
  ): SymbolNeighbors | null;
  getStats(projectId?: string): MemoryStats;
  saveHandoff(input: HandoffInput): Handoff;
  getActiveHandoff(projectId?: string): Handoff | null;
  getHandoff(id: string): Handoff | null;
  listHandoffs(options?: {
    projectId?: string;
    limit?: number | null;
    includeSuperseded?: boolean | null;
  }): Handoff[];
  closeHandoff(projectId?: string): boolean;
  getSessionBrief(options?: SessionBriefOptions): SessionBrief;
  syncToDisk(
    targetPath?: string,
    options?: { projectId?: string; allProjects?: boolean }
  ): { path: string; count: number; handoffs?: number };
  importFromDisk(sourcePath?: string): { imported: number; skipped: number };
  close?(force?: boolean): void;
}

/**
 * Normalizes input symbols into canonical identifier, filePath, and entityType.
 */
export function normalizeSymbol(symbol: SymbolInput | string): {
  identifier: string;
  filePath: string;
  entityType: EntityType;
} {
  if (!symbol || (typeof symbol !== "string" && typeof symbol !== "object")) {
    return { identifier: "unknown", filePath: "unknown", entityType: "module" };
  }

  if (typeof symbol === "string") {
    const raw = symbol.trim();
    if (!raw) {
      return { identifier: "unknown", filePath: "unknown", entityType: "module" };
    }
    if (raw.includes("::")) {
      const parts = raw.split("::");
      const filePath = parts[0] || "unknown";
      return {
        identifier: raw,
        filePath,
        entityType: "module",
      };
    }
    if (
      raw.includes("/") ||
      raw.endsWith(".ts") ||
      raw.endsWith(".js") ||
      raw.endsWith(".json")
    ) {
      return {
        identifier: raw,
        filePath: raw,
        entityType: "file",
      };
    }
    return {
      identifier: raw,
      filePath: "unknown",
      entityType: "module",
    };
  }

  const rawName = symbol.name?.trim();
  const rawFilePath = (symbol.filePath ?? symbol.file_path)?.trim();
  const rawIdentifier = symbol.identifier?.trim();
  const rawType = (symbol.type ?? symbol.entity_type) as EntityType | undefined;

  let identifier: string;
  if (rawIdentifier) {
    identifier = rawIdentifier;
  } else if (rawFilePath) {
    identifier =
      rawName && rawName !== "default"
        ? `${rawFilePath}::${rawName}`
        : rawFilePath;
  } else if (rawName) {
    identifier = rawName;
  } else {
    identifier = "unknown";
  }

  let filePath: string;
  if (rawFilePath) {
    filePath = rawFilePath;
  } else if (rawIdentifier && rawIdentifier.includes("::")) {
    filePath = rawIdentifier.split("::")[0] || "unknown";
  } else if (
    rawIdentifier &&
    (rawIdentifier.includes("/") ||
      rawIdentifier.endsWith(".ts") ||
      rawIdentifier.endsWith(".js") ||
      rawIdentifier.endsWith(".json"))
  ) {
    filePath = rawIdentifier;
  } else {
    filePath = "unknown";
  }

  let entityType: EntityType = "module";
  if (rawType && (VALID_ENTITY_TYPES as readonly string[]).includes(rawType)) {
    entityType = rawType;
  } else if (rawFilePath && (!rawName || rawName === "default")) {
    entityType = "file";
  }

  return {
    identifier,
    filePath,
    entityType,
  };
}

/**
 * Safely format query terms for SQLite FTS5 syntax.
 * Escapes special characters, wraps terms in quotes, and safely supports prefix queries.
 * Returns an empty string if no valid search terms remain.
 */
export function sanitizeFtsQuery(query: string): string {
  if (!query || typeof query !== "string") {
    return "";
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return "";
  }

  // Regex to extract double-quoted phrases OR non-whitespace words
  const tokenRegex = /"([^"]*)"|(\S+)/g;
  const terms: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(trimmed)) !== null) {
    if (match[1] !== undefined) {
      // It was inside double quotes
      const inner = match[1].replace(/"/g, "").trim();
      if (inner && /[\p{L}\p{N}]/u.test(inner)) {
        terms.push(`"${inner}"`);
      }
    } else if (match[2] !== undefined) {
      const raw = match[2].trim();
      const cleaned = raw.replace(/"/g, "");
      if (!cleaned) {
        continue;
      }

      // Check if ends with wildcard *
      if (cleaned.endsWith("*") && cleaned.length > 1) {
        const base = cleaned.slice(0, -1);
        if (/[\p{L}\p{N}]/u.test(base)) {
          terms.push(`"${base}"*`);
          continue;
        }
      }

      // Check if contains letters or numbers
      if (/[\p{L}\p{N}]/u.test(cleaned)) {
        terms.push(`"${cleaned}"`);
      }
    }
  }

  return terms.join(" ");
}

function sessionBriefError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  const message = String(err).trim();
  return message || "unknown error";
}

function resolveSessionBriefBudget(value: number | null | undefined): number {
  const budget = value ?? DEFAULT_SESSION_BRIEF_BUDGET;
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new Error("budgetChars must be a positive integer");
  }
  if (budget > MAX_SESSION_BRIEF_BUDGET) {
    throw new Error(
      `budgetChars cannot exceed ${MAX_SESSION_BRIEF_BUDGET} characters`
    );
  }
  return budget;
}

/**
 * Resolve file/directory selections against the project root without touching the
 * filesystem. The result is a deduplicated list of project-relative POSIX paths;
 * an empty string means "the whole project root".
 */
function resolveSessionBriefPaths(
  paths: string[] | null | undefined,
  rootPath: string
): string[] {
  const rawPaths = paths ?? [];
  if (rawPaths.length > MAX_SESSION_BRIEF_PATHS) {
    throw new Error(
      `At most ${MAX_SESSION_BRIEF_PATHS} paths may be requested for a session brief`
    );
  }

  const root = path.resolve(rootPath);
  const resolved = rawPaths.map((raw) => {
    if (typeof raw !== "string") {
      throw new Error("Session brief paths must be strings");
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("Session brief paths cannot be empty");
    }
    // Accept Windows and POSIX separators, then compare in one canonical form.
    const withPlatformSeparators = trimmed.replace(/\\/g, path.sep);
    const absolute = path.isAbsolute(withPlatformSeparators)
      ? path.resolve(withPlatformSeparators)
      : path.resolve(root, withPlatformSeparators);
    const relative = path.relative(root, absolute);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Path "${raw}" is outside the project root ${root}`
      );
    }
    return relative.split(path.sep).filter(Boolean).join("/");
  });

  return [...new Set(resolved)];
}

function normalizeIndexedFilePath(filePath: string, rootPath: string): string {
  let normalized = filePath.replace(/\\/g, "/");
  if (path.isAbsolute(filePath)) {
    const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
    if (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    ) {
      normalized = relative.replace(/\\/g, "/");
    }
  }
  return normalized
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function entityMatchesSelectedPaths(
  entityPath: string,
  selectedPaths: string[],
  rootPath: string
): boolean {
  if (selectedPaths.length === 0) return false;
  const normalized = normalizeIndexedFilePath(entityPath, rootPath);
  return selectedPaths.some(
    (selected) =>
      selected === "" ||
      normalized === selected ||
      normalized.startsWith(`${selected}/`)
  );
}

const NEIGHBOR_RELATION_ORDER: ReadonlyArray<DependencyRelationType> = [
  "imports",
  "calls",
  "implements",
  "extends",
  "references",
];

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function compareEntities(left: Entity, right: Entity): number {
  if (left.identifier !== right.identifier) {
    return left.identifier < right.identifier ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Resolves an entity using the same exact, suffix, and prefix/path tiers used by
 * symbol inspection. Callers always pass a concrete project id.
 */
function resolveEntityByIdentifier(
  db: Database.Database,
  projectId: string,
  identifier: string
): Entity | undefined {
  if (!identifier || typeof identifier !== "string" || !identifier.trim()) {
    return undefined;
  }

  const query = identifier.trim();
  const exact = db
    .prepare<[string, string], Entity>(
      `SELECT id, project_id, entity_type, identifier, file_path
       FROM entities
       WHERE project_id = ? AND identifier = ?`
    )
    .get(projectId, query);
  if (exact) return exact;

  const escapedQuery = escapeLikePattern(query);
  const suffix = db
    .prepare<[string, string, string], Entity>(
      `SELECT id, project_id, entity_type, identifier, file_path
       FROM entities
       WHERE project_id = ? AND (identifier LIKE '%::' || ? ESCAPE '\\' OR identifier LIKE '%.' || ? ESCAPE '\\')
       ORDER BY identifier ASC, id ASC
       LIMIT 1`
    )
    .get(projectId, escapedQuery, escapedQuery);
  if (suffix) return suffix;

  return db
    .prepare<[string, string, string], Entity>(
      `SELECT id, project_id, entity_type, identifier, file_path
       FROM entities
       WHERE project_id = ? AND (identifier LIKE ? || '%' ESCAPE '\\' OR file_path = ?)
       ORDER BY identifier ASC, id ASC
       LIMIT 1`
    )
    .get(projectId, escapedQuery, query);
}

function toJsonArray(values?: string[] | null): string | null {
  if (!Array.isArray(values)) return null;
  const cleaned = values
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
  return cleaned.length > 0 ? JSON.stringify(cleaned) : null;
}

function parseJsonArray(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

interface HandoffRow {
  id: string;
  project_id: string;
  goal: string;
  state: string;
  status: "active" | "superseded" | "closed";
  agent: string | null;
  session_id: string | null;
  branch: string | null;
  files_touched: string | null;
  open_questions: string | null;
  next_steps: string | null;
  decisions: string | null;
  blockers: string | null;
  created_at: string;
  updated_at: string;
}

function rowToHandoff(row: HandoffRow): Handoff {
  return {
    id: row.id,
    project_id: row.project_id,
    goal: row.goal,
    state: row.state,
    status: row.status,
    agent: row.agent,
    session_id: row.session_id,
    branch: row.branch,
    files_touched: parseJsonArray(row.files_touched),
    open_questions: parseJsonArray(row.open_questions),
    next_steps: parseJsonArray(row.next_steps),
    decisions: parseJsonArray(row.decisions),
    blockers: parseJsonArray(row.blockers),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function requireNonEmpty(value: string | null | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required and cannot be empty`);
  }
  return value.trim();
}

function resolveNeighborDepth(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return DEFAULT_NEIGHBOR_DEPTH;
  }
  const depth = Math.floor(value);
  if (depth < 1) return DEFAULT_NEIGHBOR_DEPTH;
  return Math.min(depth, MAX_NEIGHBOR_DEPTH);
}

function resolveNeighborLimit(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return DEFAULT_NEIGHBOR_LIMIT;
  }
  const limit = Math.floor(value);
  if (limit < 1) return DEFAULT_NEIGHBOR_LIMIT;
  return Math.min(limit, MAX_NEIGHBOR_LIMIT);
}

interface NeighborEdgeRow extends Entity {
  relation_type: DependencyRelationType;
}

function collectNeighbors(
  db: Database.Database,
  root: Entity,
  depthValue?: number | null,
  limitValue?: number | null
): SymbolNeighbors {
  const depth = resolveNeighborDepth(depthValue);
  const limit = resolveNeighborLimit(limitValue);
  const visited = new Set<string>([root.id]);
  const flat: SymbolNeighbor[] = [];
  let frontier: Entity[] = [root];
  let truncated = false;

  const outgoingStatement = db.prepare<[string], NeighborEdgeRow>(
    `SELECT e.id, e.project_id, e.entity_type, e.identifier, e.file_path, ed.relation_type
     FROM entity_dependencies ed
     JOIN entities e ON e.id = ed.target_entity_id
     WHERE ed.source_entity_id = ?
     ORDER BY ed.relation_type ASC, e.identifier ASC, e.id ASC`
  );
  const incomingStatement = db.prepare<[string], NeighborEdgeRow>(
    `SELECT e.id, e.project_id, e.entity_type, e.identifier, e.file_path, ed.relation_type
     FROM entity_dependencies ed
     JOIN entities e ON e.id = ed.source_entity_id
     WHERE ed.target_entity_id = ?
     ORDER BY ed.relation_type ASC, e.identifier ASC, e.id ASC`
  );

  outer: for (let level = 1; level <= depth && frontier.length > 0; level++) {
    const nextFrontier: Entity[] = [];
    const orderedFrontier = [...frontier].sort(compareEntities);
    for (const current of orderedFrontier) {
      const directions: Array<{
        direction: NeighborDirection;
        rows: NeighborEdgeRow[];
      }> = [
        { direction: "outgoing", rows: outgoingStatement.all(current.id) },
        { direction: "incoming", rows: incomingStatement.all(current.id) },
      ];

      for (const { direction, rows } of directions) {
        const orderedRows = [...rows].sort((left, right) => {
          const leftRelation = NEIGHBOR_RELATION_ORDER.indexOf(
            left.relation_type
          );
          const rightRelation = NEIGHBOR_RELATION_ORDER.indexOf(
            right.relation_type
          );
          if (leftRelation !== rightRelation) {
            return leftRelation - rightRelation;
          }
          return compareEntities(left, right);
        });

        for (const row of orderedRows) {
          if (visited.has(row.id)) continue;
          if (flat.length >= limit) {
            truncated = true;
            break outer;
          }
          visited.add(row.id);
          const entity: Entity = {
            id: row.id,
            project_id: row.project_id,
            entity_type: row.entity_type,
            identifier: row.identifier,
            file_path: row.file_path,
          };
          flat.push({
            entity,
            relationType: row.relation_type,
            direction,
            depth: level,
          });
          nextFrontier.push(entity);
        }
      }
    }
    frontier = nextFrontier;
  }

  const groupsByKey = new Map<string, SymbolNeighborGroup>();
  for (const neighbor of flat) {
    const key = `${neighbor.direction}:${neighbor.relationType}`;
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.neighbors.push(neighbor);
    } else {
      groupsByKey.set(key, {
        direction: neighbor.direction,
        relationType: neighbor.relationType,
        neighbors: [neighbor],
      });
    }
  }

  return {
    entity: root,
    depth,
    limit,
    groups: [...groupsByKey.values()],
    neighbors: flat,
    truncated,
  };
}

function deriveSessionBriefProject(rootPath: string): SessionBriefProject {
  const root = path.resolve(rootPath);
  return {
    id: null,
    name: path.basename(root) || "project",
    rootPath: root,
    gitRemote: tryGetGitRemote(root),
  };
}

function sessionBriefProjectFromRow(project: Project): SessionBriefProject {
  return {
    id: project.id,
    name: project.name,
    rootPath: project.root_path,
    gitRemote: project.git_remote,
  };
}

function findSessionBriefProjectRow(
  db: Database.Database,
  rootPath: string
): Project | undefined {
  const root = path.resolve(rootPath);
  return db
    .prepare<[string], Project>(
      `SELECT id, name, git_remote, root_path, created_at
       FROM projects
       WHERE root_path = ?`
    )
    .get(root);
}

function formatCount(count: number | null): string {
  return count === null ? "unavailable" : String(count);
}

function appendBriefObservation(
  lines: string[],
  observation: Observation,
  labelSuperseded: boolean
): void {
  const supersededLabel =
    labelSuperseded && observation.status === "superseded"
      ? ` — SUPERSEDED${
          observation.superseded_by
            ? ` (replaced by \`${observation.superseded_by}\`)`
            : ""
        }`
      : "";
  lines.push(
    `- **${observation.title}** \`[${observation.category}]\`${supersededLabel}`
  );
  if (observation.topic_key) {
    lines.push(`  Topic key: \`${observation.topic_key}\``);
  }
  const contentLines = observation.content.split(/\r?\n/);
  for (const contentLine of contentLines) {
    lines.push(`  ${contentLine}`);
  }
}

function buildSessionBriefMarkdown(content: SessionBriefContent): string {
  const lines: string[] = [];
  lines.push(`# Session Brief: ${content.project.name}`, "");
  lines.push("## Project");
  lines.push(`- Name: ${content.project.name}`);
  lines.push(`- Root: \`${content.project.rootPath}\``);
  if (content.project.id) {
    lines.push(`- ID: \`${content.project.id}\``);
  }
  if (content.project.gitRemote) {
    lines.push(`- Git remote: ${content.project.gitRemote}`);
  }

  // Continuity comes before history: a fresh session needs to know what was in
  // progress before it needs the decision log.
  if (content.handoff) {
    const handoff = content.handoff;
    lines.push("", "## Where we left off");
    lines.push(`- Goal: ${handoff.goal}`);
    lines.push(`- State: ${handoff.state}`);
    if (handoff.agent) lines.push(`- Agent: ${handoff.agent}`);
    if (handoff.session_id) lines.push(`- Session: ${handoff.session_id}`);
    if (handoff.branch) lines.push(`- Branch: ${handoff.branch}`);
    if (handoff.files_touched.length > 0) {
      lines.push(`- Files touched: ${handoff.files_touched.join(", ")}`);
    }
    if (handoff.next_steps.length > 0) {
      lines.push("", "### Next steps");
      handoff.next_steps.forEach((step, index) => {
        lines.push(`${index + 1}. ${step}`);
      });
    }
    if (handoff.open_questions.length > 0) {
      lines.push("", "### Open questions");
      for (const question of handoff.open_questions) {
        lines.push(`- ${question}`);
      }
    }
    if (handoff.blockers.length > 0) {
      lines.push("", "### Blockers");
      for (const blocker of handoff.blockers) {
        lines.push(`- ${blocker}`);
      }
    }
    if (handoff.decisions.length > 0) {
      lines.push("", "### Decisions linked to this handoff");
      for (const decision of handoff.decisions) {
        lines.push(`- \`${decision}\``);
      }
    }
  }

  if (content.globalObservations && content.globalObservations.length > 0) {
    lines.push("", "## Global preferences");
    for (const observation of content.globalObservations) {
      const firstLine = observation.content.split("\n").find((line) => line.trim()) ?? "";
      lines.push(`- **${observation.title}** ` + `[${observation.category}] ${firstLine.slice(0, 240)}`);
    }
  }

  lines.push("", "## Counts");
  lines.push(`- Observations: ${formatCount(content.counts.observations)}`);
  lines.push(`- Entities: ${formatCount(content.counts.entities)}`);
  lines.push(`- Links: ${formatCount(content.counts.links)}`);

  const keyedDecisions = content.activeDecisions.keyed;
  const unkeyedDecisions = content.activeDecisions.unkeyed;
  if (keyedDecisions.length > 0 || unkeyedDecisions.length > 0) {
    lines.push("", "## Active Decisions");
    for (const group of keyedDecisions) {
      lines.push("", `### Topic: ${group.topicKey}`);
      for (const decision of group.decisions) {
        appendBriefObservation(lines, decision, false);
      }
    }
    if (unkeyedDecisions.length > 0) {
      lines.push("", "### Unkeyed decisions");
      for (const decision of unkeyedDecisions) {
        appendBriefObservation(lines, decision, false);
      }
    }
  }

  if (content.recentActivity.length > 0) {
    lines.push("", "## Recent Activity");
    for (const observation of content.recentActivity) {
      appendBriefObservation(lines, observation, true);
    }
  }

  if (content.symbols.length > 0) {
    lines.push("", "## Indexed Symbols");
    for (const symbol of content.symbols) {
      lines.push(
        `- \`${symbol.identifier}\` (${symbol.entity_type}) — \`${symbol.file_path}\``
      );
    }
  }

  if (content.related.length > 0) {
    lines.push("", "## Related Symbols");
    for (const neighbor of content.related) {
      lines.push(
        `- \`${neighbor.entity.identifier}\` (${neighbor.entity.entity_type}) — \`${neighbor.entity.file_path}\``
      );
    }
  }

  if (content.notes.length > 0) {
    lines.push("", "## Notes");
    for (const note of content.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n").trimEnd();
}

function applySessionBriefBudget(
  markdown: string,
  budgetChars: number
): { markdown: string; truncated: boolean } {
  if (markdown.length <= budgetChars) {
    return { markdown, truncated: false };
  }

  const marker = `\n\n[truncated: output limited to ${budgetChars} characters; increase budgetChars to see the rest]`;
  if (budgetChars <= marker.length) {
    // Use a compact marker in small budgets so some useful content still fits.
    // Even a one-character budget must remain bounded and visibly clipped.
    const shortMarker = "[truncated]";
    const contentBudget = budgetChars - shortMarker.length;
    if (contentBudget > 0) {
      return {
        markdown: markdown.slice(0, contentBudget) + shortMarker,
        truncated: true,
      };
    }
    return {
      markdown: (
        shortMarker.slice(0, Math.max(0, budgetChars - 1)) + "…"
      ).slice(0, budgetChars),
      truncated: true,
    };
  }

  const keep = budgetChars - marker.length;
  return {
    markdown: markdown.slice(0, keep) + marker,
    truncated: true,
  };
}

/**
 * Shared deterministic Markdown renderer used by the library, MCP and CLI.
 * It measures the complete output, including headings, notes, and the marker,
 * against `content.budgetChars`.
 */
export function renderSessionBrief(content: SessionBriefContent): string {
  return applySessionBriefBudget(
    buildSessionBriefMarkdown(content),
    content.budgetChars
  ).markdown;
}

function assembleSessionBrief(
  db: Database.Database,
  project: SessionBriefProject,
  projectId: string | null,
  selectedPaths: string[],
  budgetChars: number,
  notes: string[],
  expandGraph: boolean = true
): SessionBrief {
  let counts: SessionBriefCounts = {
    observations: 0,
    entities: 0,
    links: 0,
  };
  let keyed: SessionBriefDecisionGroup[] = [];
  let unkeyed: Observation[] = [];
  let recentActivity: Observation[] = [];
  let symbols: Entity[] = [];
  const related: SymbolNeighbor[] = [];

  if (projectId) {
    const countObservations = db
      .prepare<[string], { count: number }>(
        "SELECT COUNT(*) as count FROM observations WHERE project_id = ?"
      )
      .get(projectId)?.count;
    const countEntities = db
      .prepare<[string], { count: number }>(
        "SELECT COUNT(*) as count FROM entities WHERE project_id = ?"
      )
      .get(projectId)?.count;
    const countLinks = db
      .prepare<[string], { count: number }>(
        `SELECT COUNT(*) as count
         FROM observation_entities oe
         JOIN observations o ON o.id = oe.observation_id
         WHERE o.project_id = ?`
      )
      .get(projectId)?.count;

    counts = {
      observations: countObservations ?? 0,
      entities: countEntities ?? 0,
      links: countLinks ?? 0,
    };

    const decisions = db
      .prepare<[string], Observation>(
        `SELECT id, project_id, category, title, content, topic_key, status,
                superseded_by, created_at, updated_at
         FROM observations
         WHERE project_id = ? AND category = 'decision' AND status = 'active'
         ORDER BY topic_key ASC, updated_at DESC, created_at DESC, rowid DESC`
      )
      .all(projectId);

    const keyedMap = new Map<string, Observation[]>();
    for (const decision of decisions) {
      if (!decision.topic_key) {
        unkeyed.push(decision);
        continue;
      }
      const group = keyedMap.get(decision.topic_key);
      if (group) {
        group.push(decision);
      } else {
        keyedMap.set(decision.topic_key, [decision]);
      }
    }
    keyed = [...keyedMap.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([topicKey, groupDecisions]) => ({
        topicKey,
        decisions: groupDecisions,
      }));

    const listedDecisionIds = decisions.map((decision) => decision.id);
    const activityParams: string[] = [projectId];
    let exclusion = "";
    if (listedDecisionIds.length > 0) {
      exclusion = ` AND id NOT IN (${listedDecisionIds.map(() => "?").join(",")})`;
      activityParams.push(...listedDecisionIds);
    }
    activityParams.push(String(SESSION_BRIEF_RECENT_ACTIVITY_LIMIT));
    recentActivity = db
      .prepare<string[], Observation>(
        `SELECT id, project_id, category, title, content, topic_key, status,
                superseded_by, created_at, updated_at
         FROM observations
         WHERE project_id = ?${exclusion}
         ORDER BY updated_at DESC, created_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(...activityParams);

    if (selectedPaths.length > 0) {
      const indexed = db
        .prepare<[string], Entity>(
          `SELECT id, project_id, entity_type, identifier, file_path
           FROM entities
           WHERE project_id = ?
           ORDER BY file_path ASC, identifier ASC, rowid ASC`
        )
        .all(projectId);
      symbols = indexed.filter((entity) =>
        entityMatchesSelectedPaths(
          entity.file_path,
          selectedPaths,
          project.rootPath
        )
      );
      if (symbols.length === 0) {
        notes.push("No indexed symbols matched the selected path(s).");
      }
    }

    if (expandGraph && symbols.length > 0) {
      const relatedById = new Map<string, SymbolNeighbor>();
      // The related section exists to add what the selected paths did not name.
      // A neighbor that is itself path-selected is already printed under
      // "Indexed Symbols", so listing it again would spend the brief's budget
      // on a duplicate and read like a second, different symbol.
      const listedSymbolIds = new Set(symbols.map((symbol) => symbol.id));
      let traversedNeighbor = false;
      for (const symbol of symbols) {
        if (relatedById.size >= SESSION_BRIEF_RELATED_LIMIT) break;
        const traversal = collectNeighbors(
          db,
          symbol,
          DEFAULT_NEIGHBOR_DEPTH,
          SESSION_BRIEF_RELATED_LIMIT
        );
        for (const neighbor of traversal.neighbors) {
          traversedNeighbor = true;
          if (relatedById.size >= SESSION_BRIEF_RELATED_LIMIT) break;
          if (listedSymbolIds.has(neighbor.entity.id)) continue;
          if (!relatedById.has(neighbor.entity.id)) {
            relatedById.set(neighbor.entity.id, neighbor);
          }
        }
      }
      related.push(...relatedById.values());
      // "No neighbors" is only true when the graph had none to offer; a graph
      // whose neighbors were all already listed omits the section silently.
      if (!traversedNeighbor) {
        notes.push(
          "No indexed dependency neighbors were found for the selected symbol(s)."
        );
      }
    }
  } else {
    notes.push(
      "No project record was found in the database; project identity was derived from the selected root."
    );
    if (selectedPaths.length > 0) {
      notes.push(
        "Indexed symbols are unavailable because no project record exists for the selected root."
      );
    }
  }

  let handoff: Handoff | null = null;
  if (projectId) {
    try {
      const handoffRow = db
        .prepare<[string], HandoffRow>(
          `SELECT id, project_id, goal, state, status, agent, session_id, branch,
                  files_touched, open_questions, next_steps, decisions, blockers,
                  created_at, updated_at
           FROM handoffs
           WHERE project_id = ? AND status = 'active'
           ORDER BY updated_at DESC, created_at DESC, rowid DESC
           LIMIT 1`
        )
        .get(projectId);
      handoff = handoffRow ? rowToHandoff(handoffRow) : null;
    } catch {
      // A database created before handoffs existed: the brief stays useful.
      handoff = null;
    }
  }

  let globalObservations: Observation[] = [];
  try {
    const globalDb = getReadOnlyDatabase(globalMemoryDbPath());
    try {
      globalObservations = globalDb
        .prepare<[], Observation>(
          `SELECT id, project_id, category, title, content, topic_key, status,
                  superseded_by, scope, agent, session_id, tags, files,
                  created_at, updated_at
           FROM observations
           WHERE scope = 'global' AND status = 'active'
           ORDER BY updated_at DESC, created_at DESC, rowid DESC
           LIMIT 8`
        )
        .all();
    } finally {
      globalDb.close();
    }
  } catch {
    globalObservations = [];
  }

  const content: SessionBriefContent = {
    project,
    activeDecisions: { keyed, unkeyed },
    recentActivity,
    symbols,
    related,
    handoff,
    globalObservations,
    counts,
    notes,
    budgetChars,
  };
  const rendered = applySessionBriefBudget(
    buildSessionBriefMarkdown(content),
    budgetChars
  );
  return {
    ...content,
    truncated: rendered.truncated,
    markdown: rendered.markdown,
  };
}

function buildUnavailableSessionBrief(
  rootPath: string,
  selectedPaths: string[],
  budgetChars: number,
  cause: unknown,
  projectRow?: Project
): SessionBrief {
  const project = projectRow
    ? sessionBriefProjectFromRow(projectRow)
    : deriveSessionBriefProject(rootPath);
  const notes = [
    `Muninn memory is unavailable (${sessionBriefError(cause)}); returning an empty session brief.`,
  ];
  if (selectedPaths.length > 0) {
    notes.push(
      "Indexed symbols are unavailable because the database could not be read."
    );
  }
  const content: SessionBriefContent = {
    project,
    activeDecisions: { keyed: [], unkeyed: [] },
    recentActivity: [],
    symbols: [],
    related: [],
    counts: { observations: null, entities: null, links: null },
    notes,
    budgetChars,
  };
  const rendered = applySessionBriefBudget(
    buildSessionBriefMarkdown(content),
    budgetChars
  );
  return {
    ...content,
    truncated: rendered.truncated,
    markdown: rendered.markdown,
  };
}

/**
 * Read-only bootstrap entry point for the CLI and MCP default server.
 *
 * It never uses `getDatabase()` or `ensureProject()`: an existing database is
 * opened read-only, and any missing/inaccessible/corrupt/uninitialized file
 * yields an empty brief with a cause in `notes` instead of throwing or creating
 * state.
 */
export function readSessionBrief(
  request: SessionBriefRequest = {}
): SessionBrief {
  const rootPath = path.resolve(
    request.projectRoot ?? findGitRoot() ?? process.cwd()
  );
  const budgetChars = resolveSessionBriefBudget(request.budgetChars);
  const selectedPaths = resolveSessionBriefPaths(request.paths, rootPath);
  const expandGraph = request.expandGraph !== false;

  if (request.db) {
    try {
      const projectRow = findSessionBriefProjectRow(request.db, rootPath);
      const project = projectRow
        ? sessionBriefProjectFromRow(projectRow)
        : deriveSessionBriefProject(rootPath);
      return assembleSessionBrief(
        request.db,
        project,
        projectRow?.id ?? null,
        selectedPaths,
        budgetChars,
        [],
        expandGraph
      );
    } catch (err) {
      return buildUnavailableSessionBrief(
        rootPath,
        selectedPaths,
        budgetChars,
        err
      );
    }
  }

  let db: Database.Database | undefined;
  try {
    db = getReadOnlyDatabase(request.dbPath, rootPath);
  } catch (err) {
    return buildUnavailableSessionBrief(
      rootPath,
      selectedPaths,
      budgetChars,
      err
    );
  }

  try {
    const projectRow = findSessionBriefProjectRow(db, rootPath);
    const project = projectRow
      ? sessionBriefProjectFromRow(projectRow)
      : deriveSessionBriefProject(rootPath);
    return assembleSessionBrief(
      db,
      project,
      projectRow?.id ?? null,
      selectedPaths,
      budgetChars,
      [],
      expandGraph
    );
  } catch (err) {
    return buildUnavailableSessionBrief(
      rootPath,
      selectedPaths,
      budgetChars,
      err
    );
  } finally {
    if (db.open) {
      db.close();
    }
  }
}

export class MemoryService implements IMemoryService {
  private readonly _db: Database.Database;
  private readonly _currentProject: Project;
  private readonly isDbOwned: boolean;
  private readonly _context: ProjectContext;

  constructor(options?: MemoryServiceOptions) {
    // Resolve identity first: a `--project src/auth` is normalised to the real
    // project root, so a subdirectory can never become a second project.
    this._context = resolveProjectContext({
      startDir: options?.projectRoot ?? process.cwd(),
      explicitRoot: options?.projectRoot,
    });

    if (options?.db) {
      this._db = options.db;
      this.isDbOwned = false;
    } else {
      // ONE root for both (ADR-49): the database file and the project record are
      // resolved from the same context, so `--project X` can never label a row in
      // another project's database.
      this._db = getDatabase(options?.dbPath, this._context.rootPath);
      this.isDbOwned = true;
    }

    try {
      this._currentProject = ensureProject(this._db, {
        rootPath: this._context.rootPath,
        startDir: this._context.rootPath,
        uid: this._context.uid,
        kind: this._context.kind,
        gitRemote: this._context.gitRemote ?? undefined,
      });
      registerProjectContext(
        {
          ...this._context,
          // The row is the authoritative name once it exists (a rename through
          // `muninn project rename` must not be undone by a directory rename).
          name: this._currentProject.name,
          rootPath: this._currentProject.root_path,
          uid: this._currentProject.uid ?? this._context.uid,
        },
        process.env
      );
    } catch (err) {
      if (this.isDbOwned && this._db?.open) {
        this._db.close();
      }
      throw err;
    }
  }

  public get db(): Database.Database {
    return this._db;
  }

  public get currentProject(): Project {
    return this._currentProject;
  }

  /** True when this service is bound to the cross-project global store. */
  private isGlobalProject(): boolean {
    return (
      path.resolve(this._currentProject.root_path) ===
      path.resolve(globalMemoryDir())
    );
  }

  /**
   * Reads the cross-project store read-only. A missing or corrupt file simply
   * yields no global memories: it must never make a project brief fail.
   */
  private readGlobalObservations(limit: number, query?: string, category?: string | null): Observation[] {
    let db: Database.Database | null = null;
    try {
      db = getReadOnlyDatabase(globalMemoryDbPath());
    } catch {
      return [];
    }
    try {
      const conditions: string[] = ["o.status = 'active'", "o.scope = 'global'"];
      const params: Array<string | number> = [];
      if (category) {
        conditions.push("o.category = ?");
        params.push(category);
      }
      let sql: string;
      if (query) {
        const sanitized = sanitizeFtsQuery(query);
        if (!sanitized) return [];
        sql = `SELECT o.id, o.project_id, o.category, o.title, o.content, o.topic_key,
                      o.status, o.superseded_by, o.scope, o.agent, o.session_id,
                      o.tags, o.files, o.created_at, o.updated_at
               FROM observations_fts
               JOIN observations o ON o.rowid = observations_fts.rowid
               WHERE observations_fts MATCH ? AND ${conditions.join(" AND ")}
               ORDER BY bm25(observations_fts) ASC
               LIMIT ?`;
        params.unshift(sanitized);
      } else {
        sql = `SELECT o.id, o.project_id, o.category, o.title, o.content, o.topic_key,
                      o.status, o.superseded_by, o.scope, o.agent, o.session_id,
                      o.tags, o.files, o.created_at, o.updated_at
               FROM observations o
               WHERE ${conditions.join(" AND ")}
               ORDER BY o.updated_at DESC, o.created_at DESC, o.rowid DESC
               LIMIT ?`;
      }
      params.push(limit);
      return db.prepare<Array<string | number>, Observation>(sql).all(...params);
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  /** Stable uid of the project this service is bound to. */
  public get projectUid(): string {
    return (
      this._currentProject.uid ??
      deriveProjectUid({
        gitRemote: this._currentProject.git_remote,
        rootPath: this._currentProject.root_path || this._context.rootPath,
      })
    );
  }

  /**
   * Default portable snapshot: `$MUNINN_HOME/projects/<uid>/memories.jsonl`.
   * It lives next to the database, outside the repository, so a project that is
   * not a Git repository can snapshot its memory too.
   */
  public memoryExportPath(): string {
    return memoryJsonlPath(this.projectUid);
  }

  /**
   * Screen the durable JSONL export path exactly like the database path
   * (SEC-006): a `.huginn/memories.jsonl` a cloned repository ships as a symlink
   * must be neither written through nor read from — either direction would move
   * project content outside the project (or pull foreign content in, where the
   * MCP memory tools would serve it to the agent).
   */
  private assertMemoryPath(resolvedPath: string, action: string): void {
    const root = this._currentProject.root_path || findGitRoot() || process.cwd();
    assertDocPath(resolvedPath, {
      projectPath: root,
      label: "the Muninn memory export",
      action,
    });
  }

  /**
   * Closes the database connection if managed internally by the service.
   */
  public close(force: boolean = false): void {
    if ((this.isDbOwned || force) && this._db.open) {
      this._db.close();
    }
  }

  /**
   * Saves an observation and transactionally links any provided symbols.
   */
  public saveObservation(input: SaveObservationInput): ObservationWithEntities {
    const requestedScope = input.scope ?? "project";
    if (requestedScope === "global" && !this.isGlobalProject()) {
      const global = new MemoryService({
        dbPath: globalMemoryDbPath(),
        projectRoot: globalMemoryDir(),
      });
      try {
        return global.saveObservation({ ...input, scope: "global" });
      } finally {
        global.close(true);
      }
    }
    const category = input.category as ObservationCategory;
    if (!VALID_CATEGORIES.includes(category)) {
      throw new Error(
        `Invalid category "${input.category}". Allowed categories: ${VALID_CATEGORIES.join(", ")}`
      );
    }

    if (!input.title || typeof input.title !== "string" || !input.title.trim()) {
      throw new Error("Observation title is required and cannot be empty");
    }

    if (
      input.content === undefined ||
      input.content === null ||
      typeof input.content !== "string"
    ) {
      throw new Error("Observation content is required");
    }

    const projectId =
      input.projectId ?? input.project_id ?? this._currentProject.id;
    const topicKey =
      input.topicKey !== undefined
        ? input.topicKey
        : (input.topic_key ?? null);
    const supersedesTopicKey =
      input.supersedesTopicKey !== undefined
        ? input.supersedesTopicKey
        : (input.supersedes_topic_key ?? null);
    const observationId = input.id?.trim() || crypto.randomUUID();

    return this._db.transaction(() => {
      this._db
        .prepare(
          `INSERT INTO observations
             (id, project_id, category, title, content, topic_key, scope, agent, session_id, tags, files)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          observationId,
          projectId,
          category,
          input.title.trim(),
          input.content,
          topicKey,
          requestedScope,
          input.agent ?? null,
          input.sessionId ?? input.session_id ?? null,
          toJsonArray(input.tags),
          toJsonArray(input.files)
        );

      // Explicit decision replacement is part of the same transaction: either
      // the new decision and every supersession link commit together or not at
      // all. Exclude the new row so it never supersedes itself.
      if (
        category === "decision" &&
        supersedesTopicKey !== undefined &&
        supersedesTopicKey !== null
      ) {
        this._db
          .prepare(
            `UPDATE observations
             SET status = 'superseded', superseded_by = ?, updated_at = CURRENT_TIMESTAMP
             WHERE project_id = ?
               AND category = 'decision'
               AND topic_key = ?
               AND status = 'active'
               AND id != ?`
          )
          .run(observationId, projectId, supersedesTopicKey, observationId);
      }

      const symbols = input.symbols ?? [];
      const selectEntityStmt = this._db.prepare<[string, string], Entity>(
        `SELECT id, project_id, entity_type, identifier, file_path
         FROM entities
         WHERE project_id = ? AND identifier = ?`
      );
      const insertEntityStmt = this._db.prepare(
        `INSERT INTO entities (id, project_id, entity_type, identifier, file_path)
         VALUES (?, ?, ?, ?, ?)`
      );
      const linkStmt = this._db.prepare(
        `INSERT OR IGNORE INTO observation_entities (observation_id, entity_id)
         VALUES (?, ?)`
      );

      for (const sym of symbols) {
        const norm = normalizeSymbol(sym);
        let entity = selectEntityStmt.get(projectId, norm.identifier);

        if (!entity) {
          const entityId = crypto.randomUUID();
          insertEntityStmt.run(
            entityId,
            projectId,
            norm.entityType,
            norm.identifier,
            norm.filePath
          );

          entity = {
            id: entityId,
            project_id: projectId,
            entity_type: norm.entityType,
            identifier: norm.identifier,
            file_path: norm.filePath,
          };
        }

        linkStmt.run(observationId, entity.id);
      }

      const observation = this._db
        .prepare<[string], Observation>(
          `SELECT id, project_id, category, title, content, topic_key, status, superseded_by,
                  scope, agent, session_id, tags, files, created_at, updated_at
           FROM observations
           WHERE id = ?`
        )
        .get(observationId);

      if (!observation) {
        throw new Error(
          `Failed to retrieve newly created observation: ${observationId}`
        );
      }

      const entities = this._db
        .prepare<[string], Entity>(
          `SELECT e.id, e.project_id, e.entity_type, e.identifier, e.file_path
           FROM entities e
           JOIN observation_entities oe ON oe.entity_id = e.id
           WHERE oe.observation_id = ?
           ORDER BY e.identifier ASC`
        )
        .all(observationId);

      return {
        ...observation,
        entities,
      };
    })();
  }

  /**
   * Saves a session handoff and supersedes the project's previous active one.
   *
   * The goal and state are required: a handoff that cannot say what was being
   * done and where it stopped is not continuity, it is noise.
   */
  public saveHandoff(input: HandoffInput): Handoff {
    const goal = requireNonEmpty(input.goal, "Handoff goal");
    const state = requireNonEmpty(input.state, "Handoff state");
    const projectId =
      input.projectId ?? input.project_id ?? this._currentProject.id;
    const id = crypto.randomUUID();
    const status = input.closed ? "closed" : "active";

    this._db.transaction(() => {
      if (!input.closed) {
        this._db
          .prepare(
            `UPDATE handoffs
             SET status = 'superseded', superseded_by = ?, updated_at = CURRENT_TIMESTAMP
             WHERE project_id = ? AND status = 'active'`
          )
          .run(id, projectId);
      }
      this._db
        .prepare(
          `INSERT INTO handoffs
             (id, project_id, goal, state, status, agent, session_id, branch,
              files_touched, open_questions, next_steps, decisions, blockers)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          projectId,
          goal,
          state,
          status,
          input.agent ?? null,
          input.sessionId ?? input.session_id ?? null,
          input.branch ?? null,
          toJsonArray(input.filesTouched ?? input.files_touched),
          toJsonArray(input.openQuestions ?? input.open_questions),
          toJsonArray(input.nextSteps ?? input.next_steps),
          toJsonArray(input.decisions),
          toJsonArray(input.blockers)
        );
    })();

    const created = this.getHandoff(id);
    if (!created) {
      throw new Error(`Failed to retrieve newly created handoff: ${id}`);
    }
    return created;
  }

  /** Returns one handoff by id, or null. */
  public getHandoff(id: string): Handoff | null {
    if (!id || !id.trim()) return null;
    const row = this._db
      .prepare<[string], HandoffRow>(
        `SELECT id, project_id, goal, state, status, agent, session_id, branch,
                files_touched, open_questions, next_steps, decisions, blockers,
                created_at, updated_at
         FROM handoffs WHERE id = ?`
      )
      .get(id.trim());
    return row ? rowToHandoff(row) : null;
  }

  /** The handoff a new session should read first. */
  public getActiveHandoff(projectId?: string): Handoff | null {
    const target = projectId ?? this._currentProject.id;
    const row = this._db
      .prepare<[string], HandoffRow>(
        `SELECT id, project_id, goal, state, status, agent, session_id, branch,
                files_touched, open_questions, next_steps, decisions, blockers,
                created_at, updated_at
         FROM handoffs
         WHERE project_id = ? AND status = 'active'
         ORDER BY updated_at DESC, created_at DESC, rowid DESC
         LIMIT 1`
      )
      .get(target);
    return row ? rowToHandoff(row) : null;
  }

  /** Recent handoffs, newest first, bounded. */
  public listHandoffs(options?: {
    projectId?: string;
    limit?: number | null;
    includeSuperseded?: boolean | null;
  }): Handoff[] {
    const target = options?.projectId ?? this._currentProject.id;
    const rawLimit = options?.limit;
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), 200)
        : 20;
    const statusFilter = options?.includeSuperseded
      ? ""
      : " AND status = 'active'";
    return this._db
      .prepare<[string, number], HandoffRow>(
        `SELECT id, project_id, goal, state, status, agent, session_id, branch,
                files_touched, open_questions, next_steps, decisions, blockers,
                created_at, updated_at
         FROM handoffs
         WHERE project_id = ?${statusFilter}
         ORDER BY updated_at DESC, created_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(target, limit)
      .map(rowToHandoff);
  }

  /** Marks the project's active handoff as closed. Returns whether one changed. */
  public closeHandoff(projectId?: string): boolean {
    const target = projectId ?? this._currentProject.id;
    const result = this._db
      .prepare(
        `UPDATE handoffs
         SET status = 'closed', updated_at = CURRENT_TIMESTAMP
         WHERE project_id = ? AND status = 'active'`
      )
      .run(target);
    return result.changes > 0;
  }

  /**
   * Creates or replaces an observation with a deterministic id.
   *
   * This is what makes `muninn seed` idempotent: re-running it refreshes the
   * seeded overview, architecture map, commands and ADRs instead of duplicating
   * them on every run.
   */
  public upsertObservation(
    input: SaveObservationInput & { id: string }
  ): ObservationWithEntities {
    const existing = this._db
      .prepare<[string], { id: string }>(
        "SELECT id FROM observations WHERE id = ?"
      )
      .get(input.id);
    if (!existing) {
      return this.saveObservation(input);
    }
    this._db
      .prepare(
        `UPDATE observations
         SET title = ?, content = ?, category = ?, topic_key = ?, scope = ?,
             agent = ?, session_id = ?, tags = ?, files = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(
        requireNonEmpty(input.title, "Observation title"),
        input.content,
        input.category as string,
        input.topicKey ?? input.topic_key ?? null,
        input.scope ?? "project",
        input.agent ?? null,
        input.sessionId ?? input.session_id ?? null,
        toJsonArray(input.tags),
        toJsonArray(input.files),
        input.id
      );
    const observation = this.loadObservation(input.id);
    if (!observation) {
      throw new Error(`Failed to retrieve observation: ${input.id}`);
    }
    return observation;
  }

  private loadObservation(id: string): ObservationWithEntities | null {
    const row = this._db
      .prepare<[string], Observation>(
        `SELECT id, project_id, category, title, content, topic_key, status,
                superseded_by, scope, agent, session_id, tags, files,
                created_at, updated_at
         FROM observations WHERE id = ?`
      )
      .get(id);
    if (!row) return null;
    const entities = this._db
      .prepare<[string], Entity>(
        `SELECT e.id, e.project_id, e.entity_type, e.identifier, e.file_path
         FROM entities e
         JOIN observation_entities oe ON oe.entity_id = e.id
         WHERE oe.observation_id = ?
         ORDER BY e.identifier ASC`
      )
      .all(id);
    return { ...row, entities };
  }

  /**
   * Retrieves linked entities for observation IDs in chunks of at most 500
   * to prevent exceeding SQLite parameter bounds.
   */
  private _fetchEntitiesForObservations(
    obsIds: string[]
  ): Map<string, Entity[]> {
    const entityMap = new Map<string, Entity[]>();
    if (obsIds.length === 0) {
      return entityMap;
    }

    const CHUNK_SIZE = 500;
    for (let i = 0; i < obsIds.length; i += CHUNK_SIZE) {
      const chunk = obsIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      const entityRows = this._db
        .prepare<any[], Entity & { observation_id: string }>(
          `SELECT e.id, e.project_id, e.entity_type, e.identifier, e.file_path, oe.observation_id
           FROM entities e
           JOIN observation_entities oe ON oe.entity_id = e.id
           WHERE oe.observation_id IN (${placeholders})
           ORDER BY e.identifier ASC`
        )
        .all(...chunk);

      for (const row of entityRows) {
        let list = entityMap.get(row.observation_id);
        if (!list) {
          list = [];
          entityMap.set(row.observation_id, list);
        }
        list.push({
          id: row.id,
          project_id: row.project_id,
          entity_type: row.entity_type,
          identifier: row.identifier,
          file_path: row.file_path,
        });
      }
    }

    return entityMap;
  }

  /**
   * Searches observations using FTS5 BM25 relevance ranking.
   * Query terms are safely sanitized, rank ordering is ASC (lower BM25 = higher relevance),
   * and linked entities are attached to each result.
   */
  public search(options: SearchOptions): SearchResult[] {
    if (!options || !options.query) {
      return [];
    }

    const sanitized = sanitizeFtsQuery(options.query);
    if (!sanitized) {
      return [];
    }

    const conditions: string[] = ["observations_fts MATCH ?"];
    const params: (string | number)[] = [sanitized];

    if (options.category) {
      conditions.push("o.category = ?");
      params.push(options.category);
    }

    if (!options.includeSuperseded && !options.include_superseded) {
      conditions.push("o.status = 'active'");
    }

    if (!options?.allProjects) {
      const explicitProjectId =
        options?.projectId !== undefined
          ? options.projectId
          : options?.project_id;
      const targetProjectId =
        explicitProjectId !== undefined
          ? explicitProjectId
          : this._currentProject.id;
      if (targetProjectId) {
        conditions.push("o.project_id = ?");
        params.push(targetProjectId);
      }
    }

    const parsedLimit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? options.limit
        : 10;
    const limit = Math.min(Math.max(1, parsedLimit), 500);
    params.push(limit);

    const sql = `
      SELECT
        o.id,
        o.project_id,
        o.category,
        o.title,
        o.content,
        o.topic_key,
        o.status,
        o.superseded_by,
        o.created_at,
        o.updated_at,
        bm25(observations_fts) AS rank
      FROM observations_fts
      JOIN observations o ON o.rowid = observations_fts.rowid
      WHERE ${conditions.join(" AND ")}
      ORDER BY rank ASC
      LIMIT ?
    `;

    type RowType = Observation & { rank: number };
    let rows: RowType[];
    try {
      rows = this._db.prepare<any[], RowType>(sql).all(...params);
    } catch (err: unknown) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as any).code)
          : "";
      const message = err instanceof Error ? err.message : String(err);
      const isFatal =
        code.startsWith("SQLITE_IOERR") ||
        code.startsWith("SQLITE_CORRUPT") ||
        code === "SQLITE_NOTADB" ||
        code === "SQLITE_FULL" ||
        code === "SQLITE_CANTOPEN" ||
        /disk i\/o|corrupt|not a database|disk is full/i.test(message);

      if (isFatal) {
        console.error("Fatal SQLite error during search query:", err);
        throw err;
      }

      console.warn("FTS search query execution failed:", message);
      return [];
    }

    const obsIds = rows.map((r) => r.id);
    const entityMap = this._fetchEntitiesForObservations(obsIds);
    const results: SearchResult[] = rows.map((r) => ({
      id: r.id,
      project_id: r.project_id,
      category: r.category,
      title: r.title,
      content: r.content,
      topic_key: r.topic_key,
      status: r.status,
      superseded_by: r.superseded_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
      rank: r.rank,
      entities: entityMap.get(r.id) ?? [],
    }));

    if (options.includeGlobal || options.include_global) {
      const seen = new Set(results.map((result) => result.id));
      for (const observation of this.readGlobalObservations(
        Math.min(limit, 10),
        options.query,
        options.category ?? null
      )) {
        if (seen.has(observation.id)) continue;
        results.push({
          ...observation,
          rank: 1_000 + results.length,
          entities: [],
        });
      }
    }

    return results;
  }

  /**
   * Retrieves recent observations ordered by updated_at DESC, created_at DESC.
   */
  public getContext(options?: ContextOptions): ObservationWithEntities[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options?.category) {
      conditions.push("category = ?");
      params.push(options.category);
    }

    if (!options?.includeSuperseded && !options?.include_superseded) {
      conditions.push("status = 'active'");
    }

    const topicKey =
      options?.topicKey !== undefined ? options.topicKey : options?.topic_key;
    if (topicKey !== undefined && topicKey !== null) {
      conditions.push("topic_key = ?");
      params.push(topicKey);
    }

    if (!options?.allProjects) {
      const explicitProjectId =
        options?.projectId !== undefined
          ? options.projectId
          : options?.project_id;
      const targetProjectId =
        explicitProjectId !== undefined
          ? explicitProjectId
          : this._currentProject.id;
      if (targetProjectId) {
        conditions.push("project_id = ?");
        params.push(targetProjectId);
      }
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const parsedLimit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? options.limit
        : 20;
    const limit = Math.min(Math.max(1, parsedLimit), 500);
    params.push(limit);

    const sql = `
      SELECT id, project_id, category, title, content, topic_key, status, superseded_by, created_at, updated_at
      FROM observations
      ${whereClause}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `;

    const rows = this._db.prepare<any[], Observation>(sql).all(...params);

    const obsIds = rows.map((r) => r.id);
    const entityMap = this._fetchEntitiesForObservations(obsIds);
    const results: ObservationWithEntities[] = rows.map((r) => ({
      id: r.id,
      project_id: r.project_id,
      category: r.category,
      title: r.title,
      content: r.content,
      topic_key: r.topic_key,
      status: r.status,
      superseded_by: r.superseded_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
      entities: entityMap.get(r.id) ?? [],
    }));

    if (options?.includeGlobal || options?.include_global) {
      const seen = new Set(results.map((result) => result.id));
      for (const observation of this.readGlobalObservations(
        Math.min(limit, 10),
        undefined,
        options.category ?? null
      )) {
        if (seen.has(observation.id)) continue;
        results.push({ ...observation, entities: [] });
      }
    }

    return results;
  }

  /**
   * Transactionally links an entity to an observation.
   */
  public linkSymbol(
    inputOrObsId: LinkSymbolInput | string,
    symbolArg?: SymbolInput | string
  ): { observation: Observation; entity: Entity } {
    let observationId: string | undefined;
    let symbol: SymbolInput | string;

    if (typeof inputOrObsId === "string") {
      observationId = inputOrObsId;
      if (!symbolArg) {
        throw new Error("Symbol must be provided to linkSymbol");
      }
      symbol = symbolArg;
    } else {
      observationId =
        inputOrObsId.observationId ??
        inputOrObsId.observation_id;
      symbol = inputOrObsId.symbol;
    }

    if (!observationId) {
      throw new Error("observationId is required for linkSymbol");
    }
    if (!symbol) {
      throw new Error("symbol is required for linkSymbol");
    }

    const observation = this._db
      .prepare<[string], Observation>(
        `SELECT id, project_id, category, title, content, topic_key, status, superseded_by, created_at, updated_at
         FROM observations
         WHERE id = ?`
      )
      .get(observationId);

    if (!observation) {
      throw new Error(`Observation with id "${observationId}" not found`);
    }

    const projectId = observation.project_id;
    const norm = normalizeSymbol(symbol);

    return this._db.transaction(() => {
      let entity = this._db
        .prepare<[string, string], Entity>(
          `SELECT id, project_id, entity_type, identifier, file_path
           FROM entities
           WHERE project_id = ? AND identifier = ?`
        )
        .get(projectId, norm.identifier);

      if (!entity) {
        const entityId = crypto.randomUUID();
        this._db
          .prepare(
            `INSERT INTO entities (id, project_id, entity_type, identifier, file_path)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(
            entityId,
            projectId,
            norm.entityType,
            norm.identifier,
            norm.filePath
          );

        entity = {
          id: entityId,
          project_id: projectId,
          entity_type: norm.entityType,
          identifier: norm.identifier,
          file_path: norm.filePath,
        };
      }

      this._db
        .prepare(
          `INSERT OR IGNORE INTO observation_entities (observation_id, entity_id)
           VALUES (?, ?)`
        )
        .run(observationId, entity.id);

      return {
        observation,
        entity,
      };
    })();
  }

  /**
   * Inspects a symbol in Muninn memory, returning its entity metadata,
   * incoming and outgoing dependencies, and linked observations.
   */
  public inspectSymbol(
    symbol: string,
    projectId?: string
  ): SymbolInspection | null {
    if (!symbol || typeof symbol !== "string" || !symbol.trim()) {
      return null;
    }

    const targetProjectId = projectId ?? this._currentProject.id;
    const entity = resolveEntityByIdentifier(
      this._db,
      targetProjectId,
      symbol.trim()
    );

    if (!entity) {
      return null;
    }

    // Fetch outgoing dependencies
    type DepRow = Entity & { relation_type: DependencyRelationType };
    const outgoingRows = this._db
      .prepare<[string], DepRow>(
        `SELECT e.id, e.project_id, e.entity_type, e.identifier, e.file_path, ed.relation_type
         FROM entity_dependencies ed
         JOIN entities e ON e.id = ed.target_entity_id
         WHERE ed.source_entity_id = ?
         ORDER BY e.identifier ASC`
      )
      .all(entity.id);

    const outgoing: SymbolInspectionDependency[] = outgoingRows.map((r) => ({
      entity: {
        id: r.id,
        project_id: r.project_id,
        entity_type: r.entity_type,
        identifier: r.identifier,
        file_path: r.file_path,
      },
      relationType: r.relation_type,
    }));

    // Fetch incoming dependencies
    const incomingRows = this._db
      .prepare<[string], DepRow>(
        `SELECT e.id, e.project_id, e.entity_type, e.identifier, e.file_path, ed.relation_type
         FROM entity_dependencies ed
         JOIN entities e ON e.id = ed.source_entity_id
         WHERE ed.target_entity_id = ?
         ORDER BY e.identifier ASC`
      )
      .all(entity.id);

    const incoming: SymbolInspectionDependency[] = incomingRows.map((r) => ({
      entity: {
        id: r.id,
        project_id: r.project_id,
        entity_type: r.entity_type,
        identifier: r.identifier,
        file_path: r.file_path,
      },
      relationType: r.relation_type,
    }));

    // Fetch linked observations
    const observations = this._db
      .prepare<[string], Observation>(
        `SELECT o.id, o.project_id, o.category, o.title, o.content, o.topic_key, o.status, o.superseded_by, o.created_at, o.updated_at
         FROM observations o
         JOIN observation_entities oe ON oe.observation_id = o.id
         WHERE oe.entity_id = ?
         ORDER BY o.updated_at DESC, o.created_at DESC`
      )
      .all(entity.id);

    return {
      entity,
      dependencies: {
        outgoing,
        incoming,
      },
      neighbors: collectNeighbors(
        this._db,
        entity,
        DEFAULT_NEIGHBOR_DEPTH,
        DEFAULT_NEIGHBOR_LIMIT
      ),
      observations,
    };
  }

  /**
   * Returns bounded, deterministic graph neighbors for an indexed symbol.
   *
   * Traversal follows stored `entity_dependencies` edges in both directions,
   * groups them by direction and relation, and never returns the same entity
   * twice. Depth is clamped to 1–2 (default 1) and the result limit to 1–50
   * (default 20).
   */
  public neighbors(
    identifier: string,
    options?: NeighborOptions
  ): SymbolNeighbors | null {
    if (!identifier || typeof identifier !== "string" || !identifier.trim()) {
      return null;
    }
    const entity = resolveEntityByIdentifier(
      this._db,
      this._currentProject.id,
      identifier.trim()
    );
    if (!entity) {
      return null;
    }
    return collectNeighbors(
      this._db,
      entity,
      options?.depth,
      options?.limit
    );
  }

  /**
   * Builds the bounded, deterministic session brief from the already-initialized
   * service database. This method itself only reads; the standalone
   * {@link readSessionBrief} entry point is the one that opens a database
   * read-only and fails open when it is missing or unusable.
   */
  public getSessionBrief(options?: SessionBriefOptions): SessionBrief {
    const budgetChars = resolveSessionBriefBudget(options?.budgetChars);
    const selectedPaths = resolveSessionBriefPaths(
      options?.paths,
      this._currentProject.root_path
    );
    const expandGraph = options?.expandGraph !== false;
    try {
      return assembleSessionBrief(
        this._db,
        sessionBriefProjectFromRow(this._currentProject),
        this._currentProject.id,
        selectedPaths,
        budgetChars,
        [],
        expandGraph
      );
    } catch (err) {
      return buildUnavailableSessionBrief(
        this._currentProject.root_path,
        selectedPaths,
        budgetChars,
        err,
        this._currentProject
      );
    }
  }

  /**
   * Retrieves aggregate counts of projects, observations, entities, and links.
   */
  public getStats(projectId?: string): MemoryStats {
    if (projectId) {
      const pCount =
        this._db
          .prepare<[string], { count: number }>(
            "SELECT COUNT(*) as count FROM projects WHERE id = ?"
          )
          .get(projectId)?.count ?? 0;
      const oCount =
        this._db
          .prepare<[string], { count: number }>(
            "SELECT COUNT(*) as count FROM observations WHERE project_id = ?"
          )
          .get(projectId)?.count ?? 0;
      const eCount =
        this._db
          .prepare<[string], { count: number }>(
            "SELECT COUNT(*) as count FROM entities WHERE project_id = ?"
          )
          .get(projectId)?.count ?? 0;
      const lCount =
        this._db
          .prepare<[string], { count: number }>(
            `SELECT COUNT(*) as count
             FROM observation_entities oe
             JOIN observations o ON o.id = oe.observation_id
             WHERE o.project_id = ?`
          )
          .get(projectId)?.count ?? 0;

      return {
        projects: pCount,
        observations: oCount,
        entities: eCount,
        links: lCount,
      };
    }

    const pCount =
      this._db
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) as count FROM projects"
        )
        .get()?.count ?? 0;
    const oCount =
      this._db
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) as count FROM observations"
        )
        .get()?.count ?? 0;
    const eCount =
      this._db
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) as count FROM entities"
        )
        .get()?.count ?? 0;
    const lCount =
      this._db
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) as count FROM observation_entities"
        )
        .get()?.count ?? 0;

    return {
      projects: pCount,
      observations: oCount,
      entities: eCount,
      links: lCount,
    };
  }

  /**
   * Exports all observations with linked entities to a JSON Lines (.jsonl) file.
   */
  public syncToDisk(
    targetPath?: string,
    options?: { projectId?: string; allProjects?: boolean }
  ): { path: string; count: number; handoffs: number };
  public syncToDisk(
    options?: { projectId?: string; allProjects?: boolean }
  ): { path: string; count: number; handoffs: number };
  public syncToDisk(
    targetPathOrOptions?: string | { projectId?: string; allProjects?: boolean },
    optionsArg?: { projectId?: string; allProjects?: boolean }
  ): { path: string; count: number; handoffs: number } {
    let targetPath: string | undefined;
    let options: { projectId?: string; allProjects?: boolean } | undefined;

    if (typeof targetPathOrOptions === "object" && targetPathOrOptions !== null) {
      options = targetPathOrOptions;
      targetPath = undefined;
    } else {
      targetPath = targetPathOrOptions;
      options = optionsArg;
    }

    let resolvedPath: string;
    if (targetPath) {
      if (path.isAbsolute(targetPath)) {
        resolvedPath = path.resolve(targetPath);
      } else {
        const root =
          this._currentProject.root_path || findGitRoot() || process.cwd();
        resolvedPath = path.resolve(root, targetPath);
      }
    } else {
      resolvedPath = this.memoryExportPath();
    }

    this.assertMemoryPath(resolvedPath, "write");

    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const targetProjectId = options?.projectId ?? this._currentProject.id;
    let observations: Observation[];
    let entityRows: (Entity & { observation_id: string })[];

    if (options?.allProjects === true) {
      observations = this._db
        .prepare<[], Observation>(
          `SELECT id, project_id, category, title, content, topic_key, status, superseded_by,
                  scope, agent, session_id, tags, files, created_at, updated_at
           FROM observations
           ORDER BY created_at ASC`
        )
        .all();

      entityRows = this._db
        .prepare<[], Entity & { observation_id: string }>(
          `SELECT e.id, e.project_id, e.entity_type, e.identifier, e.file_path, oe.observation_id
           FROM entities e
           JOIN observation_entities oe ON oe.entity_id = e.id
           ORDER BY e.identifier ASC`
        )
        .all();
    } else {
      observations = this._db
        .prepare<[string], Observation>(
          `SELECT id, project_id, category, title, content, topic_key, status, superseded_by,
                  scope, agent, session_id, tags, files, created_at, updated_at
           FROM observations
           WHERE project_id = ?
           ORDER BY created_at ASC`
        )
        .all(targetProjectId);

      entityRows = this._db
        .prepare<[string], Entity & { observation_id: string }>(
          `SELECT e.id, e.project_id, e.entity_type, e.identifier, e.file_path, oe.observation_id
           FROM entities e
           JOIN observation_entities oe ON oe.entity_id = e.id
           JOIN observations o ON o.id = oe.observation_id
           WHERE o.project_id = ?
           ORDER BY e.identifier ASC`
        )
        .all(targetProjectId);
    }

    const entityMap = new Map<string, Entity[]>();
    for (const row of entityRows) {
      let list = entityMap.get(row.observation_id);
      if (!list) {
        list = [];
        entityMap.set(row.observation_id, list);
      }
      list.push({
        id: row.id,
        project_id: row.project_id,
        entity_type: row.entity_type,
        identifier: row.identifier,
        file_path: row.file_path,
      });
    }

    const lines = observations.map((obs) => {
      const record: ObservationWithEntities = {
        ...obs,
        entities: entityMap.get(obs.id) ?? [],
      };
      return JSON.stringify(record);
    });

    // Handoffs travel with the snapshot: continuity is the point of a snapshot.
    const handoffRows =
      options?.allProjects === true
        ? this._db
            .prepare<[], HandoffRow>(
              `SELECT id, project_id, goal, state, status, agent, session_id, branch,
                      files_touched, open_questions, next_steps, decisions, blockers,
                      created_at, updated_at
               FROM handoffs ORDER BY created_at ASC`
            )
            .all()
        : this._db
            .prepare<[string], HandoffRow>(
              `SELECT id, project_id, goal, state, status, agent, session_id, branch,
                      files_touched, open_questions, next_steps, decisions, blockers,
                      created_at, updated_at
               FROM handoffs WHERE project_id = ? ORDER BY created_at ASC`
            )
            .all(targetProjectId);
    for (const row of handoffRows) {
      lines.push(
        JSON.stringify({
          type: "handoff",
          id: row.id,
          project_id: row.project_id,
          goal: row.goal,
          state: row.state,
          status: row.status,
          agent: row.agent,
          session_id: row.session_id,
          branch: row.branch,
          files_touched: parseJsonArray(row.files_touched),
          open_questions: parseJsonArray(row.open_questions),
          next_steps: parseJsonArray(row.next_steps),
          decisions: parseJsonArray(row.decisions),
          blockers: parseJsonArray(row.blockers),
          created_at: row.created_at,
          updated_at: row.updated_at,
        })
      );
    }

    const tmpPath = `${resolvedPath}.tmp`;
    try {
      fs.writeFileSync(
        tmpPath,
        lines.length > 0 ? lines.join("\n") + "\n" : "",
        { encoding: "utf-8", mode: 0o600 }
      );
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch {
        // ignore on platforms where chmod fails
      }
      fs.renameSync(tmpPath, resolvedPath);
    } catch (err) {
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore cleanup error
        }
      }
      throw err;
    }

    return {
      path: resolvedPath,
      count: observations.length,
      handoffs: handoffRows.length,
    };
  }

  /**
   * Reads a JSON Lines (.jsonl) file and idempotently imports records into the database.
   */
  public importFromDisk(sourcePath?: string): {
    imported: number;
    skipped: number;
  } {
    let resolvedPath: string;
    if (sourcePath) {
      if (path.isAbsolute(sourcePath)) {
        resolvedPath = path.resolve(sourcePath);
      } else {
        const root =
          this._currentProject.root_path || findGitRoot() || process.cwd();
        resolvedPath = path.resolve(root, sourcePath);
      }
    } else {
      resolvedPath = this.memoryExportPath();
    }

    this.assertMemoryPath(resolvedPath, "read");

    if (!fs.existsSync(resolvedPath)) {
      return { imported: 0, skipped: 0 };
    }

    const content = fs.readFileSync(resolvedPath, "utf-8");
    const rawLines = content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    let imported = 0;
    let skipped = 0;

    const importTx = this._db.transaction(() => {
      const checkObsStmt = this._db.prepare<[string], { id: string }>(
        "SELECT id FROM observations WHERE id = ?"
      );
      const checkProjStmt = this._db.prepare<[string], { id: string }>(
        "SELECT id FROM projects WHERE id = ?"
      );
      const insertObsStmt = this._db.prepare(
        `INSERT INTO observations
           (id, project_id, category, title, content, topic_key, status, superseded_by,
            scope, agent, session_id, tags, files, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const findEntityStmt = this._db.prepare<[string, string], Entity>(
        `SELECT id, project_id, entity_type, identifier, file_path
         FROM entities
         WHERE project_id = ? AND identifier = ?`
      );
      const insertEntityStmt = this._db.prepare(
        `INSERT INTO entities (id, project_id, entity_type, identifier, file_path)
         VALUES (?, ?, ?, ?, ?)`
      );
      const linkStmt = this._db.prepare(
        `INSERT OR IGNORE INTO observation_entities (observation_id, entity_id)
         VALUES (?, ?)`
      );
      const insertHandoffStmt = this._db.prepare(
        `INSERT OR IGNORE INTO handoffs
           (id, project_id, goal, state, status, agent, session_id, branch,
            files_touched, open_questions, next_steps, decisions, blockers,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const line of rawLines) {
        let record: any;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }

        if (!record || typeof record !== "object") {
          continue;
        }

        if (record.type === "handoff") {
          if (
            typeof record.id !== "string" ||
            !record.id.trim() ||
            typeof record.goal !== "string" ||
            typeof record.state !== "string"
          ) {
            continue;
          }
          const handoffProjectId =
            typeof record.project_id === "string" &&
            checkProjStmt.get(record.project_id)
              ? record.project_id
              : this._currentProject.id;
          const status = ["active", "superseded", "closed"].includes(
            String(record.status)
          )
            ? String(record.status)
            : "active";
          const result = insertHandoffStmt.run(
            record.id,
            handoffProjectId,
            record.goal,
            record.state,
            status,
            record.agent ?? null,
            record.session_id ?? null,
            record.branch ?? null,
            toJsonArray(record.files_touched),
            toJsonArray(record.open_questions),
            toJsonArray(record.next_steps),
            toJsonArray(record.decisions),
            toJsonArray(record.blockers),
            record.created_at ?? new Date().toISOString(),
            record.updated_at ?? record.created_at ?? new Date().toISOString()
          );
          if (result.changes > 0) imported++;
          else skipped++;
          continue;
        }

        if (
          !(
            typeof record.id === "string" &&
            typeof record.title === "string" &&
            typeof record.content === "string"
          ) ||
          !record.id.trim() ||
          !record.title.trim()
        ) {
          continue;
        }

        const existing = checkObsStmt.get(record.id);
        if (existing) {
          skipped++;
          continue;
        }

        let projectId = record.project_id ?? record.projectId;
        if (!projectId || !checkProjStmt.get(projectId)) {
          projectId = this._currentProject.id;
        }

        const category = (VALID_CATEGORIES as readonly string[]).includes(
          record.category
        )
          ? record.category
          : "decision";

        const topicKey =
          record.topic_key !== undefined
            ? record.topic_key
            : (record.topicKey ?? null);
        const createdAt = record.created_at ?? new Date().toISOString();
        const updatedAt = record.updated_at ?? createdAt;
        const status = record.status === "superseded" ? "superseded" : "active";
        const supersededBy =
          record.superseded_by ?? record.supersededBy ?? null;

        insertObsStmt.run(
          record.id,
          projectId,
          category,
          record.title,
          record.content,
          topicKey,
          status,
          supersededBy,
          record.scope === "global" ? "global" : "project",
          record.agent ?? null,
          record.session_id ?? record.sessionId ?? null,
          record.tags ?? null,
          record.files ?? null,
          createdAt,
          updatedAt
        );

        const symbols = record.entities ?? record.symbols ?? [];
        if (Array.isArray(symbols)) {
          for (const sym of symbols) {
            const norm = normalizeSymbol(sym);
            let entity = findEntityStmt.get(projectId, norm.identifier);
            let entityId: string;
            if (entity) {
              entityId = entity.id;
            } else {
              entityId = sym.id ?? crypto.randomUUID();
              insertEntityStmt.run(
                entityId,
                projectId,
                norm.entityType,
                norm.identifier,
                norm.filePath
              );
            }
            linkStmt.run(record.id, entityId);
          }
        }

        imported++;
      }
    });

    importTx();
    return { imported, skipped };
  }
}

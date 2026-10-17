import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { assertDocPath } from "../util/path-safety.js";
import {
  getDatabase,
  ensureProject,
  findGitRoot,
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
  projectId?: string;
  project_id?: string;
  symbols?: Array<SymbolInput | string> | null;
}

export interface SearchOptions {
  query: string;
  category?: ObservationCategory | string | null;
  projectId?: string | null;
  project_id?: string | null;
  allProjects?: boolean | null;
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
  getStats(projectId?: string): MemoryStats;
  syncToDisk(
    targetPath?: string,
    options?: { projectId?: string; allProjects?: boolean }
  ): { path: string; count: number };
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

export class MemoryService implements IMemoryService {
  private readonly _db: Database.Database;
  private readonly _currentProject: Project;
  private readonly isDbOwned: boolean;

  constructor(options?: MemoryServiceOptions) {
    if (options?.db) {
      this._db = options.db;
      this.isDbOwned = false;
    } else {
      // ONE root for both (ADR-49): the database file and the project record are
      // resolved from `projectRoot`, so `--project X` can never label a row in
      // another project's database.
      this._db = getDatabase(options?.dbPath, options?.projectRoot);
      this.isDbOwned = true;
    }

    try {
      this._currentProject = ensureProject(this._db, {
        rootPath: options?.projectRoot,
        startDir: options?.projectRoot,
      });
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
    const observationId = crypto.randomUUID();

    return this._db.transaction(() => {
      this._db
        .prepare(
          `INSERT INTO observations (id, project_id, category, title, content, topic_key)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          observationId,
          projectId,
          category,
          input.title.trim(),
          input.content,
          topicKey
        );

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
          `SELECT id, project_id, category, title, content, topic_key, created_at, updated_at
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

    if (rows.length === 0) {
      return [];
    }

    const obsIds = rows.map((r) => r.id);
    const entityMap = this._fetchEntitiesForObservations(obsIds);

    return rows.map((r) => ({
      id: r.id,
      project_id: r.project_id,
      category: r.category,
      title: r.title,
      content: r.content,
      topic_key: r.topic_key,
      created_at: r.created_at,
      updated_at: r.updated_at,
      rank: r.rank,
      entities: entityMap.get(r.id) ?? [],
    }));
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
      SELECT id, project_id, category, title, content, topic_key, created_at, updated_at
      FROM observations
      ${whereClause}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `;

    const rows = this._db.prepare<any[], Observation>(sql).all(...params);

    if (rows.length === 0) {
      return [];
    }

    const obsIds = rows.map((r) => r.id);
    const entityMap = this._fetchEntitiesForObservations(obsIds);

    return rows.map((r) => ({
      id: r.id,
      project_id: r.project_id,
      category: r.category,
      title: r.title,
      content: r.content,
      topic_key: r.topic_key,
      created_at: r.created_at,
      updated_at: r.updated_at,
      entities: entityMap.get(r.id) ?? [],
    }));
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
        `SELECT id, project_id, category, title, content, topic_key, created_at, updated_at
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
   * Escapes LIKE pattern special characters (%, _, \)
   */
  private _escapeLikePattern(str: string): string {
    return str.replace(/[\\%_]/g, "\\$&");
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
    const query = symbol.trim();

    // 1. Try exact match
    let entity = this._db
      .prepare<[string, string], Entity>(
        `SELECT id, project_id, entity_type, identifier, file_path
         FROM entities
         WHERE project_id = ? AND identifier = ?`
      )
      .get(targetProjectId, query);

    const escapedQuery = this._escapeLikePattern(query);

    // 2. Try suffix match (e.g. searching 'run' matches 'src/app.ts::run', or 'login' matches 'src/auth.ts::AuthManager.login')
    // Supports matching class methods with canonical format <relPath>::<ClassName>.<methodName> (REV-005, REV-008, SEC-004)
    if (!entity) {
      entity = this._db
        .prepare<[string, string, string], Entity>(
          `SELECT id, project_id, entity_type, identifier, file_path
           FROM entities
           WHERE project_id = ? AND (identifier LIKE '%::' || ? ESCAPE '\\' OR identifier LIKE '%.' || ? ESCAPE '\\')
           ORDER BY identifier ASC
           LIMIT 1`
        )
        .get(targetProjectId, escapedQuery, escapedQuery);
    }

    // 3. Try prefix match or file_path match
    if (!entity) {
      entity = this._db
        .prepare<[string, string, string], Entity>(
          `SELECT id, project_id, entity_type, identifier, file_path
           FROM entities
           WHERE project_id = ? AND (identifier LIKE ? || '%' ESCAPE '\\' OR file_path = ?)
           ORDER BY identifier ASC
           LIMIT 1`
        )
        .get(targetProjectId, escapedQuery, query);
    }

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
        `SELECT o.id, o.project_id, o.category, o.title, o.content, o.topic_key, o.created_at, o.updated_at
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
      observations,
    };
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
  ): { path: string; count: number };
  public syncToDisk(
    options?: { projectId?: string; allProjects?: boolean }
  ): { path: string; count: number };
  public syncToDisk(
    targetPathOrOptions?: string | { projectId?: string; allProjects?: boolean },
    optionsArg?: { projectId?: string; allProjects?: boolean }
  ): { path: string; count: number } {
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
      const root =
        this._currentProject.root_path || findGitRoot() || process.cwd();
      resolvedPath = path.join(root, ".huginn", "memories.jsonl");
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
          `SELECT id, project_id, category, title, content, topic_key, created_at, updated_at
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
          `SELECT id, project_id, category, title, content, topic_key, created_at, updated_at
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
      const root =
        this._currentProject.root_path || findGitRoot() || process.cwd();
      resolvedPath = path.join(root, ".huginn", "memories.jsonl");
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
        `INSERT INTO observations (id, project_id, category, title, content, topic_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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

      for (const line of rawLines) {
        let record: any;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }

        if (
          !record ||
          typeof record !== "object" ||
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

        insertObsStmt.run(
          record.id,
          projectId,
          category,
          record.title,
          record.content,
          topicKey,
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

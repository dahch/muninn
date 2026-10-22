# Muninn — Technical Design

This is the design of the memory engine, moved from the orchestrator's `DESIGN.md` (its sections 13–18)
when Muninn became its own package. Paths were rewritten to this repository's layout: `src/db/`,
`src/service/`, `src/indexer/`, `src/mcp/`, `src/contracts/` and `src/commands/`, with the tests under
`test/`.

Two conventions carried over unchanged: the database lives at `<git-root>/.huginn/muninn.db` (the data
directory belongs to the orchestrator too, and both read and write the same file), and the MCP server
is the integration surface agents use. The `huginn memory`, `huginn check` and `huginn mcp run`
commands are thin wrappers over this package.

## 1. Muninn Memory Engine — Database Layer & SQLite FTS5 Schema

The `src/db/` package provides embedded, local-first persistence for project memories, code symbol entity linkages, and BM25 full-text search without external network calls or vector API keys.

### Path Resolution Architecture

`resolveDatabasePath(customPath?, startDir?)` determines the SQLite database location based on repository context:

```mermaid
flowchart TD
    A["resolveDatabasePath(customPath, startDir)"] --> B{"customPath provided and non-empty?"}
    B -- Yes --> C["Return customPath (:memory: or explicit file)"]
    B -- No --> D["findGitRoot(startDir)"]
    D -- Git repository found --> E["Return <git_root>/.huginn/muninn.db"]
    D -- Not inside git repo --> F["Return ~/.huginn/muninn.db"]
```

- When `customPath` is passed and not empty (`""`), it is returned directly (enabling `:memory:` for isolated unit tests or explicit file paths).
- `findGitRoot(startDir)` searches upward through parent directories until it encounters a `.git` folder or file.
- If a git root is discovered, the database path resolves to `<git_root>/.huginn/muninn.db`.
- If no git repository is present, it falls back to the user's home profile at `~/.huginn/muninn.db`.
- If the resolved path is not `:memory:`, `getDatabase` ensures the target directory exists by calling `fs.mkdirSync(dir, { recursive: true, mode: 0o700 })`, restricting filesystem permissions to the owner.

#### One root for the database and the project record (ADR-49 / REQ-50)

The database **file** and the project **row** used to be resolved independently — the file from
`process.cwd()`, the row from the caller's `rootPath` — so `muninn mcp run --project X` executed from a
working directory inside `Y` labelled a row in **Y's** database. Both now come from one root:

- **`getDatabase(dbPath?, startDir?)`** forwards `startDir` to `resolveDatabasePath(dbPath, startDir)`.
  `MemoryService` passes `options.projectRoot`, so the file lives at `<project>/.huginn/muninn.db`
  regardless of the process's cwd.
- **`ensureProject(db, options?)`** takes the same `startDir` for its fallback: with no explicit
  `rootPath` it resolves `findGitRoot(resolve(startDir)) ?? resolve(startDir)` instead of an independent
  `findGitRoot()` of the cwd — so a caller cannot pick two different roots for the two halves.
- **Screened writes**: before opening, `getDatabase` runs the resolved path through the shared
  `assertDocPath` (`projectPath` = the git root of `startDir`, label `"the Muninn database"`,
  `action: "write"`). The screen refuses a symlinked final component always and demands that a
  project-relative path resolve inside the project, so a cloned repository shipping `.huginn/`
  — or `muninn.db` itself — as a symlink (or a symlinked parent) cannot redirect the SQLite write
  outside the project (SEC-005). `MemoryService.assertMemoryPath`
  applies the same screen to the durable JSONL export in **both** directions (`syncToDisk` writes,
  `importFromDisk` reads), because a readable foreign `memories.jsonl` would be served to the agent
  through the MCP memory tools (SEC-006).
- **Diagnosis, not repair**: `huginn doctor`'s non-critical `muninn-attribution` check lists `projects`
  rows whose `root_path` is not the project root, comparing `realpath`ed paths so a symlink alias (or
  macOS `/tmp` vs `/private/tmp`) is not a false positive, and deletes nothing.

### SQLite Connection & PRAGMA Configuration

Every connection initialized via `getDatabase(dbPath?)` instantiates a `better-sqlite3` instance with a 5000ms connection timeout and configures four essential pragmas before executing migrations:

```ts
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("recursive_triggers = ON");
```

| PRAGMA | Purpose & Operational Impact |
|---|---|
| `foreign_keys = ON` | Enforces referential integrity with `ON DELETE CASCADE`. Deleting a project cascades to its observations, entities, observation_entities join rows, and entity_dependencies links. |
| `journal_mode = WAL` | Enables Write-Ahead Logging. Permits concurrent readers alongside a writer, avoids table locks during read spikes, and protects against crash corruption. |
| `busy_timeout = 5000` | Sets a 5-second wait queue when SQLite encounters database contention rather than throwing an immediate `SQLITE_BUSY` error. |
| `recursive_triggers = ON` | Enables cascading deletes to activate triggers on child tables. **Crucial for FTS5 consistency**: when a project is deleted, cascade deletion removes rows in `observations`; `recursive_triggers = ON` ensures the `obs_ad` trigger fires and deletes the corresponding records from `observations_fts`. |

If pragma initialization or DDL execution throws an exception, `getDatabase` immediately closes the database handle before re-throwing, ensuring no leaked file descriptors or locks.

### Schema & Entity-Relationship Design

The database DDL is defined in `src/db/schema.sql` and mirrored in `src/db/client.ts` (`SCHEMA_SQL` fallback):

```mermaid
erDiagram
    PROJECTS ||--o{ OBSERVATIONS : "contains (CASCADE)"
    PROJECTS ||--o{ ENTITIES : "contains (CASCADE)"
    OBSERVATIONS ||--o{ OBSERVATION_ENTITIES : "links (CASCADE)"
    ENTITIES ||--o{ OBSERVATION_ENTITIES : "links (CASCADE)"
    ENTITIES ||--o{ ENTITY_DEPENDENCIES : "source (CASCADE)"
    ENTITIES ||--o{ ENTITY_DEPENDENCIES : "target (CASCADE)"
    OBSERVATIONS ||--|| OBSERVATIONS_FTS : "triggers sync"

    PROJECTS {
        text id PK
        text name
        text git_remote
        text root_path UK
        datetime created_at
    }
    OBSERVATIONS {
        text id PK
        text project_id FK
        text category
        text title
        text content
        text topic_key
        datetime created_at
        datetime updated_at
    }
    ENTITIES {
        text id PK
        text project_id FK
        text entity_type
        text identifier
        text file_path
    }
    OBSERVATION_ENTITIES {
        text observation_id PK_FK
        text entity_id PK_FK
    }
    ENTITY_DEPENDENCIES {
        text source_entity_id PK_FK
        text target_entity_id PK_FK
        text relation_type PK
    }
    OBSERVATIONS_FTS {
        text title
        text content
        text topic_key
    }
```

#### Table Specifications

1. **`projects`**:
   - Primary key: `id TEXT PRIMARY KEY`.
   - `root_path TEXT NOT NULL UNIQUE` indexed by `idx_projects_root_path`.
   - `git_remote TEXT`: sanitized origin URL.
   - `name TEXT NOT NULL`, `created_at DATETIME DEFAULT CURRENT_TIMESTAMP`.

2. **`observations`**:
   - Primary key: `id TEXT PRIMARY KEY`.
   - `project_id TEXT NOT NULL` with `FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE`.
   - `category TEXT NOT NULL` constrained by `CHECK(category IN ('decision', 'convention', 'discovery', 'bugfix', 'architecture'))`.
   - `title TEXT NOT NULL`, `content TEXT NOT NULL`, `topic_key TEXT`.
   - Timestamps `created_at` and `updated_at`.
   - Indexes: `idx_observations_project_id`, `idx_observations_updated_at`, and `idx_observations_project_updated ON observations(project_id, updated_at DESC, created_at DESC)`.

3. **`observations_fts` (SQLite FTS5 Virtual Table)**:
   - External-content FTS5 table indexing `title`, `content`, and `topic_key` referencing `observations` via `content='observations', content_rowid='rowid'`.
   - Synchronized by three database triggers:
     - `obs_ai`: `AFTER INSERT ON observations` inserts `new.rowid`, `new.title`, `new.content`, `new.topic_key`.
     - `obs_ad`: `AFTER DELETE ON observations` deletes `old.rowid` entry.
     - `obs_au`: `AFTER UPDATE ON observations` deletes `old.rowid` and inserts updated fields for `new.rowid`.

4. **`entities`**:
   - Represents code symbols (AST functions, classes, interfaces, modules) or files.
   - Primary key: `id TEXT PRIMARY KEY`.
   - `project_id TEXT NOT NULL` with `FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE`.
   - `entity_type TEXT NOT NULL` constrained by `CHECK(entity_type IN ('file', 'function', 'class', 'interface', 'module'))`.
   - `identifier TEXT NOT NULL` (e.g. `src/auth.ts::login`), `file_path TEXT NOT NULL`.
   - Unique index `idx_entities_project_identifier ON entities(project_id, identifier)` prevents duplicate symbols per project.

5. **`observation_entities`**:
   - Join table linking observations to code entities.
   - Composite primary key: `PRIMARY KEY(observation_id, entity_id)`.
   - Cascading foreign keys: `FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE`, `FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE`.
   - Index: `idx_observation_entities_entity_id ON observation_entities(entity_id)`.

6. **`entity_dependencies`**:
   - Represents topological dependency and structural relationships between code entities (e.g. imports, function/method calls, interface implementations, class extensions, file-to-symbol references).
   - Composite primary key: `PRIMARY KEY(source_entity_id, target_entity_id, relation_type)`.
   - Cascading foreign keys:
     - `FOREIGN KEY(source_entity_id) REFERENCES entities(id) ON DELETE CASCADE`
     - `FOREIGN KEY(target_entity_id) REFERENCES entities(id) ON DELETE CASCADE`
   - `relation_type TEXT NOT NULL` constrained by `CHECK(relation_type IN ('imports', 'calls', 'implements', 'extends', 'references'))`.
   - Indexes:
     - `idx_entity_deps_source ON entity_dependencies(source_entity_id)` for outgoing dependency traversals.
     - `idx_entity_deps_target ON entity_dependencies(target_entity_id)` for incoming impact / caller lookups.

### Project Bootstrapping & Credential Sanitization

- **`ensureProject(db, options?)`**:
  - Resolves `rootPath` from options, nearest `.git` root, or `process.cwd()`.
  - Performs an idempotent query `SELECT ... FROM projects WHERE root_path = ?`. If found, returns the existing record.
  - If not found, generates a UUID, extracts project name (from directory basename or fallback `"project"`), reads origin URL from `.git/config` using `tryGetGitRemote`, and inserts the new project record.
- **`sanitizeGitRemote(rawUrl)`**:
  - Detects and strips user and password authentication tokens embedded in URLs (e.g. `https://oauth2:token@github.com/...` -> `https://github.com/...`).
  - Supports standard HTTP(S) URLs as well as SSH and SCP-like syntax.
  - Guarantees sensitive personal access tokens or credentials are never leaked into the database.

## 2. Muninn Memory Engine — MemoryService Core & Persistence API

The `MemoryService` (`src/service/memory-service.ts`) sits at the application core of the Muninn subsystem. It encapsulates business rules, SQLite transactions, symbol normalization, FTS5 query sanitization, and portable disk synchronization.

### Architecture & Component Interaction

```mermaid
flowchart TD
    subgraph Consumers["Driving Adapters"]
        CLI["Muninn CLI (muninn memory ...)"]
        MCP["MCP Server (stdio JSON-RPC)"]
        Agent["AI Coding Agents"]
    end

    subgraph ServiceCore["MemoryService (src/service/)"]
        MS["MemoryService"]
        Norm["normalizeSymbol()"]
        Sanitize["sanitizeFtsQuery()"]
        Chunk["_fetchEntitiesForObservations()"]
    end

    subgraph Storage["Persistence Layer (src/db/)"]
        DB[("better-sqlite3 (WAL Mode)")]
        FTS[("observations_fts (FTS5)")]
        Disk[(".huginn/memories.jsonl (0o600)")]
    end

    Consumers --> MS
    MS --> Norm
    MS --> Sanitize
    MS --> Chunk
    MS --> DB
    DB -. "Triggers (obs_ai/ad/au)" .-> FTS
    MS <--> Disk
```

### Detailed Method Specifications

#### 1. `saveObservation(input: SaveObservationInput): ObservationWithEntities`

Creates a new observation and links code symbols in a single atomic transaction (`db.transaction`):

```mermaid
sequenceDiagram
    participant C as Consumer
    participant S as MemoryService
    participant DB as SQLite DB
    participant T as FTS5 Triggers

    C->>S: saveObservation(category, title, content, symbols)
    Note over S: Validate category against VALID_CATEGORIES
    Note over S: Verify title & content are non-empty strings
    S->>DB: BEGIN TRANSACTION
    S->>DB: INSERT INTO observations (id, project_id, category, title, content, topic_key)
    DB-->>T: obs_ai trigger fires to update observations_fts
    loop For each symbol
        Note over S: normalizeSymbol(symbol)
        S->>DB: SELECT id FROM entities WHERE project_id AND identifier
        alt Entity exists
            Note over S: Reuse existing entity ID
        else Entity does not exist
            S->>DB: INSERT INTO entities (id, project_id, entity_type, identifier, file_path)
        end
        S->>DB: INSERT OR IGNORE INTO observation_entities (observation_id, entity_id)
    end
    S->>DB: COMMIT TRANSACTION
    S-->>C: ObservationWithEntities
```

- **Category Validation**: Must match one of `VALID_CATEGORIES` (`"decision"`, `"convention"`, `"discovery"`, `"bugfix"`, `"architecture"`). Throws an error for invalid categories.
- **Symbol Normalization (`normalizeSymbol`)**: Accepts string shorthand (`"src/db.ts::connect"`, `"src/config.ts"`, `"myFunc"`) or structured objects (`{ name, filePath, type, identifier }`). Generates canonical identifiers, resolves file paths, and assigns entity types (`file`, `function`, `class`, `interface`, `module`).
- **Entity Deduplication**: Identical normalized symbols within the same observation input are deduplicated before insertion.
- **Transaction Safety**: Insertion of the observation row, creation of new entities, and linking in `observation_entities` are completely atomic.

#### 2. `search(options: SearchOptions): SearchResult[]`

Executes BM25 full-text keyword searches across observations:

- **Query Sanitization (`sanitizeFtsQuery`)**:
  - Regex tokenization extracts double-quoted phrases and individual words.
  - Alphanumeric words and phrases are wrapped in double quotes (e.g. `"MemoryService::saveObservation"`, `"src/client.ts"`) to treat punctuation, slashes, and colons as literal search terms rather than FTS5 syntax operators.
  - Trailing asterisks are preserved for prefix search (`"token"*`).
  - Standalone syntax operators (e.g. `*`, `///`, `:::`, `---`) and empty whitespace queries are stripped. If no valid terms remain, an empty array `[]` is returned safely without executing the query or throwing syntax errors.
- **Relevance Ranking**: Results are ordered by `bm25(observations_fts) ASC` (in SQLite FTS5 BM25, lower scores indicate higher relevance).
- **Project Scoping**: Searches default to `currentProject.id`. Scoping can be overridden with an explicit `projectId` / `project_id`, or expanded globally with `allProjects: true`.
- **Entity Attachment**: Hydrates linked entities for all matching observations via `_fetchEntitiesForObservations`.
- **Limit Clamping**: Limits are clamped between `1` and `500` (default: `10`).

#### 3. `getContext(options?: ContextOptions): ObservationWithEntities[]`

Retrieves recent observations for context window injection:

- **Chronological Ordering**: Ordered by `updated_at DESC, created_at DESC`.
- **Performance Optimization**: Accelerated by the compound index `idx_observations_project_updated ON observations(project_id, updated_at DESC, created_at DESC)`.
- **Filters**: Supports filtering by `category`, `topicKey` / `topic_key`, and `projectId` / `project_id` (or `allProjects: true`).
- **Chunked Entity Fetching (`_fetchEntitiesForObservations`)**:
  - Joins between observations and entities are loaded in batches of at most 500 observation IDs at a time (`WHERE oe.observation_id IN (?, ?, ...)`).
  - This avoids exceeding SQLite host parameter limits (`SQLITE_LIMIT_VARIABLE_NUMBER`) even when requesting up to 500 observations.
- **Limit Clamping**: Limits are clamped between `1` and `500` (default: `20`).

#### 4. `linkSymbol(inputOrObsId, symbolArg)`

Associates an entity with an existing observation:

- **Flexible Signatures**: Supports object input `{ observationId, symbol, projectId? }` (with `observation_id` alias) or positional arguments `(observationId: string, symbol: SymbolInput | string)`.
- **Existence Verification**: Verifies the observation exists; throws if not found.
- **Idempotency**: Executes inside `db.transaction()` using `INSERT OR IGNORE INTO observation_entities`, ensuring duplicate calls do not throw or duplicate join records.

#### 5. `getStats(projectId?: string): MemoryStats`

Returns aggregate system metrics:

- Returns `{ projects: number, observations: number, entities: number, links: number }`.
- When `projectId` is passed, metrics are scoped to that project; when omitted, counts are aggregated across all workspaces.

#### 6. `syncToDisk(targetPath?, options?): { path: string; count: number }`

Exports observations and linked entities to a portable JSON Lines (`.jsonl`) file:

- **Path Resolution**: Defaults to `<project_root>/.huginn/memories.jsonl`. Relative paths resolve against `currentProject.root_path` (with fallback to git root or `process.cwd()`).
- **Atomic File Writing**:
  - Content is formatted as newline-delimited JSON (`.jsonl`).
  - Writes to a temporary file `<resolvedPath>.tmp` with mode `0o600` (`rw-------`).
  - Enforces `0o600` file permissions via `fs.chmodSync`.
  - Atomically replaces the target file via `fs.renameSync(tmpPath, resolvedPath)`.
  - In the event of an error, cleans up the `.tmp` file to prevent lingering temporary files.
- **Project Filtering**: Exports the current project by default (or explicit `options.projectId`), or all projects when `allProjects: true`.

#### 7. `importFromDisk(sourcePath?): { imported: number; skipped: number }`

Idempotently imports observations and entities from `.jsonl` files into the database:

- **Path Resolution**: Defaults to `<project_root>/.huginn/memories.jsonl` (or custom path).
- **Line-by-Line Streaming**: Parses each JSON line independently; malformed lines or non-object entries are skipped without aborting valid lines.
- **Type Integrity**: Strictly verifies that `id`, `title`, and `content` are non-empty strings.
- **Idempotency**: Checks `SELECT id FROM observations WHERE id = ?`. If an observation with the given UUID already exists, it is counted as `skipped` and not re-inserted.
- **Project & Category Fallbacks**:
  - If the record's `project_id` does not exist in `projects`, falls back to `currentProject.id`.
  - If the record's `category` is not in `VALID_CATEGORIES`, defaults to `'decision'`.
- **Entity Resolution**:
  - Reuses existing entities matching `(project_id, identifier)` or creates new entities, preserving custom entity IDs from the file when present.
  - Links observations and entities via `INSERT OR IGNORE`.
- **Automatic FTS Synchronization**: As records are inserted, SQLite triggers (`obs_ai`) automatically index each observation in `observations_fts`.
- **Single Transaction**: The entire import executes within a single `db.transaction()` block for speed and all-or-nothing consistency.

## 3. Muninn Memory Engine — Model Context Protocol (MCP) Server Architecture

The `src/mcp/` module implements a Model Context Protocol (MCP) server exposing Muninn memory operations directly to AI coding agents (Claude Code, Cursor, OpenCode, Windsurf) over standard input/output (`stdio`) using standard JSON-RPC 2.0.

### Architectural Component Diagram & Request Flow

```mermaid
flowchart TD
    subgraph AgentClient["AI Coding Agent (Claude Code / Cursor / OpenCode)"]
        Agent["Agent Process"]
    end

    subgraph MCPTransport["MCP Transport Layer"]
        Stdio["StdioServerTransport (JSON-RPC 2.0 over stdio)"]
    end

    subgraph MCPServerCore["Muninn MCP Server (src/mcp/server.ts)"]
        Server["Server (@modelcontextprotocol/sdk)"]
        Registry["TOOL_REGISTRY (Declarative Tool Map)"]
        Norm["normalizeArgs() (Security & Alias Filter)"]
        Zod["Zod Validation (Muninn*Schema)"]
        ErrFormat["formatZodErrors()"]
    end

    subgraph ServiceLayer["Service Core (src/service/)"]
        Port["IMemoryService (Port Interface)"]
        ConcreteService["MemoryService"]
    end

    subgraph DatabaseLayer["Persistence Layer (src/db/)"]
        SQLite[("better-sqlite3 (WAL Mode)")]
        FTS[("observations_fts (BM25)")]
    end

    Agent <-->|"stdin / stdout (JSON-RPC)"| Stdio
    Stdio <--> Server
    Server --> Registry
    Server --> Norm
    Norm --> Zod
    Zod -- "Invalid Args" --> ErrFormat --> Server
    Zod -- "Valid (parsed.data)" --> Registry
    Registry -->|"handler(service, data)"| Port
    Port -. "implements" .-> ConcreteService
    ConcreteService --> SQLite
    SQLite -. "triggers" .-> FTS
```

### Request Lifecycle & Sequence

Every tool invocation follows a strict, defensive pipeline ensuring the stdio connection never crashes:

```mermaid
sequenceDiagram
    participant A as Agent (Client)
    participant T as StdioServerTransport
    participant S as MuninnServer
    participant R as TOOL_REGISTRY
    participant V as Zod Validator
    participant M as IMemoryService

    A->>T: JSON-RPC CallToolRequest (name, arguments)
    T->>S: requestHandler(CallToolRequestSchema)
    alt Unknown Tool Name
        S-->>T: { isError: true, content: ["Error: Unknown tool ..."] }
    else Known Tool
        Note over S: normalizeArgs(arguments)
        Note over S: Strip __proto__, constructor, prototype
        Note over S: Prune null / undefined
        Note over S: Map snake_case aliases
        S->>V: tool.schema.safeParse(normalizedArgs)
        alt Validation Failed
            Note over S: formatZodErrors(error)
            S-->>T: { isError: true, content: ["Validation error: ..."] }
        else Validation Passed
            S->>R: tool.handler(service, parsed.data)
            R->>M: service[method](data)
            alt Handler Throws
                M-->>S: exception
                S-->>T: { isError: true, content: ["Error: <message>"] }
            else Handler Succeeds
                M-->>S: result
                S-->>T: { content: [{ type: "text", text: JSON.stringify(result) }] }
            end
        end
    end
    T-->>A: JSON-RPC Response
```

### Port Decoupling (`IMemoryService`)

To maintain clean architectural boundaries and facilitate unit testing with mock implementations, the MCP server depends on the `IMemoryService` port interface rather than the concrete `MemoryService` class:

```ts
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
  getStats(projectId?: string): MemoryStats;
  syncToDisk(
    targetPath?: string,
    options?: { projectId?: string; allProjects?: boolean }
  ): { path: string; count: number };
  importFromDisk(sourcePath?: string): { imported: number; skipped: number };
  close?(force?: boolean): void;
}
```

- `isMemoryService(obj)`: Runtime type guard verifying that an object satisfies the service interface.
- `createMcpServer(serviceOrOptions?)`: Accepts an instance of `IMemoryService` directly or options to instantiate a default `MemoryService`.
- Attaches the service reference as both `server.service` and `server.memoryService` on the returned `MuninnServer`.

### Declarative Tool Registry (`TOOL_REGISTRY`)

Instead of imperative `switch/case` routing, tools are declared in a centralized dictionary adhering to `ToolDefinition`:

```ts
export interface ToolDefinition<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput = unknown
> {
  name: string;
  description: string;
  schema: TSchema;
  handler: (
    service: IMemoryService,
    input: z.infer<TSchema>
  ) => TOutput | Promise<TOutput>;
}
```

The exported `MUNINN_TOOLS: Tool[]` array is dynamically generated from `TOOL_REGISTRY` using `z.toJSONSchema(tool.schema)`.

### Tool Inventory & Payload Bound Specifications

| Tool | Schema | Bounds & Validation Constraints | Handler Action |
|---|---|---|---|
| `muninn_save` | `MuninnSaveSchema` | - `category`: Enum (`decision`, `convention`, `discovery`, `bugfix`, `architecture`)<br>- `title`: Trimmed string, 1–1,000 chars<br>- `content`: Trimmed string, 1–1,000,000 chars<br>- `topicKey`: Optional trimmed string, max 256 chars<br>- `symbols`: Optional array, max 500 items (string or `SymbolSchema`) | `service.saveObservation(input)` |
| `muninn_search` | `MuninnSearchSchema` | - `query`: Trimmed string, 1–2,000 chars<br>- `category`: Optional category enum<br>- `limit`: Optional integer, 1–500, default: 10<br>- `allProjects`: Optional boolean | `service.search(input)` |
| `muninn_context` | `MuninnContextSchema` | - `limit`: Optional integer, 1–500, default: 20<br>- `category`: Optional category enum<br>- `topicKey`: Optional trimmed string, max 256 chars<br>- `allProjects`: Optional boolean | `service.getContext(input)` |
| `muninn_link_symbol` | `MuninnLinkSymbolSchema` | - `observationId`: Trimmed string, min 1 char<br>- `symbol`: String (min 1 char) or `SymbolSchema` object | `service.linkSymbol(input.observationId, input.symbol)` |
| `muninn_stats` | `MuninnStatsSchema` | - `allProjects`: Optional boolean (default: false) | `service.getStats(allProjects ? undefined : currentProject.id)` |
| `muninn_inspect_symbol` | `MuninnInspectSymbolSchema` | - `symbol`: Trimmed string, 1–2,000 chars<br>- `projectId` / `project_id`: Optional trimmed string | `service.inspectSymbol(symbol, projectId)` returning symbol definition, file location, incoming/outgoing dependencies, and linked observations |
| `muninn_verify_contract` | `MuninnVerifyContractSchema` | - `files`: Optional array of strings or single string (transformed to array), max 500 items, 1–1,000 chars per path<br>- `projectRoot` / `project_root`: Optional trimmed string (enforced inside permitted project root) | `verifyTypeScriptContracts(targetRoot, files)` returning `{ valid, errorsCount, diagnostics }` with line/column locations and visual code snippets |

#### Symbol Schema Refinement (`SymbolSchema`)

Entity symbols accept string shorthands or structured objects. `SymbolSchema` enforces `.refine()`:

```ts
export const SymbolSchema = z
  .object({
    name: z.string().trim().nullish(),
    filePath: z.string().trim().nullish(),
    file_path: z.string().trim().nullish(),
    identifier: z.string().trim().nullish(),
    type: z.enum(["file", "function", "class", "interface", "module"]).nullish(),
    entity_type: z.enum(["file", "function", "class", "interface", "module"]).nullish(),
    id: z.string().trim().nullish(),
  })
  .passthrough()
  .refine(
    (s) => Boolean(s.name || s.identifier || s.filePath || s.file_path),
    { message: "Symbol must provide at least one of name, identifier, or filePath" }
  );
```

### Security Hardening & Robustness

1. **Prototype Pollution Hardening**:
   - `normalizeArgs` explicitly filters out `__proto__`, `constructor`, and `prototype` keys during object iteration.
   - Prevents untrusted model payloads from mutating JavaScript runtime prototypes.
2. **Nullish Argument Pruning & Serialization Normalization**:
   - LLMs frequently serialize optional omitted tool fields as explicit `null` or `undefined`.
   - `normalizeArgs` strips nullish entries before passing to Zod schemas, preventing unintended validation rejections.
3. **Snake_Case Alias Translation**:
   - Seamlessly remaps `topic_key` -> `topicKey`, `observation_id` -> `observationId`, and `all_projects` -> `allProjects`.
4. **Defensive Argument Extraction**:
   - Argument access and normalization are wrapped in `try...catch` within the tool call request handler, ensuring malformed non-object JSON payloads cannot throw unhandled exceptions.
5. **Human-Readable Error Formatting (`formatZodErrors`)**:
   - Recursively maps Zod validation issues to path-prefixed messages (`category: Invalid enum value`, `title: Observation title is required`).
6. **Graceful Transport Isolation**:
   - All tool errors return `{ isError: true, content: [{ type: "text", text: ... }] }` without dropping or terminating the JSON-RPC stdio transport stream.
7. **Fatal Error Safety Net**:
   - In `MemoryService.search()`, unexpected database disk I/O or corruption errors (`SQLITE_CORRUPT`, `SQLITE_IOERR`, `SQLITE_FULL`, `SQLITE_CANTOPEN`) are logged with `console.error` and rethrown, while non-fatal search query failures log warnings and return empty results.

### Server Lifecycle & Entrypoints

- **`createMcpServer(serviceOrOptions?)`**: Instantiates `@modelcontextprotocol/sdk` `Server`, registers `ListToolsRequestSchema` and `CallToolRequestSchema` handlers, and binds the `IMemoryService` instance.
- **`startMcpServer(options?)`**: Instantiates `BoundedStdioServerTransport` — a `StdioServerTransport` subclass whose `send()` races the SDK write against a 5 s deadline (`MCP_WRITE_TIMEOUT_MS`) and an output-stream error, so a broken pipe **rejects** the pending request instead of awaiting a `'drain'` that never arrives (REQ-30 / AC-30.3) — creates the server, and establishes the stdio connection. Used by the CLI runner (`muninn mcp run`).

## 4. Muninn Memory Engine — CLI Commands & Stdio Runner Architecture

The CLI interface for Muninn memory (`src/commands/memory.ts`) connects human developers and terminal workflows to `MemoryService` and the `startMcpServer` runner without requiring agent tooling or MCP client configurations.

### Command Routing & CLI Parsing Architecture

CLI routing in `src/cli.ts` dispatches top-level commands to their respective subsystems:

```mermaid
flowchart TD
    CLI["cli.ts parseArgs(argv)"] --> DISPATCH{"_command"}
    DISPATCH -- "memory" --> MEM["handleMemoryCommand(subcommand, args, positionals)"]
    DISPATCH -- "mcp" --> MCP["handleMcpCommand(subcommand, args)"]
    DISPATCH -- "check" --> CHK["handleCheckCommand(files, args)"]
    DISPATCH -- "run / plan / live / install" --> CORE["Core Harness Engines"]

    MEM --> SUBCMD{"subcommand"}
    SUBCMD -- "init" --> INIT["MemoryService.init / ensureProject"]
    SUBCMD -- "search" --> SRCH["MemoryService.search() (BM25)"]
    SUBCMD -- "sync" --> SYNC["MemoryService.syncToDisk() / importFromDisk()"]
    SUBCMD -- "index" --> IDX["indexFilesIntoMuninn()"]
    SUBCMD -- "help / unknown" --> USAGE["printMemoryUsage()"]

    MCP --> MCPSUBCMD{"subcommand"}
    MCPSUBCMD -- "run" --> RUN["startMcpServer() + Stdio Keepalive"]
    MCPSUBCMD -- "help / unknown" --> MCPUSAGE["printMcpUsage()"]

    CHK --> CHKRUN["verifyTypeScriptContracts(projectRoot, files)"]
```

### Argument Parser Enhancements (`parseArgs`)

1. **Multi-Positional Capture (`_positionals`)**:
   - Rather than retaining only the first non-command token in `_positional`, `parseArgs` populates `_positionals: string[]`.
   - The first positional argument after the command name determines the subcommand (`init`, `search`, `sync`, `index`, `run`), while remaining entries (`positionals.slice(1)`) are forwarded as positional arguments (such as search queries or file paths).
2. **Boolean Flag Protection (`BOOLEAN_FLAGS`)**:
   - A dedicated `Set` flags boolean parameters (`--yes`, `--force`, `--resume`, `--force-restart`, `--ignore-plan-changes`, `--tui`, `--headless`, `--import`, `--help`, `-h`).
   - For any flag in `BOOLEAN_FLAGS`, the parser assigns `true` immediately without consuming the next token, preventing flags like `--import` from consuming subsequent positional file paths.
3. **Keyword Disambiguation & Anti-Shadowing**:
   - By partitioning command arguments through `_positionals`, user search queries matching subcommands (e.g. `muninn memory search search`) and filenames matching subcommands (e.g. `muninn memory sync sync`) are parsed without routing ambiguity or argument swallowing.
4. **Robust Value Conversions (`num`)**:
   - The `num(v, fallback)` helper handles non-string and non-finite argument types safely without throwing `TypeError`.

### Subcommand Implementations (`src/commands/memory.ts`)

#### 1. `muninn memory init`
- **Purpose**: Creates the SQLite database file and verifies that tables and triggers are ready.
- **Workflow**:
  - Accepts `--db <path>` and `--project <path>` (or `--root <path>`).
  - Instantiates `MemoryService({ dbPath, projectRoot })`.
  - Verifies project association via `service.currentProject`.
  - Outputs formatted green status badge and summary:
    ```
    ✔ Muninn memory database initialized
      Database: /path/to/.huginn/muninn.db
      Project:  example-project (/path/to/project)
      Status:   Tables ready
    ```
  - Calls `service.close?.()` in a mandatory `finally` block to release file locks.

#### 2. `muninn memory search <query>`
- **Purpose**: Searches stored observations using BM25 relevance ranking over FTS5.
- **Workflow**:
  - Resolves query from `positionals[0]` or `--query <text>`.
  - If query is absent or empty whitespace: prints `chalk.red("Error: Search query is required.")` and sets `process.exitCode = 1`.
  - Filters by `--category` and `--limit` (floors fractional numbers via `Math.floor`, falling back to `10` on negative or invalid limits).
  - Queries `service.search({ query, category, limit })`.
  - Formats output with ANSI styling:
    - Bold category badge: `[DECISION]`, `[CONVENTION]`, `[BUGFIX]`, `[ARCHITECTURE]`, `[DISCOVERY]`
    - Observation title and BM25 rank score: `(score: 0.123)`
    - Topic key (when present): `Topic: <key>`
    - Flattened content snippet clamped to 150 characters with trailing `...`
    - Code symbol linkages: `Symbols: <path1>, <path2>`
  - Guarantees database closure in `finally`.

#### 3. `muninn memory sync [--import]`
- **Purpose**: Exports observations to `.huginn/memories.jsonl` or imports them from an existing `.jsonl` file.
- **Workflow**:
  - Resolves target path from `--file <path>` or positional argument; defaults to `<project_root>/.huginn/memories.jsonl`.
  - **Export Mode** (default):
    - Invokes `service.syncToDisk(filePath)`.
    - Outputs `Synced N memories to <path>.`
  - **Import Mode** (`--import`):
    - Invokes `service.importFromDisk(filePath)`.
    - Outputs `Imported N memories (skipped M duplicates) from <path>.`
  - Guarantees database closure in `finally`.

#### 4. `muninn memory index [files...]`
- **Purpose**: Extracts AST symbols and topological dependencies from TypeScript/JavaScript files and indexes them into Muninn's `entities` and `entity_dependencies` database tables.
- **Workflow**:
  - Accepts optional list of target files or recursively discovers all source files in the project via `findSourceFiles(root)`.
  - Accepts `--project <path>` and `--db <path>` options.
  - Instantiates `MemoryService({ dbPath, projectRoot })`.
  - Invokes `indexFilesIntoMuninn(service, targetFiles, { projectRoot: root })`.
  - Validates paths against path traversal, checks supported extensions, enforces 2MB size limit, parses ASTs in-memory, and writes symbols and dependencies in a single atomic SQLite transaction with zombie entity pruning.
  - Outputs formatted green status badge and summary:
    ```
    ✔ Indexed N file(s) (X symbol(s), Y dependency link(s)) into Muninn memory.
    ```
  - Calls `service.close?.()` in a mandatory `finally` block to release file locks.

#### 5. `muninn mcp run`
- **Purpose**: Spawns and manages the long-running Model Context Protocol stdio server process.
- **Workflow**:
  - Accepts optional `--db <path>` and `--project <path>`.
  - Invokes `startMcpServer({ dbPath, projectRoot })`.
  - **Stdout Silence Guarantee**: Emits zero startup logs or banners to `stdout` to avoid corrupting MCP JSON-RPC frames.
  - **Lifecycle Management** (REQ-30 / AC-30.3):
    - Keeps the Node/Bun process alive via an unresolved `Promise<void>`.
    - Monitors `transport.onclose`, bridges `process.stdin` `'end'`/`'close'` to the same `done()` shutdown path — the SDK transport only observes `'data'`/`'error'`, so without this a parent disconnect is invisible and the server would run forever — and registers signal listeners for `SIGINT` and `SIGTERM`.
    - Installs a `process.stdout` `'error'` handler that logs the EPIPE to `stderr` and turns it into a clean shutdown instead of an unhandled crash mid-response, a no-op `process.stderr` `'error'` handler, and a `server.onerror` logger for protocol failures.
    - On termination, safely shuts down `MemoryService` and closes `MuninnServer` in a `finally` block before exiting.

### TypeScript Contract Verification Command (`src/commands/check.ts`)

#### `muninn check [files...] [--project <path>]`
- **Purpose**: Static verification of TypeScript execution contracts and type consistency via the TypeScript Compiler API without compiling or emitting JavaScript files.
- **Workflow**:
  - Parses target files from positionals or checks the entire project root.
  - Resolves project root via `--project <path>`, `--root <path>`, or `process.cwd()`.
  - Invokes `verifyTypeScriptContracts(projectRoot, targetFiles)`.
  - **Pass Path** (`result.valid === true`):
    - Prints green status: `✔ TypeScript contracts verified: 0 errors (N diagnostic(s)).`
    - If non-error diagnostics (warnings or suggestions) exist, prints formatted location details and visual code snippets.
  - **Fail Path** (`result.valid === false`):
    - Prints bold red header: `✖ TypeScript contracts check failed with N error(s):`
    - Prints each diagnostic with file path, line, character, error code (e.g. `[TS2322]`), category, message, and visual caret underline snippet.
    - Sets `process.exitCode = 1` for terminal automation and CI pipelines.

### Error Handling & Process Exit Protocol

To guarantee that asynchronous output streams flush completely and child handles terminate cleanly:
- Validation errors and unknown subcommands set `process.exitCode = 1` rather than invoking immediate `process.exit(1)`.
- The CLI main execution wrapper in `src/cli.ts` terminates cleanly:
  ```ts
  if (import.meta.main) {
    main(process.argv.slice(2))
      .then(() => {
        process.exit(process.exitCode ?? 0);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(msg));
        process.exit(1);
      });
  }
  ```

## 5. Verified Execution Contracts via TypeScript Compiler API

Static verification of code contracts is implemented in `src/contracts/compiler.ts`. Instead of shelling out to `tsc` or `bun build` as a child process, Huginn embeds the TypeScript Compiler API directly within the runtime. This provides low-latency, in-process diagnostic extraction, structured error objects, and deterministic gate evaluation.

### Architectural Motivation & Core Principles

1. **Zero Subprocess Overhead**: Spawning external CLI processes introduces process startup latency, terminal stream parsing fragility, and IPC overhead. In-process compilation via `ts.createProgram` evaluates ASTs directly in Bun's address space.
2. **Deterministic Pre-Emit Diagnostics**: Uses `ts.getPreEmitDiagnostics(program, sourceFile)` to intercept semantic, syntactic, and structural errors before any emission stage.
3. **No Artifact Side-Effects**: Always enforces `noEmit: true` so that verifying contracts never touches the disk, generates build artifacts, or invalidates git working trees.
4. **Sandboxed & Fail-Closed**: Target files and configuration files are strictly bounded within `projectRoot`. Missing target files or invalid configuration files fail closed immediately.
5. **Gate Loop Integration**: Formats verification results into machine-parsable markdown diagnostics with verdict markers (`### Overall gate: 🔴\n🛑 BLOCKED: ...`), enabling Huginn's `CycleEngine` to automatically feed compiler errors directly into thinker fix phases (`FIX_VALIDATE`, `FIX_SPEC`).

### Configuration Discovery & Containment (`loadProjectConfig`)

Configuration discovery enforces strict directory isolation:

```ts
export function loadProjectConfig(projectRoot: string): {
  configPath: string | undefined;
  options: ts.CompilerOptions;
  fileNames: string[];
  errors: ts.Diagnostic[];
}
```

- **Strict Root Resolution (`REV-005`, `SEC-007`)**: Resolves `path.join(resolvedRoot, "tsconfig.json")`. The loader explicitly refrains from walking parent directories (`ts.findConfigFile` is deliberately avoided) to prevent path traversal outside the project repository.
- **Safe Fallback (`DEFAULT_COMPILER_OPTIONS`)**: If `tsconfig.json` does not exist, safe default compiler options are applied:
  - `target: ts.ScriptTarget.ES2022`
  - `module: ts.ModuleKind.NodeNext`
  - `moduleResolution: ts.ModuleResolutionKind.NodeNext`
  - `strict: true`
  - `esModuleInterop: true`
  - `skipLibCheck: true`
  - `allowJs: true`
  - `noEmit: true`
- **Fail-Closed Parse Errors (`REV-002`)**: If `tsconfig.json` exists but contains syntax or configuration errors, `loadProjectConfig` returns the diagnostic errors, causing `verifyTypeScriptContracts` to fail immediately and report the configuration flaw.

### Target File Resolution & Traversal Containment (`resolveTargetFiles`)

Path validation protects against directory traversal and non-existent targets:

```ts
export function resolveTargetFiles(
  projectRoot: string,
  filePaths?: string[]
): ResolveTargetFilesResult
```

- **Path Traversal Guard (`SEC-001`)**: Computes `path.relative(projectRoot, resolved)`. If the relative path starts with `..` or is absolute, validation fails immediately with error code `TS6054` (`File '<path>' is outside project root.`).
- **File Existence Guard (`REV-003`)**: Validates that each target file exists on disk and is a regular file (`fs.statSync(resolved).isFile()`). Missing files trigger `TS6053` (`File '<path>' not found.`).

### Targeted Compilation & Diagnostics Pipeline (`verifyTypeScriptContracts`)

The verification pipeline executes in seven distinct phases:

```mermaid
flowchart TD
    A["verifyTypeScriptContracts(projectRoot, filePaths)"] --> B["resolveTargetFiles() (SEC-001, REV-003)"]
    B -- invalid path / missing file --> ERR1["Return failure ContractVerificationResult"]
    B -- valid --> C["loadProjectConfig() (REV-005, SEC-007)"]
    C -- config parse errors --> ERR2["Return configuration diagnostics"]
    C -- valid config --> D{"Determine rootNames"}
    D -- filePaths provided --> E["rootNames = targetFiles (REV-004)"]
    D -- tsconfig fileNames --> F["rootNames = fileNames"]
    D -- fallback --> G["findSourceFilesInDir(src/)"]
    E & F & G --> H["ts.createProgram({ rootNames, options })"]
    H --> I["Collect optionsDiagnostics + globalDiagnostics"]
    H --> J["Iterate checkFiles → ts.getPreEmitDiagnostics(program, file)"]
    I & J --> K["Deduplicate diagnostics by file:pos:code:message"]
    K --> L["Filter diagnostics: skip node_modules & outside root (SEC-004)"]
    L --> M["Format diagnostics with visual snippets"]
    M --> N{"errorsCount === 0?"}
    N -- yes --> PASS["valid: true, errorsCount: 0"]
    N -- no --> FAIL["valid: false, errorsCount: N"]
```

1. **Targeted `rootNames` Optimization (`REV-004`, `SEC-005`)**: When verifying specific files, only those files are passed as `rootNames` to `ts.createProgram`, minimizing symbol resolution overhead.
2. **Pre-Emit Diagnostics Collection**: Gathers `program.getOptionsDiagnostics()`, `program.getGlobalDiagnostics()`, and for each target file, `ts.getPreEmitDiagnostics(program, sourceFile)`.
3. **Diagnostic Deduplication**: Eliminates duplicate diagnostics caused by multiple source file import graphs using a composite key: `${fileName}:${start}:${code}:${messageText}`.
4. **Project Boundary & `node_modules` Filtering (`SEC-004`)**: Excludes diagnostics originating within `node_modules` or outside `projectRoot` (using trailing path separators to prevent prefix collisions).
5. **Structured Return Shape**: Returns `ContractVerificationResult`:
   ```ts
   export interface ContractVerificationResult {
     valid: boolean;
     errorsCount: number;
     diagnostics: FormattedDiagnostic[];
   }
   ```

### Visual Caret Snippet Generation (`createVisualSnippet`)

To provide high-fidelity diagnostic feedback to LLMs and terminal users, `createVisualSnippet` formats source code snippets with aligned caret indicators (`^`):

```ts
export function createVisualSnippet(
  sourceFile: ts.SourceFile,
  start: number,
  length: number = 1
): string
```

- **Line Extraction**: Identifies line starts via `sourceFile.getLineStarts()` and extracts the exact source line containing the error.
- **Resource & Memory Bounds (`SEC-006`, `REV-008`)**:
  - Clamps source line length to a maximum of 300 characters to prevent memory exhaustion on minified or bundled single-line files.
  - Clamps character indentation to a maximum of 300 spaces.
  - Clamps caret underline span between 1 and 200 characters, bounded by the remaining line length.
- **Visual Gutter Output**:
  ```typescript
  12 | const count: number = "not-a-number";
     |                       ^^^^^^^^^^^^^^
  ```

### Markdown Gate Report Formatting (`formatDiagnosticsReport`)

`formatDiagnosticsReport(result)` converts `ContractVerificationResult` into a Markdown document ready for Huginn's gate evaluation and prompt injection:

- **Pass Output**:
  ```markdown
  ### TypeScript Compiler Contract: 🟢 PASSED

  No compilation type errors detected.
  ```
- **Fail Output**:
  ```markdown
  ### TypeScript Compiler Contract: 🔴 BLOCKED
  Found 1 type compilation error(s):

  - **src/app.ts:12:7** [TS2322] (ERROR): Type 'string' is not assignable to type 'number'.
  ```typescript
  12 | const count: number = "not-a-number";
     |       ^^^^^
  ```

  ### Overall gate: 🔴
  🛑 BLOCKED: TypeScript compilation contract errors found (1 error(s)).
  ```

### Exported Namespace (`TypeValidator`)

`src/contracts/compiler.ts` exports the unified `TypeValidator` object:
```ts
export const TypeValidator = {
  check: verifyTypeScriptContracts,
  formatReport: formatDiagnosticsReport,
  DEFAULT_COMPILER_OPTIONS,
};
```

---

## 6. Topological AST Symbol & Dependency Indexer

Codebase intelligence and semantic memory in Muninn are powered by the AST indexer in `src/indexer/ast-indexer.ts`. It parses TypeScript and JavaScript source files into an entity-relationship graph representing code symbols (functions, classes, interfaces, methods) and their structural dependencies (imports, extends, implements, calls, references).

### Architectural Motivation & Knowledge Graph Role

LLM agents operating on source code often suffer from "context blindness" regarding symbol hierarchies, type implementations, and impact radius. The AST indexer builds an in-database dependency graph in SQLite (`entities` and `entity_dependencies` tables) that allows agents to:
- Instantly locate symbol declarations and their containing files.
- Inspect incoming and outgoing dependencies (who imports/calls/extends this symbol).
- Associate Muninn memory observations (architectural decisions, bug fixes, conventions) with exact code symbols via `observation_entities`.

### AST Parsing Engine & Memory Optimization (`extractAstData`)

```ts
export function extractAstData(
  filePath: string,
  sourceText: string
): AstExtractionResult
```

- **Lightweight Source Parser (`REV-010`)**: Calls `ts.createSourceFile(normalizedFilePath, sourceText, ts.ScriptTarget.Latest, false)`. Setting `setParentNodes = false` significantly reduces memory overhead and garbage collection pressure when processing large codebases.
- **Line & Column Resolution**: Uses `sourceFile.getLineAndCharacterOfPosition(pos).line + 1` for accurate 1-indexed line spans (`startLine`, `endLine`).
- **Export Modifier Detection**: Evaluates `ts.getCombinedModifierFlags(node)` and `ts.canHaveModifiers(node)` to classify public API symbols (`isExported: true`).

### Extracted Symbol Taxonomy & Canonical Identifiers

Symbols are uniquely identified across the project using canonical format `<relPath>::<symbolName>`:

| Entity Type | Source AST Node | Canonical Identifier Format | Scope & Access Rules |
|---|---|---|---|
| `file` | Source file itself | `src/app.ts` | Base container for all symbols |
| `function` | `ts.isFunctionDeclaration` | `src/utils/math.ts::add` | Top-level function declarations |
| `function` | `ts.isVariableStatement` | `src/api/client.ts::fetchData` | Arrow functions and function expressions |
| `class` | `ts.isClassDeclaration` | `src/auth/service.ts::AuthService` | Top-level class declarations |
| `function` | `ts.isMethodDeclaration` | `src/auth/service.ts::AuthService.login` | Public class methods (skips `private`, `protected`, `#`) |
| `interface` | `ts.isInterfaceDeclaration` | `src/types/user.ts::User` | Interface declarations |
| `interface` | `ts.isTypeAliasDeclaration` | `src/types/user.ts::UserID` | Type alias declarations |

### Dependency Extraction & Module Specifier Normalization

The indexer extracts five types of topological relationships:

```mermaid
flowchart LR
    FILE["File Entity (src/app.ts)"] -- references --> SYM["Symbol (AuthService)"]
    SYM -- extends --> BASE["BaseService"]
    SYM -- implements --> INTF["IAuth"]
    FILE -- imports --> MOD["Module (./utils.js → ./utils.ts)"]
    FILE -- imports --> NAMED["Named Symbol (./utils.ts::formatDate)"]
```

1. **`imports`**: Extracted from `ts.ImportDeclaration` and `ts.ExportDeclaration` (re-exports). Records both module-level dependencies and named imported symbols.
2. **`normalizeModuleSpecifier`**: Resolves relative imports (`./foo.js` -> `./foo.ts`, `.mjs`/`.cjs` -> `.ts`, `.jsx` -> `.tsx`) against the importing file's directory according to TypeScript ESM conventions, while preserving non-relative package specifiers (e.g. `chalk`, `@opencode-ai/sdk`).
3. **`extends`**: Extracted from class and interface `heritageClauses` (`clause.token === ts.SyntaxKind.ExtendsKeyword`).
4. **`implements`**: Extracted from class `heritageClauses` (`clause.token === ts.SyntaxKind.ImplementsKeyword`).
5. **`references`**: Created automatically between the file entity and every symbol declared within that file.

### Two-Stage Non-Blocking Batch Indexing Architecture (`indexFilesIntoMuninn`)

To ensure database concurrency, WAL performance, and stability, indexing separates file I/O from database transactions (`REV-001`):

```ts
export function indexFilesIntoMuninn(
  memoryService: IMemoryService,
  filePaths: string[],
  options?: { projectRoot?: string }
): IndexSummary
```

```mermaid
sequenceDiagram
    participant CLI as CLI / MCP Caller
    participant FS as File System (In-Memory)
    participant AST as TypeScript AST Parser
    participant DB as SQLite WAL Transaction

    Note over FS,AST: Stage 1: In-Memory File I/O & Parsing (Zero DB Lock)
    CLI->>FS: Check path traversal (SEC-001) & 2MB limit
    FS->>AST: Read content & extractAstData()
    AST-->>FS: Extracted symbols & dependencies

    Note over DB: Stage 2: Short-Lived Database Transaction
    CLI->>DB: db.transaction()
    DB->>DB: getOrCreateEntity(fileEntity)
    DB->>DB: Prune zombie/ghost entities for file (REV-003, SEC-003)
    DB->>DB: Batch upsert active symbol entities
    DB->>DB: Purge stale outgoing dependencies & insert new edges
    DB-->>CLI: Return IndexSummary
```

#### Stage 1: In-Memory Parsing (Outside DB Transaction)
- **Path Traversal Containment (`SEC-001`)**: Target paths must resolve strictly within `projectRoot`. Escaping paths are silently skipped.
- **Extension Filtering**: Only supported extensions (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`) are processed.
- **Size Bounds**: Files exceeding `MAX_FILE_SIZE_BYTES = 2MB` are skipped to protect system memory.
- **Fault Tolerance (`REV-007`)**: Unreadable files or syntax errors in individual files do not abort the indexing of remaining files.

#### Stage 2: Short-Lived Atomic SQLite Transaction
- Executed inside `db.transaction(...)` for minimal WAL lock duration.
- **`getOrCreateEntity`**: Upserts entity records, authoritatively updating `entity_type` and `file_path` if already present.

### Zombie / Ghost Entity Pruning & Cascading Integrity (`REV-003`, `SEC-003`)

When a source file is edited, symbols may be renamed, removed, or moved. If stale entities remained in the database, agents would navigate to obsolete ghost symbols:

1. **Active Identifier Gathering**: During Stage 1 AST extraction, the indexer collects all currently valid identifiers in the file (`activeIdentifiers: Set<string>`).
2. **Zombie Detection**: Queries all existing entities for the file:
   ```sql
   SELECT id, identifier FROM entities WHERE project_id = ? AND file_path = ?;
   ```
3. **Cascading Pruning**: Any database entity for that file whose identifier is *not* in `activeIdentifiers` is deleted:
   ```sql
   DELETE FROM entities WHERE id = ?;
   ```
4. **Referential Cascade**: SQLite's `FOREIGN KEY ... ON DELETE CASCADE` automatically and atomically cleans up all associated records in `entity_dependencies` (both incoming and outgoing links) and `observation_entities`.

### Symbol Inspection API (`MemoryService.inspectSymbol`)

`MemoryService` exposes `inspectSymbol(symbol: string, projectId?: string): SymbolInspection | null` to serve both MCP agent queries (`muninn_inspect_symbol`) and developer inspection:

```ts
export interface SymbolInspection {
  entity: Entity;
  dependencies: {
    outgoing: SymbolInspectionDependency[];
    incoming: SymbolInspectionDependency[];
  };
  observations: Observation[];
}
```

- **Multi-Tier Matching Strategy**:
  1. **Exact Match**: Queries `WHERE project_id = ? AND identifier = ?`.
  2. **Suffix Match (`REV-005`, `REV-008`, `SEC-004`)**: If exact match fails, searches for symbol names or method names across files using suffix patterns:
     ```sql
     identifier LIKE '%::' || ? ESCAPE '\' OR identifier LIKE '%.' || ? ESCAPE '\'
     ```
     Enables queries like `"login"` to find `"src/auth.ts::AuthManager.login"`.
  3. **Prefix / Path Match**: Matches namespaces or file paths (`identifier LIKE ? || '%' ESCAPE '\' OR file_path = ?`).
- **SQL Injection Prevention (`_escapeLikePattern`)**: Escapes `%`, `_`, and `\` before binding to LIKE clauses.
- **Graph & Observation Aggregation**: Fetches outgoing dependencies, incoming dependents, and all linked memory observations, returning a complete 360-degree topological view of the symbol.

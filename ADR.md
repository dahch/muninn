# Architecture Decision Records

Decisions are listed in recording order. `ADR-1` is implemented in the current codebase;
`ADR-2` and `ADR-3` are proposals that are not implemented yet. `ADR-4`–`ADR-10` were recorded
retroactively from the 0.1.0 codebase so the existing architecture has an explicit history.

## ADR-1: Track decision supersession in observation rows

- **Date**: 2026-11-04
- **Status**: Accepted
- **Context**: Muninn stored observations without lifecycle state, so replaced decisions remained
  indistinguishable from current ones. The feature required explicit, traceable replacement while
  preserving existing SQLite databases and their data. Alternatives included inferring current
  decisions from recency, storing replacement history in a new table, or adding lifecycle fields to
  observations.
- **Decision**: Add `status` and nullable `superseded_by` columns to `observations`. Migrate existing
  databases idempotently by inspecting their columns and adding only those missing. A new decision may
  explicitly supersede active decisions with the same project and topic key; this update and the save
  occur in one transaction. Retrieval excludes superseded observations by default, with an opt-in to
  include them.
- **Consequences**: Existing observations migrate as active without rebuilding tables. Supersession
  is auditable and atomic, and no additional table is needed. Callers must explicitly request
  replacement; recency alone never determines validity. Both schema definitions and the existing FTS
  behavior must remain synchronized and tested. Search/context callers that need history must pass
  `includeSuperseded`; exports include the new fields, and imports without them default to active.

## ADR-2: Provide bootstrap through a read-only, bounded brief

- **Date**: 2026-11-04
- **Status**: Proposed (not implemented in this codebase)
- **Context**: Agents need a session-start view of project identity, active decisions, recent
  activity, indexed symbols, and counts. Constructing the existing `MemoryService` may initialize a
  database and project record, which is unsuitable for a read-only bootstrap that must fail open.
  Alternatives include requiring callers to initialize memory first, allowing bootstrap to create the
  database, or implementing a separate read-only retrieval path.
- **Decision**: Provide a session-brief operation and shared Markdown renderer for the library, MCP
  tool, and CLI. Bootstrap reads the existing database without DDL or project insertion; if it is
  missing or unusable, it returns an empty brief with an explanatory note. The rendered brief has a
  configurable character budget and deterministic ordering. Path-based symbol selection uses only
  indexed entities within the project boundary.
- **Consequences**: Agents can bootstrap without creating project state, and MCP and CLI would share
  one output contract. The implementation must distinguish read-only access from normal service
  initialization and enforce the character budget over the complete rendered Markdown. Missing data
  is reported rather than synthesized; the brief may contain less information when the database has
  not been initialized or indexed. **No implementation exists yet**: there is no `getSessionBrief`,
  `muninn_bootstrap`, or `muninn memory brief` in the current source tree.

## ADR-3: Reuse the stored dependency graph for neighbor recovery

- **Date**: 2026-11-04
- **Status**: Proposed (not implemented in this codebase)
- **Context**: Muninn already persists symbol dependencies, but recovery does not traverse them. The
  proposed feature requires related symbols in session briefs and inspection without adding a new
  graph tool or inferring relationships. Alternatives include leaving graph data unused, deriving
  relationships from names or paths, or querying the existing dependency edges through a shared
  bounded traversal.
- **Decision**: Add a service-level neighbor traversal over `entity_dependencies`, following edges in
  both directions with bounded depth and result count, deterministic grouping, and cycle protection.
  Use the same traversal for brief graph expansion and symbol inspection.
- **Consequences**: Graph recovery would use only indexed evidence and avoid duplicate traversal
  implementations. Results are limited by the configured depth and neighbor cap; graph data that has
  not been indexed cannot provide related symbols and must be reported as absent rather than inferred.
  **No implementation exists yet**: `MemoryService.neighbors` and the `related` brief section are
  not part of the current source tree.

## ADR-4: Store memory in one embedded SQLite database with FTS5

- **Date**: 2026-11-04
- **Status**: Accepted
- **Context**: Coding agents need durable project memory that works offline, inside a repository, and
  without operating a service. Alternatives were a vector database, a hosted search service, or
  keeping memory only in flat files.
- **Decision**: Use `better-sqlite3` with one database file per project, WAL journaling, foreign keys,
  and an external-content FTS5 table. Synchronize FTS rows with insert/update/delete triggers and rank
  with BM25. Store projects, observations, entities, links, and dependencies in relational tables.
- **Consequences**: One portable file contains the whole memory, queries are synchronous and local,
  and there is no embedding model or network dependency. Search is lexical rather than semantic, the
  package depends on a native SQLite module, and concurrent writers rely on SQLite's WAL/busy-timeout
  behavior. Schema changes must keep `schema.sql` and the embedded fallback synchronized.

## ADR-5: Expose one engine through library, CLI, and MCP adapters

- **Date**: 2026-11-04
- **Status**: Accepted
- **Context**: The same memory must be usable by an agent over MCP, by a developer in a terminal, and
  by other TypeScript code. Implementing each surface separately would duplicate storage and business
  rules.
- **Decision**: Keep `MemoryService` as the core and treat the CLI, MCP server, and exported library as
  adapters. The MCP server depends on the `IMemoryService` port; the CLI and library use the same
  concrete service and database helpers.
- **Consequences**: Storage and retrieval behavior stays consistent across surfaces and the MCP layer
  can be tested with a mock service. CLI and MCP commands are limited to the service API, and changes
  to a service method can affect all three surfaces at once.

## ADR-6: Model code as an AST-derived entity and dependency graph

- **Date**: 2026-11-04
- **Status**: Accepted
- **Context**: Agents need to locate symbols and understand their relationships without reading the
  whole repository. Alternatives were plain-text symbol search, asking a model to infer relationships,
  or maintaining a separate graph database.
- **Decision**: Use the TypeScript Compiler API to extract files, functions, classes, interfaces,
  methods, and type aliases, with canonical `<path>::<symbol>` identifiers. Persist `imports`, `calls`,
  `extends`, `implements`, and `references` edges in `entity_dependencies`. Parse files outside the
  transaction, then write and prune each file's entities in one short-lived transaction.
- **Consequences**: The graph is deterministic and derived only from source evidence, and re-indexing
  removes renamed or deleted symbols via cascading deletes. Only TypeScript/JavaScript files are
  indexed, relationships are static best-effort, and dynamic imports or runtime wiring are not
  represented. Files over 2 MB and unsupported extensions are skipped.

## ADR-7: Verify TypeScript contracts in-process with the Compiler API

- **Date**: 2026-11-04
- **Status**: Accepted
- **Context**: Contract checks must report type errors quickly and consistently for both the CLI and
  MCP clients. Spawning `tsc` adds process startup overhead, stream parsing, and a risk of emitting
  build artifacts into the project.
- **Decision**: Embed the TypeScript Compiler API and use `ts.createProgram` plus
  `ts.getPreEmitDiagnostics` with `noEmit: true`. Load `tsconfig.json` only from the project root,
  bound target files to that root, and return structured `{ valid, errorsCount, diagnostics }` results
  with line/column locations and bounded visual snippets.
- **Consequences**: Verification runs in-process under Node or Bun, produces no files, and gives both
  surfaces the same result shape. The TypeScript version is tied to the package dependency, only
  TypeScript/JavaScript projects are supported, and missing/invalid configs or out-of-root targets fail
  closed.

## ADR-8: Use JSONL as the portable memory interchange format

- **Date**: 2026-11-04
- **Status**: Accepted
- **Context**: Project memory needs a human-inspectable backup and a way to move records between
  databases without coupling to SQLite internals. Alternatives were SQLite file copies, a custom binary
  format, or a network sync service.
- **Decision**: Export one JSON object per line, including each observation's linked entities and
  lifecycle fields. Write through a temporary file with `0o600` permissions and atomically rename it.
  Import line by line, validate required fields, skip malformed lines, and skip observations whose IDs
  already exist.
- **Consequences**: Memory can be backed up, diffed, and re-imported without a server, and imports are
  idempotent by ID. Export is whole-project (or all-project), import has no merge/conflict resolution,
  and JSONL is not a live synchronization protocol. Both directions apply the same path-safety screen
  as the database.

## ADR-9: Resolve the database and project row from one root

- **Date**: 2026-11-04
- **Status**: Accepted
- **Context**: The database file and the project record were previously resolved independently, so a
  command run from repository Y with `--project X` could label a row in Y's database as X. A cloned
  repository could also ship `.huginn` or the database file as a symlink to redirect writes outside
  the project.
- **Decision**: Pass the same `projectRoot`/`startDir` to database path resolution and project
  creation. Screen protected writes with `assertDocPath`: refuse a symlink on the final component and
  require a project-relative path to resolve inside the real project root. Apply the same screen to the
  JSONL export and import paths.
- **Consequences**: `--project X` and the default database location always agree, and repository-shipped
  links cannot redirect memory writes. Explicit database paths outside the project remain usable but
  are still subject to the symlink screen. Path failures are visible errors, not silent fallbacks.

## ADR-10: Declare MCP tools in a validated registry

- **Date**: 2026-11-04
- **Status**: Accepted
- **Context**: The MCP surface has several tools with overlapping optional arguments. Imperative
  routing and hand-written JSON schemas make tool metadata drift from validation, and model clients
  frequently send nulls or snake_case aliases.
- **Decision**: Define each tool once in `TOOL_REGISTRY` with a name, description, Zod schema, and
  handler. Generate `MUNINN_TOOLS` JSON schemas from those Zod schemas. Normalize arguments before
  validation by stripping nullish values and prototype-pollution keys, then map documented snake_case
  aliases to their camelCase fields. Return structured `isError` tool responses for unknown tools,
  validation failures, and handler exceptions.
- **Consequences**: Adding a tool is a single registry entry and the advertised schema matches the
  validator. Clients can use either casing for supported aliases and omitted null fields are tolerated.
  CamelCase and snake_case fields must be kept in sync inside each schema, and normalization is a
  deliberate allowlist rather than a general case converter.

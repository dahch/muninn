# Architecture Decision Records

Decisions are listed in recording order. `ADR-1`–`ADR-3` are implemented in the current codebase.
`ADR-4`–`ADR-10` were recorded retroactively from the 0.1.0 codebase so the existing architecture has
an explicit history. `ADR-11` records a correction to the dependency relation set described in
`ADR-6`. `ADR-12`–`ADR-14` are proposed setup work; `ADR-15` records the portable-only slice that is
actually implemented.

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
- **Status**: Accepted and implemented
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
- **Consequences**: Agents can bootstrap without creating project state, and MCP and CLI share one
  output contract. The implementation distinguishes `getReadOnlyDatabase` from normal service
  initialization and enforces the character budget over the complete rendered Markdown. Missing data
  is reported rather than synthesized; the brief contains less information when the database has not
  been initialized or indexed. Implemented by `MemoryService.getSessionBrief`, the standalone
  `readSessionBrief`, the `muninn_bootstrap` MCP tool, and `muninn memory brief`.

## ADR-3: Reuse the stored dependency graph for neighbor recovery

- **Date**: 2026-11-04
- **Status**: Accepted and implemented
- **Context**: Muninn already persists symbol dependencies, but recovery does not traverse them. The
  proposed feature requires related symbols in session briefs and inspection without adding a new
  graph tool or inferring relationships. Alternatives include leaving graph data unused, deriving
  relationships from names or paths, or querying the existing dependency edges through a shared
  bounded traversal.
- **Decision**: Add a service-level neighbor traversal over `entity_dependencies`, following edges in
  both directions with bounded depth and result count, deterministic grouping, and cycle protection.
  Use the same traversal for brief graph expansion and symbol inspection.
- **Consequences**: Graph recovery uses only indexed evidence and avoids duplicate traversal
  implementations. Results are limited by the configured depth and neighbor cap; graph data that has
  not been indexed cannot provide related symbols and is reported as absent rather than inferred.
  Implemented by `MemoryService.neighbors`, the session brief's `related` section and `expandGraph`
  option, and the depth-1 `neighbors` field returned by `muninn_inspect_symbol`.

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

## ADR-11: Emit only dependency relations the AST extractor implements

- **Date**: 2026-11-04
- **Status**: Accepted
- **Context**: ADR-6 described persisting `imports`, `calls`, `extends`, `implements`, and
  `references`, and the database schema allows all five values. The current AST extractor in
  `src/indexer/ast-indexer.ts` only produces `imports`, `extends`, `implements`, and `references`;
  there is no call-expression extraction. Documentation that advertised call edges described an
  intended relation set rather than the behavior users receive.
- **Decision**: Keep `calls` as a valid `entity_dependencies.relation_type` for forward compatibility,
  but state that the current indexer emits only the four implemented relation types. Do not infer call
  edges from names, imports, or runtime behavior.
- **Consequences**: Symbol inspection reflects only stored edges, and briefs select indexed symbols;
  no call graph is available in 0.1.0. Adding call extraction requires a new implementation and tests,
  and documentation must not claim the edge exists until it does. Existing databases with `calls` rows
  remain valid and readable.

## ADR-12: Make Muninn the owner of its agent setup catalog

- **Status**: Proposed
- **Context**: Muninn currently exposes memory through its CLI and MCP server, but users must configure each agent manually or rely on Huginn’s integrator. The Huginn integrator provides a reference catalog of agent IDs, routes, formats, and rules files, but making Huginn a runtime dependency would prevent standalone installation. Alternatives are to keep setup exclusively in Huginn, accept only user-provided configuration paths, or provide a catalog and setup adapter owned by Muninn.
- **Decision**: Add a Muninn-owned setup subsystem and CLI command that supports the 13 destinations in the integrator reference. Treat that reference as the compatibility baseline for routes and formats, while keeping the catalog and environment overrides in Muninn. Do not change Huginn as part of this decision.
- **Consequences**: Muninn can configure supported agents without Huginn, and the catalog becomes part of Muninn’s own compatibility contract. The two repositories may have overlapping catalog data and will need coordination if either changes destination definitions. Muninn reports configuration state, not whether an agent is connected or running.

## ADR-13: Merge agent MCP configuration per file with a portable default

- **Status**: Proposed
- **Context**: Agent MCP configuration formats vary, and overwriting a whole file risks destroying unrelated user settings. A user-level configuration is shared across projects, so pinning it to one project would incorrectly direct all uses to the same memory database. Alternatives include generating snippets only, replacing configuration files wholesale, or performing structured per-entry updates.
- **Decision**: Have `muninn setup` structurally merge a single `muninn` entry into JSON-based agent configurations and Codex TOML, preserving unrelated content and using the existing path-safety protections described in ADR-9. Use `muninn mcp run` as the configured command. Include `--project` only for configuration files contained within the selected project. Install `{home}/.muninn/mcp.json` as the portable configuration by default; `--no-portable` suppresses it when agent destinations are selected. Write changed files atomically with restrictive permissions, and do not overwrite a different `muninn` entry without `--force`.
- **Consequences**: Setup can preserve existing agent configuration while supporting both project-specific and shared user configuration. Without a TOML dependency, TOML merging must be implemented and tested within the project. Atomicity applies per file, not across a multi-destination setup: on a fatal error the command stops, retains earlier successful writes, and reports partial results. Read-only status and dry-run modes must not create files or directories.

## ADR-14: Manage agent rules as marked human-authored content

- **Status**: Proposed
- **Context**: MCP configuration is machine-readable configuration, while an agent’s rules file is human-authored prose that may contain unrelated instructions. Replacing that file or appending unmarked text risks losing user content or creating duplicate instructions. The Huginn integrator may also have inserted an older Muninn rules block. Alternatives include leaving rule installation entirely manual, replacing whole rules files, or managing a clearly delimited block in place.
- **Decision**: When setup selects one or more agent destinations, install Muninn usage guidance by default as a marked `muninn:rules` block. Append it to existing rules files or create a missing file, and on later runs replace only Muninn’s own marked block. Detect the prior `huginn:muninn-rules` block as stale: preserve it without `--force`, and replace it with the Muninn block when forced. Do not modify rules files when setup selects no agents or when `--no-rules` is used. Validate rules paths with the same path-safety checks as configuration paths.
- **Consequences**: Muninn can provide consistent bootstrap and memory-use guidance without taking ownership of surrounding prose. Shared rules files require deduplication across selected destinations. Stale-block replacement requires explicit user authorization, and status and setup reports must identify the affected rules file and distinguish its outcome from the MCP configuration outcome.

## ADR-15: Ship agent setup in iterations, starting with the portable destination

- **Date**: 2026-11-05
- **Status**: Accepted and implemented for the portable destination
- **Context**: ADR-12–ADR-14 propose a catalog for 13 agents, JSON/TOML merging, and rules blocks. That
  is too large to land and verify as one change, and users already need a safe way to install the
  project-agnostic MCP entry. The first slice must not pretend the rest of the catalog exists, and it
  must be safe against malformed and symlinked configuration files.
- **Decision**: Implement `muninn setup` as a staged feature. Iteration 1 owns only
  `{home}/.muninn/mcp.json`: it creates or structurally merges the canonical `muninn mcp run` entry,
  reports `absent` / `registered` / `legacy` / `conflict` / `malformed`, supports `--home`, `--force`,
  `--dry-run`, `--status`, and `--portable`, and leaves the legacy `{home}/.huginn/mcp.json` untouched.
  The CLI parses `--agent`, `--no-rules`, and `--list` for forward compatibility but does not implement
  catalog selection, TOML, or rules installation yet. Each remaining slice follows the acceptance
  criteria in `plan.md` and the requirements in `SPEC.md`.
- **Consequences**: Users can install the portable configuration now without waiting for the catalog,
  and the setup writer can be tested in isolation. Agent-specific configuration and rules still require
  manual setup or Huginn's integrator until later iterations. Documentation must not claim those
  destinations work. Adding them should reuse the same path-safety and atomic-write rules rather than
  creating a second setup path.

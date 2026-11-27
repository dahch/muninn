# Architecture Decision Records

Decisions are listed in recording order. `ADR-1`–`ADR-3` are implemented in the current codebase.
`ADR-4`–`ADR-10` were recorded retroactively from the 0.1.0 codebase so the existing architecture has
an explicit history. `ADR-11` records a correction to the dependency relation set described in
`ADR-6`. `ADR-12`–`ADR-14` describe the full setup contract; `ADR-15`–`ADR-18` record the implemented slices
(the portable destination first, then the agent catalog with JSON destinations, Codex TOML, and finally
marked rules with legacy-block handling).

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

- **Date**: 2026-11-05
- **Status**: Accepted (implemented by ADR-15–ADR-18)
- **Context**: Muninn currently exposes memory through its CLI and MCP server, but users must configure each agent manually or rely on Huginn’s integrator. The Huginn integrator provides a reference catalog of agent IDs, routes, formats, and rules files, but making Huginn a runtime dependency would prevent standalone installation. Alternatives are to keep setup exclusively in Huginn, accept only user-provided configuration paths, or provide a catalog and setup adapter owned by Muninn.
- **Decision**: Add a Muninn-owned setup subsystem and CLI command that supports the 13 destinations in the integrator reference. Treat that reference as the compatibility baseline for routes and formats, while keeping the catalog and environment overrides in Muninn. Do not change Huginn as part of this decision.
- **Consequences**: Muninn can configure supported agents without Huginn, and the catalog becomes part of Muninn’s own compatibility contract. The two repositories may have overlapping catalog data and will need coordination if either changes destination definitions. Muninn reports configuration state, not whether an agent is connected or running.

## ADR-13: Merge agent MCP configuration per file with a portable default

- **Date**: 2026-11-05
- **Status**: Accepted (implemented by ADR-15–ADR-18)
- **Context**: Agent MCP configuration formats vary, and overwriting a whole file risks destroying unrelated user settings. A user-level configuration is shared across projects, so pinning it to one project would incorrectly direct all uses to the same memory database. Alternatives include generating snippets only, replacing configuration files wholesale, or performing structured per-entry updates.
- **Decision**: Have `muninn setup` structurally merge a single `muninn` entry into JSON-based agent configurations and Codex TOML, preserving unrelated content and using the existing path-safety protections described in ADR-9. Use `muninn mcp run` as the configured command. Include `--project` only for configuration files contained within the selected project. Install `{home}/.muninn/mcp.json` as the portable configuration by default; `--no-portable` suppresses it when agent destinations are selected. Write changed files atomically with restrictive permissions, and do not overwrite a different `muninn` entry without `--force`.
- **Consequences**: Setup can preserve existing agent configuration while supporting both project-specific and shared user configuration. Without a TOML dependency, TOML merging must be implemented and tested within the project. Atomicity applies per file, not across a multi-destination setup: on a fatal error the command stops, retains earlier successful writes, and reports partial results. Read-only status and dry-run modes must not create files or directories.

## ADR-14: Manage agent rules as marked human-authored content

- **Date**: 2026-11-05
- **Status**: Accepted (implemented by ADR-18)
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

## ADR-16: Implement the agent catalog and JSON destinations after the portable slice

- **Date**: 2026-11-05
- **Status**: Accepted and implemented for the catalog and JSON destinations
- **Context**: ADR-15 delivered only the portable file, so users still had to edit every agent
  configuration by hand. ADR-12 proposed a Muninn-owned catalog and ADR-13 proposed structural
  per-file merging, including Codex TOML. Adding catalog selection and JSON writing together is a
  coherent next slice; adding TOML and rules at the same time would mix three different compatibility
  and safety surfaces in one change.
- **Decision**: Add the 13-destination catalog and path resolver, agent selection (`--agent`,
  `all`, comma-separated IDs), read-only `--list`, and per-target status. Implement structural merging
  for standard `mcpServers` targets and OpenCode/MiMo `mcp` targets, preserving unrelated entries and
  adding `--project <absolute path>` only when the target file is inside the selected project. Keep the
  portable destination included by default unless `--no-portable` is supplied. Report selected Codex
  targets as skipped because TOML writing remains unimplemented.
- **Consequences**: Users can configure the JSON-format agents without Huginn, and the catalog plus
  environment overrides become part of Muninn's compatibility contract. The catalog duplicates the
  Huginn integrator reference and must be coordinated with it. Codex still needs manual configuration,
  rules files are still untouched, and the TOML/rules requirements in ADR-13 and ADR-14 remain
  proposed. The JSON writer reuses the portable writer's path screening, atomic temporary-file
  replacement, permission handling, conflict rules, and idempotent no-op behavior instead of creating
  a second setup path. The Codex TOML portion of this decision is superseded by ADR-17, which implements
  the TOML destination; the rules portion is implemented by ADR-18.

## ADR-17: Parse and merge Codex TOML without a runtime dependency

- **Date**: 2026-11-05
- **Status**: Accepted and implemented for Codex TOML
- **Context**: Iteration 3 must configure Codex at `{home}/.codex/config.toml` under
  `[mcp_servers.muninn]`. Adding a TOML package would introduce a new runtime dependency solely for one
  destination, while the JSON writers already establish per-file path screening, atomic replacement,
  conflict handling, and byte-for-byte no-op behavior. A TOML file can also contain unrelated keys and
  tables, so rewriting the whole document from a parsed object would discard formatting and comments.
- **Decision**: Implement a dependency-free TOML parser and structural merge in
  `src/setup/toml-target.ts`. Validate the complete document before any merge; report malformed input
  with the path and cause and leave the original untouched. Preserve unrelated tables, keys, comments,
  and formatting where feasible. Treat duplicate table definitions as malformed, including a repeated
  non-array header and an explicit header for a table already created by dotted keys. Insert or replace
  only the `[mcp_servers.muninn]` table, using `command = "muninn"` and the canonical argument list;
  a forced replacement may discard comments and formatting inside the replaced Muninn region. Reuse
  `checkDocPath` and `safeWriteAtomic` so TOML has the same protected-path checks, exclusive temporary
  file, atomic rename, permission
  preservation, `0o600`/`0o700` defaults, and final-component symlink refusal as JSON. A correct existing
  entry is a byte-for-byte no-op, and changed writes only occur for absent, legacy, or `--force`
  replacement cases.
- **Consequences**: Codex configuration works without a new dependency and without changing the
  established per-file safety model. The parser is intentionally limited to validated TOML syntax and
  structural edits rather than a full TOML serializer, which keeps unrelated content outside the
  replaced region intact but means unsupported document shapes must fail without writing instead of
  being normalized. Rules-file
  installation remains outside this decision and iteration.

## ADR-18: Install marked rules blocks with shared-file deduplication

- **Date**: 2026-11-05
- **Status**: Accepted and implemented
- **Context**: ADR-14 requires usage rules for selected agents but rules files are human-authored prose,
  unlike machine-oriented MCP configuration. Replacing a whole rules file would destroy unrelated
  instructions, while appending an unmarked paragraph on every run would create duplicates. Some agents
  share `AGENTS.md`, and an older Huginn integrator may have left a `huginn:muninn-rules` block whose
  safe replacement boundary must be recognized explicitly.
- **Decision**: Implement `src/setup/rules-target.ts` and install marked rules only for an explicit
  `--agent` selection, unless `--no-rules` is supplied. Group selected agents by resolved project rules
  path and inspect or write each unique file once. The managed block is delimited by exact
  `<!-- muninn:rules:start -->` / `<!-- muninn:rules:end -->` markers and recommends
  `muninn_bootstrap`, `muninn_search`, `muninn_inspect_symbol`, and `muninn_verify_contract` without
  mentioning Huginn. Append the block to existing content, create a missing file only for a real write,
  and replace only a complete managed block so surrounding bytes and order are preserved. Recognize a
  complete legacy `huginn:muninn-rules` block as `stale`; leave it unchanged without `--force` and
  replace it when forced. Treat unmatched, duplicate, or unterminated markers as fatal. Screen rules
  paths with `checkDocPath` during inspection and `assertDocPath` immediately before writing, refuse a
  final symlink or non-regular file, and reuse `safeWriteAtomic` with existing-mode preservation or
  `0o600` for new files. Keep rules outcomes separate from MCP outcomes, report the shared path and its
  agents, and keep status/dry-run read-only. Probe the deterministic binary associated with each
  selected agent and emit a nonfatal `not installed` warning when it is absent from `PATH`.
- **Consequences**: Muninn can provide consistent bootstrap and memory guidance without taking
  ownership of human-authored prose, and shared destination files remain free of duplicate blocks.
  Stale legacy content requires explicit `--force`, ambiguous markers fail closed, and partial setup
  results are visible as separate MCP and rules rows. Missing agent executables are informational rather
  than setup failures; Muninn reports installation state, not whether an agent connects to the server.

## ADR-19: Identify a project by a committed uid, not by its path

**Status:** Implemented.

`root_path` was the identity, so moving, renaming or recloning a project orphaned its memory, and
every non-Git directory shared one database. A project now carries `.muninn/project.json` with a
stable `uid`; resolution falls back to the Git remote (clones share identity) and then the resolved
path. A user registry under `$MUNINN_HOME` maps uid to the paths and remotes it has been seen at.
The marker is committed; the registry is a convenience, never the source of truth.

## ADR-20: Store memory outside the repository, one file per project

**Status:** Implemented.

Keeping the database in `<git-root>/.huginn/` made it invisible to clones and forced non-Git
projects into one shared file. Memory and the code graph now live in
`$MUNINN_HOME/projects/<uid>/`: isolated per project, portable across clones and machines, and
outside `git status`. The repository only carries the marker. The existing symlink screen still
applies to the resolved paths; the containment root moved from the project to `$MUNINN_HOME`.

## ADR-21: Continuity is a first-class record, not an observation category

**Status:** Implemented.

"Where we left off" is structured: goal, state, files touched, next steps, open questions,
blockers and linked decisions. Modelling it as another observation category would have forced a
SQLite CHECK rebuild and lost the structure. A dedicated `handoffs` table keeps one active record
per project, supersedes the previous one atomically, and renders first in the session brief.
Observation provenance (`agent`, `session_id`, `scope`, `tags`, `files`) was added with plain
idempotent `ALTER TABLE` steps instead.

## ADR-22: The code graph is derived, incremental and confidence-labelled

**Status:** Implemented.

The graph is derived state, so it is rebuilt from the source and never authored. Files are
content-addressed by hash (`code_index_state`), only changed files are parsed, and a transaction
replaces their symbols and edges; deleted files and dangling edges are pruned. TypeScript and
JavaScript use the Compiler API (exact imports, heritage and local calls); other languages use a
deterministic heuristic scan. Every edge records `confidence` (`exact`/`heuristic`) and
`resolution` (`resolved`/`ambiguous`/`external`/`unresolved`) so callers can tell a resolved call
from a name match. Files come from `git ls-files` in a work tree and from a `.gitignore`-aware
walker otherwise, so non-Git projects are first-class. ADR-25 adds the optional tree-sitter Tier B
and keeps the heuristic scan as the always-available fallback.

## ADR-23: One strong exploration tool, with a small graph menu

**Status:** Implemented.

Agents explore better with one broad tool than with a menu of narrow ones. `muninn_explore`
returns ranked symbols' verbatim source, their callers and callees, and related decisions within a
fixed budget; `muninn_graph` exposes the individual relations for callers that know what they want.
Both read only the database and slice source for the selected symbols, so an agent never reads the
repository to find one function. The MCP `initialize` response also carries project-aware
instructions, because activation cannot depend on an agent choosing to read a rules file.

## ADR-24: Migrate legacy databases without touching them

**Status:** Implemented.

`muninn migrate` opens legacy `.huginn` databases read-only, resolves each stored `root_path` to its
portable uid, and copies observations, entities, links and dependencies into the new store with
stable ids, remapping entities by identifier when the target already has them. Re-running is
idempotent, and the legacy file is left byte-identical. Dry runs report counts without writing.

## ADR-25: Multi-language extraction is optional and degrades, never fails

**Status:** Implemented. Extends ADR-22 and supersedes the "heuristic only" wording of ADR-6 and
ADR-11 for non-TypeScript languages.

**Context:** A single-language graph is useless in real repositories. Requiring `tree-sitter` as a
hard dependency would make installation fail without a WASM pack and slow the cold start, while
shipping only a regex scanner would lose structure in Python, Go or Rust where it is cheap to get.

**Decision:** Keep the Compiler API as the exact Tier A engine for TypeScript/JavaScript, add Tier B
as an optional dependency pair (`web-tree-sitter` + `@vscode/tree-sitter-wasm`) lazily loaded per
language, and keep Tier C — deterministic per-language regex tables — as the always-available
fallback for Python, Go, Rust, Java, C/C++, C#, Ruby, PHP and Bash. `MUNINN_TREESITTER=0` or
`--no-treesitter` forces Tier C for a run. Every edge carries `confidence` (`exact`/`heuristic`) and
`resolution`, so a consumer can tell an AST-resolved call from a name match.

**Consequences:** No project is a blank graph, installs never fail because the optional pack is
missing, and the indexer is asynchronous so one WASM initialisation is shared by every file. Tier C
can misattribute calls, which is exactly why confidence is stored rather than assumed. Adding a
language means adding a grammar id or a regex table, not a new pipeline.

## ADR-26: Activation cannot depend on the agent reading a file

**Status:** Implemented.

**Context:** Rules files are advisory: an agent that never reads them still has to find the memory.
Agents also differ in transport — some mount one MCP server per profile with no per-session cwd,
some can run shell hooks, some neither.

**Decision:** Activate on four independent channels. (1) The MCP `initialize` response carries
project-aware instructions, so every client sees the rules before its first prompt. (2) The marked
rules block is installed by `muninn setup` for agents that read one. (3) Hooks are a command
contract — `muninn hook session-start` prints the brief and `muninn hook session-end` writes a handoff
from Git state — so any hook mechanism can use them, and `muninn hooks install` merges those two into
Claude Code's `settings.json` only on request. (4) `muninn doctor` diagnoses the rest: missing or
legacy entries, a pinned `--project`, a malformed file, or a runtime without MCP support.

For a profile-scoped server with no session cwd, `MUNINN_SESSION_AUTODETECT=dsh` follows the newest
DSH session's recorded working directory. If that directory is a project it binds automatically; if it
is a workspace it lists the candidate repositories and `muninn_project { action: "use" }` pins one for
the rest of the process, including `muninn_bootstrap`.

**Consequences:** No agent is privileged and none is assumed. Autodetection is opt-in, an explicit
`use` wins over it, and a workspace is never guessed. Hooks may double-write a handoff if an agent
both hooks and calls `muninn_handoff`; the newest handoff supersedes the previous one, so the result
stays consistent.

## ADR-27: Global preferences and repository snapshots are the portability layer

**Status:** Implemented.

**Context:** Two continuity gaps remain after portable identity: a preference that applies to every
project has no home, and moving memory between machines required copying a database.

**Decision:** Route `scope: "global"` observations to a separate store under
`$MUNINN_HOME/global/`; the project brief renders them under "Global preferences", and search/context
include them only with `includeGlobal`. Provide `muninn snapshot` / `muninn restore` over the existing
idempotent JSONL sync, writing `<project>/.muninn/memory.jsonl` for the user to commit. Provenance
(`scope`, `agent`, `session_id`, `tags`, `files`) travels with both.

**Consequences:** Preferences survive across projects and restores keep their scope. The snapshot is
merge-by-id, so it is not a conflict-resolution protocol, and committing it puts memory under review
like any other file. The per-project database remains the source of truth.

## ADR-28: An explicit uncapped brief, not a higher numeric ceiling

**Status:** Implemented.

**Context:** The session brief capped `budgetChars` at 20,000 characters, and its truncation marker
said "increase budgetChars to see the rest" while printing that marker precisely when the ceiling was
reached, so the advice was impossible to follow. Two further caps made the ceiling the wrong lever:
recent activity was limited to 20 rows, related symbols to 50 and global preferences to 8 regardless
of the character budget, so even a larger number could not return the complete brief. The surfaces
also disagreed: the service, the MCP schema and the CLI each validated the budget separately, and the
session-start hook clamped any request to 20,000 silently and defaulted to 4,000 instead of 8,000 —
a caller asking for 60,000 received a shorter brief with no indication that its request had been
rewritten.

**Decision:** Keep 20,000 as the numeric ceiling and default 8,000 everywhere, and add an explicit
`budgetChars: "all"` mode (boolean alias `all: true`, CLI and hook `--all`, `--budget all`) that lifts
both the character budget and the per-section row limits and appends a deterministic diagnostics
footer with the rendered size and section row counts. Resolve budgets through one shared
`resolveSessionBriefBudget`, used by the service, the MCP schema, the CLI and the hook; no surface
clamps silently. The truncation marker reports rendered versus total characters and names reachable
options (`"all"`, `paths`, `muninn_explore`) instead of advising a value that is already at its
maximum.

**Consequences:** An unbounded brief is always an explicit request, so the default context cost does
not change, and a hard ceiling no longer leaves a caller without a way to read everything. The
per-section limits remain the documented default behavior and are bypassed only on this path; the
neighbor traversal's public 50-neighbor clamp still applies outside it. Large renders are the
caller's responsibility, which is why the footer makes their size and composition visible. The
numeric ceiling is intentionally not raised: a bigger arbitrary number would not have removed the
per-section caps and would have hidden the same dead end behind a longer brief.

## ADR-29: Search is tiered, weighted and compact by default

- **Date**: 2026-11-27
- **Status**: Accepted and implemented
- **Context**: FTS5 `MATCH` is a conjunction: `"session" "brief"` only matches rows that contain
  both terms. Agents ask questions in natural language, so a strict conjunction silently returns
  nothing for most real questions (measured: 3 of 10 representative queries returned any row). The
  alternative — a vector index — was rejected by ADR-4 and remains out of scope.
- **Decision**: Plan every query in tiers over the same FTS index. The first tier keeps the
  historical conjunction (paths, symbols and phrases stay precise). The second tier is the same
  terms joined with `OR` and prefix-expanded (`"term"*`); it only runs when the first tier could not
  fill the page, and its rows are appended with monotonically worse ranks so a weaker match never
  outranks a complete one. A third tier uses the trigram index for substring recovery and only runs
  when both earlier tiers are empty. Ranking is BM25 with column weights (title 8, content 1, topic
  key 3), plus a small boost for observations linked to an entity named in the query. Rows with
  identical title and content collapse to the best-ranked copy. MCP results are compact by default
  (identity, rank, 90-character excerpt, at most five linked entity identifiers); `detail: "full"`
  returns the whole record.
- **Consequences**: Natural-language recall rises from 3/10 to 10/10 on the measured set while
  single-term, path and phrase queries keep their previous behaviour. A default ten-result page
  costs roughly a quarter of the previous tokens. The tiers are deterministic and testable, and the
  planner is one module (`src/service/search-plan.ts`). Callers that relied on the implicit
  conjunction can pass `match: "all"` (the first tier) through the same planner.

## ADR-30: The lexical index understands morphology and symbol subwords

- **Date**: 2026-11-27
- **Status**: Accepted and implemented
- **Context**: The memory index used the default `unicode61` tokenizer, so `verifying` never matched
  `verify` and `sesion` never matched `sesión`. Code-symbol search had a second gap: SQLite splits
  tokens only on non-alphanumerics, so `verifyTypeScriptContracts` was one opaque token and a search
  for `contract` found nothing. Freshness was also unreliable: the incremental check compared mtime
  and size, `content_hash` was computed but never compared, and `INDEXER_VERSION` was written but
  never read, so a changed extractor never invalidated an existing graph.
- **Decision**: Schema v5 rebuilds the memory FTS table with `tokenize='porter unicode61
  remove_diacritics 2'`, adds an `observations_trigram` table for substring recovery, and rebuilds
  the symbol FTS with porter plus a `search_tokens` column filled with camelCase/snake_case subwords.
  Incremental indexing now requires a matching `INDEXER_VERSION` and compares the file's content
  hash when mtime, ctime and size differ from the stored fingerprint; identical bytes refresh only
  the fingerprint. A `code_index_roots` row stores the worktree HEAD, indexer version and file count.
  Migrations drop and rebuild FTS tables (a tokenizer cannot change in place), backfill subword
  tokens before rebuilding, and stay idempotent.
- **Consequences**: Morphological variants, diacritics and subword queries match without leaving
  SQLite. Reindexing is correct after a file rewrite that preserves mtime, after a checkout and
  after an indexer upgrade. The migration is heavier than the previous additive steps and must be
  validated against real databases; `musl`-style SQLite builds older than 3.34 would not support
  trigram, which the package's bundled SQLite does.

## ADR-31: Graph freshness is a first-class signal and the MCP server refreshes it

- **Date**: 2026-11-27
- **Status**: Accepted and implemented
- **Context**: Indexing was manual. The graph is derived state, so every answer that reads it
  describes whatever commit was indexed last — in the measured project, 9 of 62 files had changed
  five days after the last index. Rules files can ask an agent to index, but rules are advisory and
  most agents expose no hook. The MCP server is the one activation path every supported agent shares.
- **Decision**: Report freshness, do not assume it. `checkIndexFreshness` combines the stored root
  fingerprint (`code_index_roots`), `git rev-parse HEAD` and `git status --porcelain`; it falls back
  to stat-ing indexed files outside Git. Freshness appears in `muninn_project status`, in the
  session brief ("Code graph" section with a STALE line) and in `muninn doctor`. Before a
  graph-reading MCP tool runs, the server performs a debounced (10 s) incremental refresh, skipping
  cold graphs and graphs more than 500 files behind, and `MUNINN_AUTO_INDEX=0` disables it. The
  agent-agnostic command `muninn hook after-edit` refreshes incrementally and is a no-op in a project
  without a Muninn database; the Claude hook plan calls it from `Stop` once per turn.
- **Consequences**: Agents no longer need to remember to index, and every agent benefits, including
  ones with no hooks. A refresh costs one process spawn per turn where the hook is installed and
  one bounded incremental pass where it is not. The brief gains roughly 200 characters; the token
  cost is repaid the first time an agent avoids a stale-symbol answer.

## ADR-32: Setup adapters are catalog data, and each agent gets its best supported target

- **Date**: 2026-11-27
- **Status**: Accepted and implemented
- **Context**: ADR-26 states that no agent is privileged, but the implementation had two Claude
  special cases: the rules block was appended to the shared `CLAUDE.md`, and the hook installer
  hardcoded `~/.claude/settings.json`. Devin already received a dedicated rules file, so the
  catalog could express the difference without agent-specific code.
- **Decision**: Every catalog entry declares `rulesStrategy` (`dedicated`, `marked-block` or `none`)
  and, where the agent exposes one, a `hooks` descriptor with user and project settings paths and
  the events to merge. Claude moves to a dedicated `.claude/rules/muninn.md` (Claude Code v2.1.211+
  reads `.claude/rules/*.md`), keeps `CLAUDE.md` as the documented fallback for older versions, and
  gains `muninn hooks install --agent claude --scope user|project`. Marked blocks stay for shared
  files (`AGENTS.md`, `QWEN.md`, `.cursorrules`) and DSH declares `none`. `muninn doctor` derives its
  rules and hook probes from the same descriptors instead of naming an agent in code.
- **Consequences**: Adding an agent with a hook mechanism or a native rules slot is a registry entry.
  Claude is at its best supported configuration without being the only privileged one, and the
  installer no longer writes to a user-wide file without an explicit scope. Agents older than the
  rules-directory support lose only the file channel; MCP initialize instructions still activate them.

## ADR-33: The session brief is summary-first

- **Date**: 2026-11-27
- **Status**: Accepted and implemented
- **Context**: The brief is the first thing a session reads, and it was spending its entire 8,000
  character budget on full observation bodies: 45 decisions with no cap, plus twenty recent
  activities, produced a truncated document that still cost about 2,000 tokens.
- **Decision**: Render the brief as a map, not the archive. `detail: "summary"` (the default) keeps
  the first 250 characters of the handoff state, the first 100 characters of its steps and questions,
  a 75-character gist per decision, at most ten decisions, three recent activities and two global
  preferences, and states how many decisions were omitted. `detail: "full"` restores the previous
  rendering. `budgetChars: "all"` (ADR-28) implies `detail: "full"` unless the caller
  asks otherwise, so an explicit uncapped request still returns every section in full. The
  "Code graph" section renders the freshness line from ADR-31.
- **Consequences**: On the measured project the brief drops from 8,011 truncated characters to 4,857
  complete ones (about 1,200 tokens) while keeping continuity and the decision index. Readers reach
  the omitted material with `muninn_search` or a topic key. The cap is a rendering concern only; the
  library still returns every decision in `activeDecisions`.


## ADR-34: Setup installs only the components the user selects

- **Date**: 2026-11-27
- **Status**: Accepted and implemented
- **Context**: `muninn setup` wrote the portable configuration and the agent rules in addition to the
  MCP entry the user asked for, with only `--no-rules` and `--no-portable` to opt out. Every write is
  a change to a file the user owns, and an installer that decides on its own what is "helpful" makes
  the cost invisible. Hooks were already separate (`muninn hooks install`), so the same explicit
  model can cover the rest of the setup surface.
- **Decision**: Add `--components <mcp,rules,portable|all>` (default `all`, preserving the documented
  behavior) and apply it to status and writes alike; `--no-rules` and `--no-portable` narrow the same
  selection instead of competing with it. Reject a selection that installs nothing or an unknown
  component, and require `--agent` when the portable component is excluded. `setup` never installs
  hooks; that stays an explicit second command.
- **Consequences**: A user can install an MCP entry without touching rules or the portable file, or a
  rules file without a portable entry. The default is still the full set, so existing scripts keep
  working, but the full set is now a visible choice rather than an invisible side effect. Status
  reports the same components it would write.

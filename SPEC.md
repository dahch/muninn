# Spec: Muninn Portable Project Memory

Muninn is a standalone, local-first memory engine for coding agents and developers. It stores
project observations in SQLite, searches them with FTS5/BM25, indexes TypeScript and JavaScript
symbols and their dependencies, and exposes memory operations through a library, CLI, and MCP
server. The current codebase adds explicit decision supersession with lifecycle-aware retrieval, a
read-only session-bootstrap brief shared by the library, MCP, and CLI, and bounded dependency-neighbor
recovery. The project is independent of Huginn and can be embedded by any compatible client.

> **Implementation status (current codebase):** session briefs/read-only bootstrap (ADR-2) are
> implemented through `MemoryService.getSessionBrief`, `readSessionBrief`, `muninn_bootstrap`, and
> `muninn memory brief`. Dependency-neighbor recovery (ADR-3) is implemented through
> `MemoryService.neighbors`, brief `expandGraph`, and the `neighbors` field on symbol inspection.

## Goals

- Preserve project-scoped observations, FTS5 search, symbol indexing, JSONL synchronization,
  contract verification, CLI, and MCP functionality.
- Make decision replacement explicit, traceable, and opt-in; never infer supersession from recency.
- Keep memory local, advisory, and safe to read or write when the project path is untrusted.
- Preserve existing databases and imported JSONL records without data loss.

## Non-goals

- Changing Huginn or requiring any orchestrator integration.
- Ingesting conversations, transcripts, or agent sessions.
- Generating summaries or other content with a model.
- Adding embeddings, vector search, network services, dependencies, or database tables.
- Inferring decisions, symbols, dependencies, or other facts not stored in Muninn.
- Relationships derived from names, paths, or proximity instead of stored dependency edges.

## Users and personas

- **Coding agent:** Searches memory, inspects symbols, and saves observations through MCP or the
  library.
- **Developer:** Initializes, searches, indexes, synchronizes, and reads project memory using the CLI.
- **Client integrator:** Embeds the standalone library or connects another MCP-capable runtime
  without depending on Huginn.

## Functional requirements

### Project memory and storage

**REQ-1 — Project-scoped observation storage.** Muninn shall store observations in SQLite scoped
to a project. Each observation shall retain its category, title, content, optional topic key,
lifecycle status, replacement link, timestamps, and linked entities. Supported categories are
`decision`, `convention`, `discovery`, `bugfix`, and `architecture`. Project identity shall include
name, root path, and optional sanitized Git remote.

**AC-1**
- Saving an observation persists it for the selected project and returns it with linked entities.
- Invalid categories, empty titles, and missing or non-string content are rejected by the service.
- Existing project records and observations remain usable after this update.

**REQ-2 — Initialize and safely migrate databases.** The schema shall remain defined in both
`src/db/schema.sql` and the `SCHEMA_SQL` fallback in `src/db/client.ts`. New databases shall include
`observations.status` (`active` or `superseded`, non-null, default `active`) and nullable
`observations.superseded_by`. Opening a database shall idempotently add either missing column using
`PRAGMA table_info(observations)` and `ALTER TABLE`, without recreating tables or removing data,
indexes, or triggers.

**AC-2**
- A database created from the pre-update DDL opens successfully with every existing row intact and
  each migrated row having `status = 'active'` and `superseded_by = NULL`.
- Reopening a migrated database does not attempt to add existing columns again or alter existing data.
- A database missing either or both new columns is migrated by adding only the missing column(s).
- The on-disk DDL and embedded fallback define the same observation columns.
- Existing FTS5 triggers remain unchanged and inserts, searches, and updates keep the FTS index
  correct after migration.

**REQ-3 — Preserve project path safety and local database behavior.** Muninn shall resolve its
database to `<git-root>/.huginn/muninn.db` in a Git repository and `~/.huginn/muninn.db` otherwise,
unless a database path is supplied. Project root and database resolution shall use the same selected
root. Writes to the database and JSONL export/import shall use the existing path-safety checks.

**AC-3**
- An explicit `--project` root selects both the project record and default database location.
- `:memory:` remains available for isolated use and tests.
- A symlink on the final path component is refused for protected database and export/import paths.
- A project-relative protected path that resolves outside the project root is refused.
- No network access is required for storage or retrieval.

### Decision supersession and retrieval

**REQ-4 — Supersede decisions explicitly.** `saveObservation` shall accept optional
`supersedesTopicKey` (and `supersedes_topic_key`). When the new observation is a `decision`, the
service shall, in the same transaction that saves it, mark active decisions in the same project whose
`topic_key` matches that key as `superseded`, and set their `superseded_by` to the new observation's
ID. Other categories shall never be superseded by this operation. A key matching no active decisions
is not an error.

**AC-4**
- Saving a decision with `supersedesTopicKey` replaces only active decisions in the current project
  with the matching topic key.
- The new decision and all status/link updates succeed or roll back together.
- A superseded decision has `status = 'superseded'` and `superseded_by` set to the new decision's ID.
- Observations in other projects, non-decision categories, decisions with another topic key, and
  already-superseded decisions remain unchanged.
- A nonmatching key still saves the new decision successfully.
- Saving without `supersedesTopicKey` does not supersede any decision.
- A decision never supersedes itself, even when its own topic key matches.

**REQ-5 — Filter superseded observations by default.** `search` and `getContext` shall accept
optional `includeSuperseded` (and `include_superseded`), defaulting to `false`. When false, SQL shall
exclude superseded observations; when true, results shall include both statuses and expose `status`
and `superseded_by`.

**AC-5**
- Default search and context results exclude superseded observations at query time.
- Setting `includeSuperseded: true` returns matching active and superseded observations, including
  their status and replacement ID.
- Existing query, category, project, topic, all-project, ranking, and limit behavior remains available.
- `inspectSymbol` and `getStats` retain their existing output shapes; inspection can still return
  superseded observations linked to a symbol.

**REQ-6 — Extend existing MCP memory tools compatibly.** `muninn_save` shall accept optional
`supersedesTopicKey`; `muninn_search` and `muninn_context` shall accept optional
`includeSuperseded`. Each shall also accept the corresponding snake_case alias through the existing
argument normalization pattern. Existing tool names and required arguments shall remain compatible.

**AC-6**
- MCP schemas validate the new optional arguments and their snake_case aliases.
- Existing calls that omit the new arguments continue to work with the defaults in REQ-4 and REQ-5.
- Invalid inputs produce the existing structured tool error response without terminating the MCP
  server.

### Session bootstrap (ADR-2)

**REQ-19 — Provide a typed, bounded session brief.** Muninn shall expose
`MemoryService.getSessionBrief({ paths?, budgetChars? })` and a standalone read-only
`readSessionBrief` entry point. The brief shall contain project identity, active decisions, recent
activity, path-selected indexed symbols, counts, and explanatory notes, omitting empty sections rather
than fabricating data.

**AC-19**
- Active decisions are grouped by stored topic key; unkeyed decisions are listed separately and
  multiple active decisions with the same key are not collapsed.
- Recent activity excludes active decisions already listed, labels superseded observations, and
  counts all observations including superseded ones.
- Missing, inaccessible, corrupt, or uninitialized databases produce an empty brief with a cause in
  `notes` and unavailable (`null`) counts without throwing or creating database state.

**REQ-20 — Select indexed symbols by bounded project paths.** A brief shall accept at most 20 file or
directory paths, resolve them relative to the project root, normalize separators, reject paths outside
the project, and match only existing indexed `entities.file_path` values without scanning the
repository.

**REQ-21 — Render deterministic Markdown within a character budget.** The shared renderer shall
produce deterministic output and enforce a positive integer `budgetChars` (default 8,000, maximum
20,000) over the complete Markdown, including headings, notes, and a visible truncation marker.

**REQ-22 — Provide MCP and CLI bootstrap surfaces with shared output.** `muninn_bootstrap` (with Zod
validation and camelCase/snake_case aliases) and `muninn memory brief [--project <path>] [--paths a,b]
[--budget <n>]` shall return the service renderer output. Default MCP servers shall not initialize a
writable database merely to serve bootstrap.

### Graph-aware recovery (ADR-3)

**REQ-23 — Traverse stored dependency neighbors with bounds.** `MemoryService.neighbors(identifier,
{ depth?, limit? })` shall follow stored `entity_dependencies` edges in both directions, grouped by
relation and direction, with deterministic ordering, cycle protection, and no duplicate entities.
`depth` defaults to 1 and is clamped to at most 2; `limit` defaults to 20 and is clamped to at most
50. Unknown identifiers return no traversal. No relationship is inferred from names or paths.

**REQ-24 — Expand briefs and inspection from the graph.** Session briefs shall accept `expandGraph`
(default `true`) and include deduplicated related symbols for the path-selected entities within the
existing Markdown budget. A disabled expansion adds no related section; an enabled expansion with no
stored dependencies omits the section and explains why in `notes`. `muninn_inspect_symbol` shall add
a bounded depth-1 neighbor traversal from the same implementation while retaining its existing
inspection fields and without adding a new MCP tool.

### Search, symbols, synchronization, and statistics

**REQ-7 — Preserve FTS5/BM25 search and recent context.** Search shall continue to use SQLite FTS5
with safely sanitized queries and BM25 ranking; context shall continue to return recent observations.
Both shall preserve project/category/topic filtering, all-project options, and bounded result limits.

**AC-7**
- Search results are ranked using FTS5 BM25, with lower rank values ordered first.
- Empty or unusable sanitized queries return an empty result without an FTS query syntax failure.
- Existing filters and result limits continue to work alongside the superseded filter.
- Context remains ordered by `updated_at DESC, created_at DESC` with bounded limits.

**REQ-8 — Preserve symbol indexing, inspection, and linking.** The TypeScript Compiler API indexer
shall continue to index supported TypeScript/JavaScript source files, including file and symbol
entities and `imports`, `extends`, `implements`, and `references` dependencies. The schema permits a
`calls` relation, but the current indexer does not extract call edges.
Observation-symbol linking and symbol inspection shall remain available.

**AC-8**
- Indexing continues to create/update indexed entities and dependency edges and to prune obsolete
  indexed entities according to existing behavior.
- Existing symbol normalization and observation linking behavior remains functional.
- Symbol inspection continues to return the entity, incoming/outgoing dependencies, and linked
  observations.
- Unsupported, out-of-boundary, oversized (over 2 MB), or unreadable input files are skipped
  according to existing indexer validation.

**REQ-9 — Preserve JSONL synchronization and statistics.** Existing JSONL export/import and
project-scoped or global statistics shall remain supported. Existing JSONL files shall remain
importable after the schema migration.

**AC-9**
- Export and import retain existing path, atomic-write, permissions, malformed-line handling, and
  duplicate-skipping behavior.
- Exported records include `status` and `superseded_by`; records imported without those fields
  receive the schema default `active` and a null replacement link.
- Existing statistics retain their `projects`, `observations`, `entities`, and `links` shape and
  meaning; superseded observations are included in counts.

### MCP, CLI, and contract verification

**REQ-10 — Preserve the MCP server contract.** Keep the pre-existing `muninn_save`, `muninn_search`,
`muninn_context`, `muninn_link_symbol`, `muninn_stats`, `muninn_inspect_symbol`, and
`muninn_verify_contract` tools and their established required arguments, alongside the
`muninn_bootstrap` tool added by REQ-22. Retain Zod validation, snake_case aliases where supported,
safe argument normalization, structured errors, and bounded stdio transport behavior.

**AC-10**
- All eight registered tools remain callable, and the seven pre-existing tool contracts remain
  compatible.
- Existing calls remain compatible unless using an invalid input.
- Invalid arguments and handler errors return tool errors without crashing the server.
- MCP protocol traffic remains on stdout; diagnostics do not corrupt it.
- A closed parent pipe or stdin EOF shuts the server down cleanly instead of hanging or crashing.

**REQ-11 — Preserve the CLI and TypeScript contract verifier.** Keep `muninn memory init`,
`memory search`, `memory sync`, `memory index`; `muninn check`; and `muninn mcp run`. Contract
verification shall continue to use the TypeScript Compiler API without emitting build artifacts and
shall report structured diagnostics for requested project files.

**AC-11**
- Existing commands retain their established options and behavior.
- `muninn check` reports contract diagnostics and sets a failing exit code when errors are found.
- Contract verification rejects target files outside the project root and missing files.
- MCP stdio startup remains silent on stdout and shuts down cleanly when its parent disconnects.

## Domain model

| Entity | Meaning | Key fields |
|---|---|---|
| Project | A repository or directory whose memory is isolated | `id`, `name`, `root_path`, sanitized `git_remote` |
| Observation | A durable project lesson or decision | `id`, `project_id`, `category`, `title`, `content`, `topic_key`, `status`, `superseded_by`, timestamps |
| Entity | An indexed code symbol or file | `id`, `project_id`, `entity_type`, `identifier`, `file_path` |
| ObservationEntity | Link between an observation and an entity | `observation_id`, `entity_id` |
| EntityDependency | Directed relationship between code entities | `source_entity_id`, `target_entity_id`, `relation_type` |

Observation lifecycle is `active` → `superseded`. A superseded observation retains its content and
points at the newer observation that replaced it; it is hidden from default search/context but is
still counted, exported, inspected, and returned when explicitly requested.

## Non-functional requirements

### Performance and boundedness

- Search and context limits are clamped to `1..500` (defaults: 10 for search, 20 for context).
- Entity hydration for observations is chunked at 500 observation IDs per SQLite query.
- Indexing parses files outside the database transaction, skips files over 2 MB, and writes entities
  and dependencies in a short-lived transaction.
- Contract verification uses targeted `rootNames` and pre-emit diagnostics rather than emitting files.
- MCP stdio writes have a 5-second deadline and fail the pending request instead of hanging.

### Security

- No network calls, embeddings, or external services are required.
- Preserve path containment and symlink protection for database and JSONL paths.
- Validate MCP inputs with Zod and retain argument-normalization protections against prototype
  pollution.
- Sanitize terminal text written to stderr so control characters and bidi overrides cannot corrupt logs.
- Git remote credentials shall not be persisted.

### Reliability and determinism

- Database migration is idempotent and preserves existing rows, indexes, and triggers.
- Supersession updates and observation creation are atomic.
- JSONL export writes a temporary file with `0o600` permissions and atomically renames it.
- JSONL import is idempotent by observation ID.
- Search, context, and indexing failures for individual files/queries do not abort unrelated work;
  fatal SQLite I/O and corruption errors in search are re-thrown.

### Compatibility and implementation

- Existing MCP tool names and required inputs remain compatible; additions to existing tools are
  optional parameters.
- Maintain TypeScript strictness, ESM, and `.js` extensions for relative imports.
- Make no database schema changes beyond `status` and `superseded_by`; create no tables.
- Keep the duplicated schema definitions synchronized.
- Update `README.md`, `DESIGN.md`, and `CHANGELOG.md` in the same change as each implementation increment.

## Planned, not implemented

No planned feature from the current specification remains unimplemented.

## Out of scope

- Any change to Huginn or integration that calls bootstrap or automatically writes observations at
  session end.
- Conversation or transcript ingestion, hooks, or session parsing.
- Model-generated summaries or other generated memory content.
- Embeddings, vector databases, network services, or new runtime dependencies.
- New database tables or schema changes beyond the two observation columns.
- A new graph MCP tool or relationships inferred without stored dependency edges.

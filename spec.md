# Spec: Muninn Portable Project Memory

Muninn is a standalone, local-first memory engine for coding agents and developers. It stores project observations in SQLite, searches them with FTS5/BM25, indexes TypeScript and JavaScript symbols and their dependencies, and exposes memory operations through a library, CLI, and MCP server. This update adds explicit decision supersession, a bounded session-start brief that can be read without creating a database, and dependency-graph neighbors in recovery. The project remains independent of Huginn and usable by any compatible client.

## Goals

- Preserve existing Muninn memory, indexing, synchronization, contract-verification, CLI, and MCP functionality.
- Make decision replacement explicit, traceable, and opt-in; never infer supersession from recency.
- Let agents retrieve a deterministic, bounded project brief at session start.
- Include indexed symbol neighbors in recovery using the existing dependency graph.
- Keep memory local, advisory, and safe to read when unavailable.

## Non-goals

- Changing Huginn or requiring any orchestrator integration.
- Ingesting conversations, transcripts, or agent sessions.
- Generating summaries or other content with a model.
- Adding embeddings, vector search, network services, dependencies, or database tables.
- Inferring decisions, symbols, dependencies, or other facts not stored in Muninn.

## Users and personas

- **Coding agent:** Reads a bounded bootstrap brief, searches memory, inspects symbols, and saves observations through MCP or the library.
- **Developer:** Initializes, searches, indexes, synchronizes, and reads project memory using the CLI.
- **Client integrator:** Embeds the standalone library or connects another MCP-capable runtime without depending on Huginn.

## Functional requirements

### Existing project memory and storage

**REQ-1 — Preserve project-scoped observation storage.** Muninn shall store observations in SQLite scoped to a project. Each observation shall retain its category, title, content, optional topic key, timestamps, and linked entities. Supported categories are `decision`, `convention`, `discovery`, `bugfix`, and `architecture`. Project identity shall include name, root path, and optional sanitized Git remote.

**AC-1**
- Saving an observation persists it for the selected project and returns the observation with its linked entities.
- Invalid categories, empty titles, and missing or non-string content are rejected by the service.
- Existing project records and observations remain usable after this update.

**REQ-2 — Preserve database initialization and safely migrate existing databases.** The schema shall remain defined in both `src/db/schema.sql` and the `SCHEMA_SQL` fallback in `src/db/client.ts`. New databases shall include `observations.status` (`active` or `superseded`, non-null, default `active`) and nullable `observations.superseded_by`. Opening a database shall idempotently add either missing column using `PRAGMA table_info(observations)` and `ALTER TABLE`, without recreating tables or removing data, indexes, or triggers.

**AC-2**
- A database created from the pre-update DDL opens successfully with every existing row intact and each migrated row having `status = 'active'` and `superseded_by = NULL`.
- Reopening a migrated database does not attempt to add existing columns again or alter existing data.
- A database missing either or both new columns is migrated by adding only the missing column(s).
- The on-disk DDL and embedded fallback define the same observation columns.
- Existing FTS5 triggers remain unchanged and inserts, searches, and updates continue to keep the FTS index correct after migration.

**REQ-3 — Preserve project path safety and local database behavior.** Muninn shall keep resolving its database to `<git-root>/.huginn/muninn.db` in a Git repository and `~/.huginn/muninn.db` otherwise, unless a database path is supplied. Project root and database resolution shall use the same selected root. Writes to the database and JSONL export shall continue to use the existing path-safety checks.

**AC-3**
- An explicit `--project` root selects both the project record and default database location.
- `:memory:` remains available for isolated use and tests.
- A symlink or path escaping a permitted project boundary is refused for protected database or export writes.
- No network access is required for storage or retrieval.

### Decision supersession and retrieval

**REQ-4 — Supersede decisions explicitly.** `saveObservation` shall accept optional `supersedesTopicKey`. When the new observation is a `decision`, the service shall, in the same transaction that saves it, mark active decisions in the same project whose `topic_key` matches that key as `superseded`, and set their `superseded_by` to the new observation’s ID. Other categories shall never be superseded by this operation. A key matching no active decisions is not an error.

**AC-4**
- Saving a decision with `supersedesTopicKey` replaces only active decisions in the current project with the matching topic key.
- The new decision and all status/link updates succeed or roll back together.
- A superseded decision has `status = 'superseded'` and `superseded_by` set to the new decision’s ID.
- Observations in other projects, non-decision categories, decisions with another topic key, and already-superseded decisions remain unchanged.
- A nonmatching key still saves the new decision successfully.
- Saving without `supersedesTopicKey` does not supersede any decision.

**REQ-5 — Filter superseded observations by default.** `search` and `getContext` shall accept optional `includeSuperseded`, defaulting to `false`. When false, SQL shall exclude superseded observations; when true, results shall include both statuses and expose `status` and `superseded_by`.

**AC-5**
- Default search and context results exclude superseded observations at query time.
- Setting `includeSuperseded: true` returns matching active and superseded observations, including their status and replacement ID.
- Existing query, category, project, topic, all-project, ranking, and limit behavior remains available.
- `inspectSymbol` and `getStats` retain their existing output shapes.

**REQ-6 — Extend existing MCP memory tools compatibly.** `muninn_save` shall accept optional `supersedesTopicKey`; `muninn_search` and `muninn_context` shall accept optional `includeSuperseded`. Each shall also accept the corresponding snake_case alias (`supersedes_topic_key`, `include_superseded`) through the existing argument normalization pattern. Existing tool names and required arguments shall remain compatible.

**AC-6**
- MCP schemas validate the new optional arguments and their snake_case aliases.
- Existing calls that omit the new arguments continue to work with the defaults in REQ-4 and REQ-5.
- Invalid inputs produce the existing structured tool error response without terminating the MCP server.

### Session brief and read-only bootstrap

**REQ-7 — Produce a typed session brief.** `MemoryService.getSessionBrief({ paths?, budgetChars? })` shall provide a typed brief with the following optional content sections and notes:
- `project`: project name, root path, and Git remote when available.
- `decisions`: active decisions with title and content, grouped by topic key.
- `activity`: recent observations ordered by `updated_at DESC`, excluding decisions already listed in the decisions section.
- `symbols`: indexed symbols matching the requested paths.
- `counts`: total observations, entities, and links for the project.
- `notes`: explanations for unavailable, omitted, or empty content.

**AC-7**
- Decisions with no topic key appear as separate entries.
- Multiple active decisions with the same topic key are grouped together; recency alone never removes or supersedes one.
- Counts include superseded observations.
- Empty sections are omitted and explained in notes; no data or summary is fabricated.
- Activity may include superseded observations, but every such observation is clearly labelled `superseded`.
- The brief’s ordering and tie-breaking are stable for identical database state.

**REQ-8 — Select indexed symbols using safe project paths.** `paths` shall accept up to 20 file or directory paths, relative to the project root or absolute within it. Matching shall normalize path separators and respect directory boundaries. Bootstrap shall use only already-indexed symbols and shall not scan the repository.

**AC-8**
- A file path selects symbols indexed for that file; a directory selects symbols whose paths are within that directory.
- A directory such as `src/auth` matches `src/auth/login.ts` but not `src/author.ts`.
- Equivalent relative and in-project absolute paths resolve consistently.
- Paths outside the project do not expose symbols outside the project.
- No repository scan or inferred symbol is used to fill a missing index result.

**REQ-9 — Bound and render the brief deterministically.** The brief shall have a default `budgetChars` of 8,000 and a maximum of 20,000. The rendered Markdown length, including headings, notes, and truncation markers, shall not exceed the requested budget. Content truncation shall be visible with `…`. Output shall have stable section and item ordering.

**AC-9**
- The final rendered Markdown never exceeds the requested character budget, including with large datasets.
- The default budget is 8,000 characters; a valid larger budget is honored up to 20,000.
- Content shortened to fit is visibly marked with `…`.
- If the budget cannot fit normal content, the renderer returns a shorter output, down to `…` if necessary, without exceeding the budget.
- Invalid non-positive, non-integer, or over-maximum budgets are rejected at validated interfaces.
- Identical data and options render identical Markdown.

**REQ-10 — Make bootstrap read-only and fail open.** Session brief retrieval shall not create a database, run schema DDL, or insert a project record. If the database is missing, inaccessible, or corrupt, it shall return an empty brief with the cause in `notes` and shall not throw. When a readable database has no project row, basic project identity may be derived from the selected root path and Git; unavailable values shall not be invented.

**AC-10**
- A missing database returns a brief with an explanatory note and does not create the database file.
- An unreadable or corrupt database returns a brief with a diagnostic note and does not throw.
- A read-only bootstrap does not execute migrations, DDL, or project insertion.
- A readable database without a project record still returns a valid brief with only identity details that can be derived.
- Write operations continue to report their errors rather than silently succeeding.

**REQ-11 — Expose the same brief through MCP and CLI.** Add MCP tool `muninn_bootstrap` with optional `paths` (maximum 20) and `budgetChars`, following existing Zod validation, argument normalization, and structured-error patterns. Add `muninn memory brief [--project <path>] [--paths a,b] [--budget <n>]`. MCP and CLI shall use the same service and Markdown renderer.

**AC-11**
- The tool is registered in `TOOL_REGISTRY` and appears in the MCP tool list.
- MCP returns the same rendered Markdown as the service for equivalent data and options.
- CLI prints the same rendered Markdown for equivalent data and options.
- The project-empty case exits successfully and prints the brief’s empty-state notes.
- Existing CLI commands and MCP tools remain available.

### Dependency graph recovery

**REQ-12 — Query graph neighbors.** Add `MemoryService.neighbors(identifier, { depth?, limit? })` using existing `entity_dependencies`. Traversal shall follow edges in both directions and return neighbors grouped by relation type and direction, in deterministic order. Default depth is 1 and maximum depth is 2; default limit is 20 and maximum limit is 50. Out-of-range values shall be clamped to allowed limits rather than throwing. Each entity shall be visited at most once.

**AC-12**
- For a chain `a → b → c`, depth 1 returns `b`, and depth 2 can return `b` and `c`.
- Incoming and outgoing directions are represented distinctly.
- Cycles terminate without duplicate entities.
- Depth and neighbor limits are respected; out-of-range values are clamped.
- A node with many edges returns at most the requested number of unique neighbors.
- Ordering is deterministic within each relation type and direction.
- No relationship is inferred from symbol names or paths.

**REQ-13 — Include graph context in briefs and symbol inspection.** `getSessionBrief` shall accept `expandGraph`, default `true`. When enabled, it shall add a `related` section containing deduplicated neighbors of symbols selected by `paths`; this content shares the brief’s total character budget. `muninn_inspect_symbol` shall include neighbors from the same traversal engine at depth 1 with a bounded result. No new graph MCP tool shall be added.

**AC-13**
- With indexed dependencies and matching path symbols, the brief includes related symbols when graph expansion is enabled.
- Related symbols are deduplicated and included within the same total render budget.
- When graph expansion is disabled, no related section is added.
- When no dependencies are indexed for the requested symbols, the related section is omitted and notes explain why.
- `muninn_inspect_symbol` returns neighbors from the same traversal implementation at depth 1.
- Existing symbol inspection information remains available.

### Existing search, symbol, sync, and statistics capabilities

**REQ-14 — Preserve FTS5/BM25 search and recent context.** Search shall continue to use SQLite FTS5 with safely sanitized queries and BM25 ranking; context shall continue to return recent observations. Both shall preserve project/category/topic filtering, all-project options, and bounded result limits.

**AC-14**
- Search results are ranked using FTS5 BM25, with lower rank values ordered first.
- Empty or unusable sanitized queries return an empty result without an FTS syntax failure.
- Existing filters and result limits continue to work alongside the new superseded filter.
- Context remains ordered by recent update time with stable timestamp tie-breaking.

**REQ-15 — Preserve symbol indexing, inspection, and linking.** The TypeScript Compiler API indexer shall continue to index supported TypeScript/JavaScript source files, including file and symbol entities and `imports`, `calls`, `extends`, `implements`, and `references` dependencies. Observation-symbol linking and symbol inspection shall remain available.

**AC-15**
- Indexing continues to create/update indexed entities and dependency edges and to prune obsolete indexed entities according to existing behavior.
- Existing symbol normalization and observation linking behavior remains functional.
- Symbol inspection continues to return the entity, incoming/outgoing dependencies, and linked observations, with the additive neighbors field required by REQ-13.
- Unsupported, out-of-boundary, or oversized input files continue to be handled according to existing indexer validation.

**REQ-16 — Preserve JSONL synchronization and statistics.** Existing JSONL export/import and project-scoped or global statistics shall remain supported. Existing JSONL files shall remain importable after the schema migration.

**AC-16**
- Export and import retain existing path, atomic-write, permissions, malformed-line handling, and duplicate-skipping behavior.
- Records imported without the new status fields receive the schema default `active`.
- Existing statistics retain their `projects`, `observations`, `entities`, and `links` shape and meaning.

### Existing MCP, CLI, and contract-verification capabilities

**REQ-17 — Preserve the MCP server contract.** Keep the existing `muninn_save`, `muninn_search`, `muninn_context`, `muninn_link_symbol`, `muninn_stats`, `muninn_inspect_symbol`, and `muninn_verify_contract` tools and their established required arguments. Retain Zod validation, snake_case aliases where supported, safe argument normalization, structured errors, and bounded stdio transport behavior.

**AC-17**
- All existing tools remain registered and callable.
- Existing calls remain compatible unless using an invalid input.
- Invalid arguments and handler errors return tool errors without crashing the server.
- MCP protocol traffic remains on stdout; diagnostics do not corrupt it.

**REQ-18 — Preserve the CLI and TypeScript contract verifier.** Keep `muninn memory init`, `search`, `sync`, and `index`; `muninn check`; and `muninn mcp run`. Contract verification shall continue to use the TypeScript Compiler API without emitting build artifacts and shall report structured diagnostics for requested project files.

**AC-18**
- Existing commands retain their established options and behavior.
- `muninn memory brief` is additive and appears in CLI usage.
- `muninn check` reports contract diagnostics and sets a failing exit code when errors are found.
- MCP stdio startup remains silent on stdout and shuts down cleanly when its parent disconnects.

## Non-functional requirements

### Performance and boundedness

- Brief rendering shall remain within its requested character budget regardless of observation or graph size.
- Neighbor traversal shall be bounded by depth 2 and at most 50 unique neighbors.
- Existing search, context, and symbol entity hydration shall retain bounded result and SQLite parameter behavior.
- Bootstrap shall perform reads only and shall not scan the repository to discover symbols.

### Security

- No new dependencies, network calls, embeddings, or external services.
- Preserve path containment and symlink protection for protected writes and exports.
- Validate MCP inputs with Zod and retain argument-normalization protections against prototype pollution.
- Bootstrap paths must not permit reading symbols outside the selected project.
- Git remote credentials shall not be persisted.

### Reliability and determinism

- Database migration shall be idempotent and preserve existing rows, indexes, and triggers.
- Supersession updates and observation creation shall be atomic.
- Bootstrap shall fail open with a note when storage is missing or unusable; write failures shall remain visible.
- The same stored state and options shall produce the same brief text and neighbor ordering.
- No empty or unavailable data shall be represented as fabricated content.

### Compatibility and implementation

- Existing MCP tool names and required inputs shall remain compatible; additions to existing tools are optional parameters, except the explicitly additive neighbors result.
- Maintain TypeScript strictness, ESM, `.js` extensions for relative imports, and no `any`.
- Make no database schema changes beyond `status` and `superseded_by`; create no tables.
- Keep the duplicated schema definitions synchronized.
- Update `README.md`, `DESIGN.md`, and `CHANGELOG.md` under `Unreleased` in the same commit as each implementation increment.

## Out of scope

- Any change to Huginn or integration that calls bootstrap or automatically writes observations at session end.
- Conversation or transcript ingestion, hooks, or session parsing.
- Model-generated summaries or other generated memory content.
- Embeddings, vector databases, network services, or new runtime dependencies.
- New database tables or schema changes beyond the two observation columns.
- A new graph MCP tool or relationships inferred without stored dependency edges.

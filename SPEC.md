# Spec: Muninn Portable Project Memory and Agent Setup

Muninn is a standalone, local-first memory engine for coding agents and developers. It stores project observations in SQLite, supports lexical search and code-symbol indexing, and exposes memory operations through a library, CLI, and MCP server. It also provides read-only session bootstrap and bounded dependency-neighbor recovery. This specification adds autonomous setup for configuring Muninn in supported agents, including a portable MCP configuration and optional agent rules, without requiring Huginn.

## Goals

- Preserve the existing memory, indexing, synchronization, contract-verification, CLI, and MCP functionality.
- Keep decision supersession explicit, auditable, and opt-in.
- Provide bounded, read-only session bootstrap and dependency-neighbor recovery.
- Allow developers to diagnose and install Muninn in supported agents using `muninn setup`.
- Keep setup local, safe for existing configuration files, idempotent, and independent of Huginn.

## Non-goals

- Changing Huginn or requiring an orchestrator integration.
- Ingesting conversations, transcripts, or agent sessions.
- Generating summaries or other memory content with a model.
- Adding embeddings, vector search, network services, telemetry, or runtime dependencies.
- Inferring decisions, symbols, dependencies, or other facts not stored in Muninn.
- Checking whether an agent has started or connected to the configured MCP server.
- Adding database tables or schema changes beyond the existing observation lifecycle fields.
- Cleaning up, renaming, or deleting unrelated agent configuration entries or files.

## Users and personas

- **Coding agent:** Searches project memory, inspects symbols, and saves observations through MCP or the library.
- **Developer:** Initializes, searches, indexes, synchronizes, bootstraps, verifies, and sets up project memory using the CLI.
- **Client integrator:** Embeds the standalone library or connects an MCP-capable runtime without depending on Huginn.

## Functional requirements

### Memory storage and lifecycle

**REQ-1 — Store project-scoped observations.** Muninn shall store observations in SQLite scoped to a project. Each observation retains its category, title, content, optional topic key, lifecycle status, replacement link, timestamps, and linked entities. Categories are `decision`, `convention`, `discovery`, `bugfix`, and `architecture`. Project identity includes its name, root path, and optional sanitized Git remote.

**AC-1**
- Saving an observation persists it for the selected project and returns it with linked entities.
- The service rejects invalid categories, empty titles, and missing or non-string content.
- Existing projects and observations remain usable.

**REQ-2 — Initialize and safely migrate the database.** The database schema shall be defined both in `src/db/schema.sql` and the `SCHEMA_SQL` fallback in `src/db/client.ts`. New databases shall define `observations.status` as non-null with default `active`, and nullable `observations.superseded_by`. Opening a database shall idempotently add either missing column after checking `PRAGMA table_info(observations)`, without recreating tables or removing data, indexes, or triggers.

**AC-2**
- A pre-update database opens with every existing row intact; migrated rows have `status = 'active'` and `superseded_by = NULL`.
- Reopening a migrated database does not add existing columns again or alter data.
- A database missing either or both columns receives only the missing columns.
- The on-disk and embedded schema definitions agree on observation columns.
- Existing FTS5 triggers continue to maintain the index on inserts, searches, and updates after migration.

**REQ-3 — Resolve project and database paths safely.** Unless a database path is supplied, Muninn shall use `<git-root>/.huginn/muninn.db` in a Git repository and `~/.huginn/muninn.db` otherwise. The project root and database resolution shall use the same selected root. Existing path-safety checks shall protect database and JSONL paths.

**AC-3**
- An explicit `--project` root selects both the project record and default database location.
- `:memory:` remains available for isolated use and tests.
- Protected paths reject a symlink on the final path component.
- Project-relative protected paths that resolve outside the project root are rejected.
- Storage and retrieval require no network access.

**REQ-4 — Supersede decisions explicitly.** `saveObservation` shall accept optional `supersedesTopicKey` and `supersedes_topic_key`. When the new observation is a decision, it shall atomically mark active decisions in the same project whose `topic_key` matches as `superseded`, setting their `superseded_by` to the new observation ID. Other categories shall not be superseded by this operation. A key matching no active decisions is not an error.

**AC-4**
- Only active decisions in the current project with the matching topic key are superseded.
- Saving the new decision and updating the replaced decisions succeed or roll back together.
- Replaced decisions have `status = 'superseded'` and `superseded_by` set to the new decision ID.
- Other projects, other categories, other topic keys, and already-superseded decisions remain unchanged.
- A nonmatching key still saves the new decision; omitting the key supersedes nothing.
- A decision never supersedes itself.

**REQ-5 — Filter superseded observations in retrieval.** `search` and `getContext` shall accept optional `includeSuperseded` and `include_superseded`, defaulting to `false`. By default, their queries exclude superseded observations. When included, results expose `status` and `superseded_by`.

**AC-5**
- Default search and context exclude superseded observations at query time.
- `includeSuperseded: true` includes matching active and superseded observations with lifecycle fields.
- Existing query, category, project, topic, all-project, ranking, and limit behavior remains available.
- Symbol inspection may return superseded observations linked to a symbol; `getStats` retains its existing output shape.

### Search, indexing, synchronization, and statistics

**REQ-6 — Preserve FTS5 search and recent context.** Search shall use SQLite FTS5 with safely sanitized queries and BM25 ranking. Context shall return recent observations. Both shall preserve project, category, topic, and all-project filtering and bounded result limits.

**AC-6**
- Search uses FTS5 BM25 ranking, with lower rank values ordered first.
- Empty or unusable sanitized queries return no results without causing an FTS syntax failure.
- Existing filters and bounded limits work with the superseded-observation filter.
- Context is ordered by `updated_at DESC, created_at DESC`.

**REQ-7 — Preserve symbol indexing, inspection, and linking.** The TypeScript Compiler API indexer shall index supported TypeScript and JavaScript files, including file and symbol entities and stored `imports`, `extends`, `implements`, and `references` dependencies. The schema may permit `calls`, but the current indexer does not extract call edges. Observation-symbol linking and symbol inspection shall remain available.

**AC-7**
- Indexing creates and updates entities and dependency edges and prunes obsolete indexed entities according to existing behavior.
- Symbol normalization and observation linking remain functional.
- Symbol inspection returns the entity, incoming and outgoing dependencies, and linked observations.
- Unsupported, out-of-boundary, oversized (over 2 MB), or unreadable input files are skipped according to indexer validation.
- No call edges are inferred or advertised as extracted by the current indexer.

**REQ-8 — Preserve JSONL synchronization and statistics.** Muninn shall continue to support JSONL export/import and project-scoped or global statistics. Existing JSONL files remain importable.

**AC-8**
- Export/import preserve existing path-safety, atomic-write, permissions, malformed-line handling, and duplicate-skipping behavior.
- Exported observations include `status` and `superseded_by`; imports without those fields default to active and null replacement link.
- Import is idempotent by observation ID.
- Statistics preserve their `projects`, `observations`, `entities`, and `links` shape and meaning; observation counts include superseded observations.

### Session bootstrap and graph recovery

**REQ-9 — Provide a bounded session brief.** Muninn shall expose `MemoryService.getSessionBrief({ paths?, budgetChars? })` and a standalone read-only `readSessionBrief`. The brief contains available project identity, active decisions, recent activity, path-selected indexed symbols, counts, and explanatory notes. It omits empty sections rather than fabricating data.

**AC-9**
- Active decisions are grouped by stored topic key; unkeyed decisions are listed separately.
- Multiple active decisions with the same topic key are not collapsed.
- Recent activity excludes active decisions already listed, labels superseded observations, and counts all observations, including superseded ones.
- Missing, inaccessible, corrupt, or uninitialized databases yield an empty brief with a cause in `notes` and unavailable (`null`) counts, without throwing or creating database state.

**REQ-10 — Select indexed symbols by bounded project paths.** A brief shall accept at most 20 file or directory paths, resolve them relative to the project root, normalize separators, reject paths outside the project, and match only existing indexed `entities.file_path` values without scanning the repository.

**AC-10**
- Inputs beyond the 20-path maximum are rejected or bounded according to the service contract.
- Paths outside the project root are not used to select symbols.
- Symbol selection uses indexed file paths only and does not scan the repository.

**REQ-11 — Render deterministic Markdown within a character budget.** The shared brief renderer shall produce deterministic Markdown and enforce a positive integer `budgetChars`, default 8,000 and maximum 20,000, over the complete output, including headings, notes, and a visible truncation marker.

**AC-11**
- Identical brief data and options produce identical Markdown.
- Invalid, non-positive, or non-integer budgets are rejected.
- Rendered output does not exceed the selected character budget.

**REQ-12 — Provide MCP and CLI bootstrap surfaces.** `muninn_bootstrap` and `muninn memory brief [--project <path>] [--paths a,b] [--budget <n>]` shall return the shared renderer output. The default MCP server shall not initialize a writable database merely to serve bootstrap.

**AC-12**
- MCP input validation supports documented camelCase and snake_case aliases.
- CLI and MCP bootstrap use the same brief behavior and renderer.
- Missing or unusable database state during bootstrap does not create files or database rows.

**REQ-13 — Traverse stored dependency neighbors.** `MemoryService.neighbors(identifier, { depth?, limit? })` shall traverse stored `entity_dependencies` edges in both directions, grouped by relation and direction, with deterministic ordering, cycle protection, and no duplicate entities. Depth defaults to 1 and is clamped to at most 2; limit defaults to 20 and is clamped to at most 50. Unknown identifiers return no traversal.

**AC-13**
- Traversal follows only stored dependency edges, not inferred name or path relationships.
- Traversal is deterministic, cycle-safe, deduplicated, and respects depth and result bounds.
- Unknown identifiers return no neighbors.

**REQ-14 — Use graph recovery in briefs and inspection.** Session briefs shall support `expandGraph` (default `true`) and include deduplicated related symbols for path-selected entities within the Markdown budget. Symbol inspection shall include a bounded depth-1 neighbor traversal using the same implementation, while retaining its existing inspection fields.

**AC-14**
- A path-selected entity is not repeated in the related-symbol section.
- Disabling graph expansion adds no related section.
- If expansion finds no stored dependencies, the related section is omitted and a note explains why.
- If all neighbors are already path-selected, the related section is omitted silently.
- `muninn_inspect_symbol` includes bounded neighbors without adding a new MCP tool.

### MCP, CLI, and contract verification

**REQ-15 — Preserve the MCP server contract.** Keep the tools `muninn_save`, `muninn_search`, `muninn_context`, `muninn_link_symbol`, `muninn_stats`, `muninn_inspect_symbol`, `muninn_verify_contract`, and `muninn_bootstrap`. Existing tool names and required arguments remain compatible. Retain Zod validation, supported snake_case aliases, safe argument normalization, structured errors, and bounded stdio transport behavior.

**AC-15**
- All eight tools remain callable and the seven pre-existing tool contracts remain compatible.
- Invalid arguments and handler errors produce structured tool errors without crashing the server.
- MCP protocol traffic remains on stdout; diagnostics do not corrupt it.
- A closed parent pipe or stdin EOF shuts the server down cleanly.
- MCP stdio writes have a 5-second deadline and fail the pending request rather than hanging.

**REQ-16 — Preserve the CLI and contract verifier.** Keep `muninn memory init`, `memory search`, `memory sync`, `memory index`, `memory brief`, `muninn check`, and `muninn mcp run`. Contract verification shall use the TypeScript Compiler API without emitting build artifacts and report structured diagnostics for requested project files.

**AC-16**
- Existing commands retain their established options and behavior.
- `muninn check` reports contract diagnostics and sets a failing exit code when errors are found.
- Contract verification rejects target files outside the project root and missing files.
- MCP stdio startup remains silent on stdout and shuts down cleanly when its parent disconnects.

### Agent setup catalog and command

**REQ-17 — Provide a catalog of supported agent destinations.** Muninn shall define the setup catalog under `src/setup/` and integrate it with `src/commands/` and `src/cli.ts`. The catalog shall contain the 13 destinations `cursor`, `claude`, `opencode`, `devin`, `qwen`, `codex`, `agy`, `kimi`, `pi`, `commandcode`, `omp`, `mcode`, and `mimo`. Each destination shall define an ID, label, format, MCP paths, and rules file, matching the routes and formats of the Huginn integrator reference.

**AC-17**
- Catalog IDs are unique and exactly cover the 13 listed destinations.
- Catalog routes and formats match the reference definitions; any correction is covered by a test that fixes the intended route.
- MCP paths support `{project}`, `{home}`, and `{opencodeConfigDir}` markers.
- `resolveMcpPaths(target, { projectPath, homeDir, opencodeConfigDir, env })` expands markers using platform path APIs.
- Overrides named `MUNINN_AGENT_<ID>_MCP_PATH`, separated by `:`, are supported and documented as equivalent to `HUGINN_AGENT_<ID>_MCP_PATH`.

**REQ-18 — Support setup selection, listing, and portable installation.** `muninn setup` shall accept `--agent <id|all|id,id>`, `--project <path>`, `--home <path>`, `--force`, `--dry-run`, `--status`, `--portable`, `--no-portable`, and `--no-rules`. Agent selection accepts one ID, `all`, or a comma-separated list of IDs. `muninn setup --list` shall display the catalog without writing.

**AC-18**
- An unknown agent ID is reported with the valid IDs and returns exit code 1.
- With no `--agent`, setup processes only the portable configuration and does not modify any rules file.
- `--portable` is accepted and is equivalent to omitting `--agent`.
- With `--agent`, setup processes the selected destinations and the portable configuration unless `--no-portable` is supplied.
- `--no-portable` without `--agent` is invalid, reports that there is nothing to do, shows usage, and returns exit code 1.
- `--list` prints IDs, labels, formats, resolved or templated paths, and rules files without modifying files or creating directories.

**REQ-19 — Install MCP configurations safely and compatibly.** Setup shall install an MCP entry named `muninn` that invokes the Muninn binary:
- `mcpServers` format: `{"command":"muninn","args":["mcp","run",...]}`.
- OpenCode format: `{"type":"local","command":["muninn","mcp","run",...],"enabled":true}` inside `mcp`.
- Codex format: `[mcp_servers.muninn]` in TOML with `command` and `args`.
- Portable format: `{home}/.muninn/mcp.json`, using the standard `mcpServers` container.

Setup shall include `--project <absolute path>` only for configuration files contained within the selected project. Shared user-level configuration files shall omit `--project`.

**AC-19**
- Generated commands invoke `muninn mcp run`, not `huginn mcp run`.
- Project-level configuration entries include the selected absolute project path only when the config file is within that project.
- User-level and portable configuration entries do not pin a project path.
- Existing unrelated configuration keys, servers, tables, and content are preserved; updates are limited to the Muninn entry and required container.
- Existing correct entries are not duplicated or rewritten; repeated setup is byte-for-byte idempotent and reports `changed: false`.
- Without `--force`, a different existing `muninn` entry is left intact and reported as `skipped`; with `--force`, it is replaced.
- The legacy `{home}/.huginn/mcp.json` file is never modified and is reported by `--status` when present.

**REQ-20 — Parse and write configuration files safely.** JSON and TOML setup files shall be parsed and merged structurally. Writes shall be atomic and preserve appropriate permissions.

**AC-20**
- TOML Codex configuration is merged structurally; existing tables such as `[mcp_servers.otro]` remain alongside `[mcp_servers.muninn]`.
- Malformed JSON or TOML produces an error naming the path and cause; the original remains unchanged.
- Existing destination permissions are preserved; newly created files use mode `0o600`.
- Parent directories are created with mode `0o700` only when a write is required.
- The writer creates a random-suffixed temporary file using exclusive `wx` mode and renames it to the destination.
- A final-component symlink is rejected rather than followed.
- The merge preserves unrelated data and formatting where feasible; a no-op update preserves the original bytes exactly.

### Agent rules

**REQ-21 — Install marked usage rules for selected agents.** When one or more agents are selected, setup shall install a Muninn rules block by default unless `--no-rules` is supplied. The block shall be delimited by `<!-- muninn:rules:start -->` and `<!-- muninn:rules:end -->`. The rules shall recommend calling `muninn_bootstrap` once at session start, using `muninn_search` and `muninn_inspect_symbol` before designing a change, and using `muninn_verify_contract` before completing code. They shall not mention Huginn.

**AC-21**
- Installing the same rules twice is idempotent; the second run reports `changed: false`.
- If a rules file exists, the block is appended or the existing Muninn block is replaced without reordering or modifying the rest of the content.
- A rules file is created only when it does not exist and a write is required.
- Multiple selected agents that share a rules file do not cause duplicate Muninn blocks.
- Without `--agent`, the portable setup does not read or write a rules file.
- `--no-rules` suppresses rule installation.

**REQ-22 — Detect legacy rules and protect rules paths.** A prior block beginning `<!-- huginn:muninn-rules:start -->` shall be diagnosed as `stale`. Without `--force`, setup shall leave it untouched; with `--force`, setup shall replace it with the Muninn block and close the old block. Rules paths shall use the same path-safety checks as MCP configuration paths.

**AC-22**
- A stale block is reported and remains byte-identical without `--force`.
- With `--force`, the stale block is replaced, while unrelated rules-file content is preserved.
- A rules-file path that fails `assertDocPath` is not read or written.
- Reports identify the rules file associated with each result.
- `--no-portable --no-rules` without `--agent` is rejected with exit code 1.

### Setup diagnostics, reports, and failures

**REQ-23 — Provide read-only status and dry-run modes.** `--status` shall report configuration and rules states without modifying files, creating directories, or creating temporary files. `--dry-run` shall calculate the same intended actions and report them without writing. With `--agent`, `--status` examines only the selected agents; without `--agent`, it examines all agents. The portable is included by default and excluded with `--no-portable`.

**AC-23**
- MCP diagnostic states include `absent`, `registered`, `legacy`, `conflict`, and `malformed`.
- Rules diagnostic states include `absent`, `present`, and `stale`.
- Status output includes the relevant file path and per-destination MCP and rules results.
- `--dry-run` and `--status` do not change file content or modification times and do not create files, directories, or temporary files.
- The portable appears as a report row when applicable.
- If `{home}/.huginn/mcp.json` exists, status mentions it as legacy without modifying it.

**REQ-24 — Report outcomes per destination and handle errors deterministically.** Setup shall report MCP results per destination as `written`, `present`, `skipped`, or `failed`, and rules results as `written`, `present`, `stale`, `skipped`, or `failed`. Missing agent binaries shall be warnings, not setup failures. Normal and dry-run executions stop at the first fatal error and retain earlier changes. Status continues inspecting all applicable destinations and reports all errors.

**AC-24**
- Each destination report distinguishes MCP and rules outcomes and identifies the relevant file, making partial completion visible.
- If an agent binary is not found in `PATH`, setup still writes or diagnoses its configuration and reports `not installed`.
- Missing binaries do not change the exit code.
- Normal setup and `--dry-run` stop at the first malformed file or protected-path error; changes already made are retained.
- `--status` continues after malformed files or protected-path errors, reports all applicable results and errors, and returns exit code 1 if any such error occurs.
- A `skipped` result caused by lack of `--force` is nonfatal.

**REQ-25 — Define setup exit codes.** For `muninn setup`, exit codes shall be limited to the following cases.

**AC-25**
- Exit code `0` means all applicable entries were written, already present, or skipped for lack of `--force`; it also applies when an agent binary is missing but a `not installed` warning is reported.
- Exit code `1` means a fatal malformed-file or protected-path error in normal setup, `--dry-run`, or `--status`; an unknown agent ID; or invalid usage, including `--no-portable` without `--agent`.
- No additional setup exit codes are introduced for the cases in this specification.

## Domain model

| Entity | Meaning | Key fields |
|---|---|---|
| Project | A repository or directory whose memory is isolated | `id`, `name`, `root_path`, sanitized `git_remote` |
| Observation | A durable project lesson or decision | `id`, `project_id`, `category`, `title`, `content`, `topic_key`, `status`, `superseded_by`, timestamps |
| Entity | An indexed code symbol or file | `id`, `project_id`, `entity_type`, `identifier`, `file_path` |
| ObservationEntity | Link between an observation and an entity | `observation_id`, `entity_id` |
| EntityDependency | Directed relationship between code entities | `source_entity_id`, `target_entity_id`, `relation_type` |
| AgentTarget | A supported agent integration destination | `id`, `label`, format, MCP paths, `rulesFile` |

Observation lifecycle is `active` → `superseded`. A superseded observation retains its content and points to the newer observation that replaced it. It is excluded from default search/context, but remains counted, exported, inspectable, and available when explicitly requested.

## Non-functional requirements

### Performance and boundedness

- Search and context limits are clamped to `1..500` (defaults: 10 for search and 20 for context).
- Observation entity hydration is chunked at 500 observation IDs per SQLite query.
- Indexing parses files outside the database transaction, skips files over 2 MB, and writes entities and dependencies in a short-lived transaction.
- Contract verification uses targeted `rootNames` and pre-emit diagnostics rather than emitting files.
- Graph traversal defaults to depth 1 and limit 20, with hard maxima of depth 2 and limit 50.
- Brief path selection accepts at most 20 paths, and rendered output is bounded by the configured character budget.
- MCP stdio writes have a 5-second deadline and fail pending requests rather than hanging.

### Security

- No network calls, embeddings, external services, or telemetry are required.
- Database and JSONL paths retain containment and symlink protections.
- Every setup configuration and rules path that is read or written is validated with `assertDocPath` or `checkDocPath`; do not bypass symlink or containment checks.
- Setup resolves paths with platform path APIs and uses `path.relative` for containment checks; it does not rely on string concatenation or hard-coded path separators.
- Setup does not overwrite a different Muninn entry or stale rules block without `--force`.
- Setup uses exclusive temporary-file creation, atomic rename, and restrictive permissions.
- MCP inputs are validated with Zod and argument normalization protects against prototype-pollution keys.
- Terminal text written to stderr is sanitized so control characters and bidi overrides cannot corrupt logs.
- Git remote credentials are not persisted.

### Reliability and determinism

- Database migration is idempotent and preserves existing rows, indexes, and triggers.
- Decision supersession and observation creation are atomic.
- JSONL export uses a temporary file with `0o600` permissions and atomic rename.
- JSONL import is idempotent by observation ID.
- Search, context, and indexing failures for individual files or queries do not abort unrelated work; fatal SQLite I/O and corruption errors in search are re-thrown.
- Brief and setup outputs are deterministic for the same inputs and filesystem state.
- Setup writes are atomic per file. A fatal error stops normal setup and dry-run at the first failure but does not roll back earlier successful file writes.
- Status is diagnostic and read-only, continues across applicable targets, and aggregates errors before returning its exit code.
- Repeated setup over already-correct files is byte-for-byte idempotent.

### Compatibility and implementation

- Existing MCP tool names and required inputs remain compatible; existing tool additions are optional.
- Maintain TypeScript strict mode, ESM, and `.js` extensions for relative imports.
- Do not add runtime dependencies.
- Do not add database tables or schema changes beyond `observations.status` and `observations.superseded_by`.
- Keep the duplicated database schema definitions synchronized.
- Update `README.md`, `DESIGN.md`, `ADR.md`, and `CHANGELOG.md` with the setup feature.
- Record in an ADR that Muninn owns its setup catalog and that Huginn may consume it. The ADR shall explain the distinction between machine-oriented MCP configuration and human-authored rules prose: MCP entries are merged structurally, while rules are managed as marked, appended blocks with legacy-block detection, despite being installed by default for selected agents.

## Out of scope

- Changing Huginn, delegating from `huginn setup`, or removing Huginn’s existing integrator.
- Renaming the MCP entry `muninn`.
- Deleting or cleaning up unrelated servers, configuration keys, rules, or files.
- Rewriting unrelated configuration content or replacing unmarked human-authored rules.
- Probing whether an agent connects or starts the MCP server.
- Conversation/transcript ingestion, hooks, or session parsing.
- Model-generated summaries or memory content.
- Embeddings, vector databases, network services, or new runtime dependencies.
- New database tables or observation schema changes beyond the two lifecycle columns.
- A new graph MCP tool or relationships inferred without stored dependency edges.
- Package publication or version changes as part of setup, aside from the required changelog entry.

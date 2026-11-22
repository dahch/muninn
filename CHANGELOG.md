# Changelog

## 0.3.0

### Added

- **Portable project identity.** `.muninn/project.json` carries a stable uid; resolution falls back
  to the Git remote and then the resolved path. `muninn project resolve|list|register|rename|forget`
  manage it. Linked worktrees unify on the Git common root, and a `--project` subdirectory is
  normalised to the real project root.
- **Portable storage.** Memory now lives in `$MUNINN_HOME/projects/<uid>/memory.db` (default
  `~/.muninn`), one file per project for Git and non-Git projects alike, plus a per-project
  `memories.jsonl` snapshot. `MUNINN_LEGACY_STORAGE=1` restores the old layout.
- **Non-destructive migration.** `muninn migrate [--from <db>] [--scan <dir>] [--dry-run]` moves
  legacy `.huginn` databases into portable storage, remapping entities and links, idempotently and
  without modifying the legacy files.
- **Session handoffs.** A structured "where we left off" record (goal, state, files touched, next
  steps, open questions, blockers, linked decisions), one active per project, superseding the
  previous one. `muninn_handoff`, `muninn memory handoff` and `muninn end-session` write it, and
  it renders first in every session brief.
- **Deterministic seeding.** `muninn seed` extracts the README overview, build/test commands, a
  language and directory map, agent conventions and every ADR into observations with stable ids, so
  re-running refreshes them instead of duplicating them.
- **Code graph.** New schema (`code_files`, `code_symbols`, `code_edges`, `code_index_state`, FTS
  indexes) with line spans, signatures, docs, visibility, kinds and edge confidence. Incremental,
  content-addressed indexing over Git's file list (or a `.gitignore`-aware walker), with deleted
  files and dangling edges pruned.
- **Multi-language extraction.** TypeScript/JavaScript use the Compiler API; every other supported
  language gets a deterministic heuristic scan (imports, symbols, call sites).
- **Graph tools.** `muninn_explore` (bounded source + callers + callees + related decisions),
  `muninn_graph` (node, callers, callees, impact, implementations, imports, cycles, tests, files),
  `muninn_code_search`, `muninn index` and `muninn graph` in the CLI.
- **Activation.** The MCP `initialize` response now carries project-aware instructions, and
  `muninn_project` can switch the active project when the working directory is not the project.
- **`muninn doctor`.** Read-only diagnosis of the resolved project, memory, graph and every known
  agent configuration, flagging missing, legacy (`huginn`), pinned and malformed entries.
- Observation provenance: `agent`, `session_id`, `scope`, `tags` and `files`.

- **Global memory.** scope "global" observations live in a cross-project store, appear in every
  project brief under "Global preferences", and can be queried with includeGlobal.
- **Repository snapshots.** muninn snapshot / muninn restore move memory between machines through a
  deterministic .muninn/memory.jsonl, merging by observation id. Provenance travels too.
- **Agent hooks.** muninn hook session-start prints the brief and muninn hook session-end writes the
  handoff from git state, for agents that hook commands instead of MCP instructions.
- **Watch mode.** muninn index --watch re-indexes changed files after a debounced quiet window.
- **Better heuristic resolution.** Python relative/absolute imports resolve to files, calls are
  attributed to their enclosing symbol, and module entry files (__init__, index, mod, main) are
  tried per ecosystem.

- **Claude Code hooks installer.** muninn hooks install merges session-start and session-end
  commands into ~/.claude/settings.json, preserving unrelated settings and hook entries, idempotently
  and with dry-run/status/uninstall. muninn doctor reports the hook state too.

- **Optional tree-sitter Tier B.** When `web-tree-sitter` and `@vscode/tree-sitter-wasm` are
  installed (optional dependencies), Python, Go, Rust, Java, C/C++, C#, Ruby, PHP and Bash are parsed
  from a real AST with line spans and member qualification, resolving calls within a file and imports
  to files. Without the pack, or with `MUNINN_TREESITTER=0` / `--no-treesitter`, the heuristic engine
  runs exactly as before. The indexer is now asynchronous and reports how many files used Tier B.
- **DSH Desktop catalog entry.** The setup catalog now lists dsh as a manual destination: setup
  prints the dsh-mcp plugin steps instead of writing a config that DSH does not have, and doctor
  detects whether the plugin is installed and recommends it.

- **DSH session-aware project resolution.** With MUNINN_SESSION_AUTODETECT=dsh (set in the DSH
  MCP declaration's env), the server follows the newest DSH session working directory and binds to
  it when it is a project. When the session folder is a workspace with several repositories,
  muninn_bootstrap lists the candidates and muninn_project use switches without editing config.

### Fixed

- `muninn_bootstrap` now follows the project pinned with `muninn_project { action: "use" }`. In a DSH
  workspace it previously fell back to the server process's cwd (the DSH profile directory), so a
  session that followed the guidance and pinned a project received an empty brief for the wrong
  root.

- **Tolerant MCP argument types.** Numeric and boolean tool arguments serialized as strings (for
  example budgetChars="12000" or limit="5", a pattern produced by some agent clients) are coerced
  before Zod validation instead of failing the call.
- **DSH doctor detection.** muninn doctor recognises native @deepseek-ai/dsh-mcp-client declarations
  in cordis.patch.yml (in addition to the dsh-mcp plugin) and reports the declared server names.

### Changed

- `muninn memory init` writes the committed project marker (disable with `--no-marker`).
- The default JSONL snapshot moved from `<project>/.huginn/memories.jsonl` to the portable store.
- The injected rules block now asks for a handoff before finishing and for the graph tools instead
  of re-reading the repository.
- `schema.sql` is at version 4 and migrations are tracked with `PRAGMA user_version`.


## 0.2.1

### Changed

- The injected rules now ask for a **write**, not only for reads. They told an agent to bootstrap,
  search, inspect and verify — every one of those reads — so a session that settled a convention or a
  tradeoff left nothing behind, and memory only grew through Huginn's cycle. `muninn_save` is now part
  of the block, with the `topicKey` advice that makes a later decision supersede the earlier one
  instead of contradicting it. The new rule ships in `MUNINN_RULES_BLOCK`, so every rules destination
  written by `muninn setup` carries it, and the setup tests assert both `muninn_save` and `topicKey`
  are present.

## 0.2.0

### Added

- Decision supersession: `saveObservation` accepts `supersedesTopicKey`, atomically marking the
  same project's active decisions with the matching topic key as `superseded` and recording the
  replacement ID. New databases include `observations.status` and `observations.superseded_by`,
  and existing databases are migrated idempotently on open.
- Lifecycle-aware retrieval: `search` and `getContext` accept `includeSuperseded` (default
  `false`) and expose `status` / `superseded_by` in their results.
- MCP compatibility: `muninn_save` accepts `supersedesTopicKey` / `supersedes_topic_key`, and
  `muninn_search` / `muninn_context` accept `includeSuperseded` / `include_superseded`.
- Read-only session bootstrap: `MemoryService.getSessionBrief` and the standalone
  `readSessionBrief` render a deterministic, budgeted Markdown brief with project identity, active
  decisions grouped by topic key, unkeyed decisions, recent activity with superseded labels,
  path-selected indexed symbols, counts, and explanatory notes. It opens only existing databases
  read-only (with the same symlink/containment screen as the write path) and fails open with
  unavailable counts when memory is missing, inaccessible, corrupt, or uninitialized.
- MCP `muninn_bootstrap` and CLI `muninn memory brief [--paths a,b] [--budget <n>]`, both returning
  the same renderer output. Bootstrap accepts up to 20 in-project paths and budgets from 1 to 20,000
  characters (default 8,000); default MCP servers defer writable database initialization until a
  non-bootstrap tool is used.
- Graph-aware recovery: `MemoryService.neighbors(identifier, { depth?, limit? })` traverses stored
  `entity_dependencies` edges in both directions, grouped by relation and direction with
  deterministic ordering, cycle protection, and entity deduplication. Depth defaults to 1 and is
  clamped to 2; the neighbor limit defaults to 20 and is clamped to 50.
- Session briefs expand deduplicated related symbols by default within the existing Markdown budget
  (`expandGraph` / `expand_graph` can disable it), and `muninn_inspect_symbol` now adds a bounded
  depth-1 neighbor traversal while retaining its existing inspection data. No new MCP tool, schema
  element, inferred relationship, or dependency was added.
- Portable agent setup: `muninn setup` installs or merges a `muninn mcp run` entry under
  `mcpServers.muninn` in `{home}/.muninn/mcp.json`, with `--home`, `--force`, `--dry-run`, `--status`,
  and `--portable`. It preserves unrelated JSON, never modifies `{home}/.huginn/mcp.json`, is
  byte-for-byte idempotent for a correct entry, and reports `absent` / `registered` / `legacy` /
  `conflict` / `malformed` states. Writes use exclusive temporary files, atomic rename, mode `0o600`
  for new files, `0o700` for new directories, and refuse final-component symlinks.
- Agent catalog and JSON setup: `muninn setup --list` prints the 13 reference destinations with their
  formats, MCP paths, and rules paths without touching the filesystem. `--agent <id|all|id,id>` selects
  destinations (unknown IDs report the valid list and exit 1), `--project` supplies the project root,
  and the portable destination is included by default unless `--no-portable` suppresses it. Standard
  `mcpServers` and OpenCode `mcp` targets are merged structurally, preserve unrelated configuration,
  pin `--project` only when the config file is inside the selected project, and report per-file
  `absent` / `registered` / `legacy` / `conflict` / `malformed` states plus `written` / `present` /
  `skipped` / `failed` outcomes. Path resolution expands `{project}`, `{home}`, and
  `{opencodeConfigDir}` and honors `MUNINN_AGENT_<ID>_MCP_PATH` (with the equivalent
  `HUGINN_AGENT_<ID>_MCP_PATH` fallback).
- Codex TOML setup: `muninn setup --agent codex` creates or structurally merges
  `[mcp_servers.muninn]` in `{home}/.codex/config.toml`, preserving unrelated tables, keys, comments,
  and formatting where feasible. The writer uses the same path safety, conflict rules, `--project`
  containment, permissions (`0o600`/`0o700`), exclusive temporary files, atomic rename, symlink refusal,
  and byte-for-byte idempotency as JSON destinations. Malformed TOML is reported with its path and
  cause, leaves the original untouched, and `--status` continues aggregating all applicable destination
  errors before exiting 1. Duplicate table definitions, including repeated `[mcp_servers.muninn]`
  headers and dotted `mcp_servers.muninn` keys combined with an explicit header, are rejected as
  malformed without modifying the file. Forced replacement may discard comments and formatting inside
  the replaced Muninn region.
- Marked agent rules: `muninn setup --agent <ids>` installs a
  `<!-- muninn:rules:start -->` / `<!-- muninn:rules:end -->` block recommending `muninn_bootstrap`,
  `muninn_search`, `muninn_inspect_symbol`, and `muninn_verify_contract`. Blocks are appended or replaced
  idempotently, surrounding human-authored content is preserved, missing files are created only for a
  real write, and selected agents that share a rules file receive one deduplicated block. `--no-rules`
  suppresses rules, and setup without `--agent` never reads or writes a rules file. A complete legacy
  `huginn:muninn-rules` block is reported as `stale`, left untouched without `--force`, and replaced
  while preserving surrounding content with `--force`; ambiguous or duplicate markers fail closed.
  Rules paths use the same containment/symlink checks and atomic writes as MCP configuration, and rules
  outcomes are reported separately with the shared file and its agents. Status reports `absent`,
  `present`, or `stale` without writing. A selected agent binary missing from `PATH` now produces a
  nonfatal `not installed` warning without changing the exit code.

## 0.1.0

The first release of Muninn as its own package: the memory engine extracted from
[huginn](https://github.com/dahch/huginn), so the orchestrator consumes it in-process instead of carrying
the source.

```sh
npm install @dahch/muninn     # Node >= 20, MIT
```

### What it does

Local-first memory for coding agents, backed by SQLite + FTS5: project-scoped entities and
observations, BM25 search over them, a symbol and dependency index built from the TypeScript AST, and
an MCP server so any agent can read and write that memory without leaving its own protocol.

### Included

- **Storage** (`src/db/`): one database per project at `<git-root>/.huginn/muninn.db` (or
  `~/.huginn/muninn.db` outside a repository), WAL with `foreign_keys`, `busy_timeout` and
  `recursive_triggers`, the schema shipped as `schema.sql`, and the path screens that stop a symlinked
  `.huginn/` from redirecting writes out of the project.
- **MemoryService** (`src/service/`): entities, observations, categories, relations, symbol
  inspection, and portable JSONL export/import (`memory sync`).
- **MCP server** (`src/mcp/`): stdio JSON-RPC 2.0 behind a bounded transport, a declarative tool
  registry and zod validation on every input.
- **Contract verifier** (`src/contracts/`): TypeScript compiler-API verification with caret snippets
  and a markdown gate report.
- **AST indexer** (`src/indexer/`): symbol taxonomy and dependency extraction over a `ts.Program`,
  batched so a big repository never blocks the caller.

### CLI

```sh
muninn memory init [--db <path>] [--project <path>]
muninn memory search <query> [--category <cat>] [--limit <n>] [--project <path>]
muninn memory sync [--import] [--file <path>] [--project <path>]
muninn memory index [files...] [--project <path>] [--db <path>]
muninn check [files...] [--project <path>]
muninn mcp run [--db <path>] [--project <path>]
```

### Programmatic use

The package exports the service, the database layer, the indexer, the MCP server and the contract
verifier as subpaths, so a consumer can take the pieces it needs:

```ts
import { MemoryService } from "@dahch/muninn";
```

### Notes

- The data location is **shared with huginn** on purpose: both processes read and write the same
  database for a project.
- `better-sqlite3` ships prebuilt binaries for the supported platforms; a source build needs a
  toolchain.
- The design — schema, service core, MCP server, CLI, verifier, indexer — is in `DESIGN.md`.

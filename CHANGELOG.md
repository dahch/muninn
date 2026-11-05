# Changelog

## Unreleased

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
  `HUGINN_AGENT_<ID>_MCP_PATH` fallback). Codex TOML and rules-block installation remain planned for
  later iterations and are reported as deferred rather than silently installed.

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

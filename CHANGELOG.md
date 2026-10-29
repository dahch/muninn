# Changelog

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

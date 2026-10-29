# Changelog

## 0.1.0

The first release of Muninn as its own package: the memory engine, extracted from
[huginn](https://github.com/dahch/huginn) so the orchestrator can consume it in-process instead of carrying
it.

### Included

- **SQLite + FTS5 storage** (`src/db/`): project-scoped database at `<git-root>/.huginn/muninn.db`, BM25
  full-text search over observations, WAL, schema migrations.
- **MemoryService** (`src/service/`): entities, observations, relations, symbol inspection, JSONL
  export/import (`memory sync`).
- **MCP server** (`src/mcp/`): stdio JSON-RPC exposing the memory operations to coding agents.
- **CLI** (`muninn memory init|search|sync|index`, `muninn check`).
- **Contract verifier** (`src/contracts/`): TypeScript compiler-API verification with the markdown gate
  report.
- **AST indexer** (`src/indexer/`): symbol/dependency extraction and batched indexing.

### Notes

- MIT. Node >= 20, Bun optional for development.
- The data location is shared with huginn on purpose: both read and write the same database.

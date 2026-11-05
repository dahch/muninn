# AGENTS.md

## OpenCode agents

This repository does **not** define any OpenCode agents. There is no `.opencode/agents/`
directory and no agent configuration files.

| Agent | Mode | Purpose | Permissions | When to invoke |
|---|---|---|---|---|
| — | — | No agents are defined in this repository. | — | — |

If an agent is added under `.opencode/agents/`, document its name, mode, purpose, permission
scope (which tools/paths it may use and why), and an example invocation here.

## Working in this repository

### Setup and verification

```sh
npm ci
npm run build
npm test
npm run typecheck
```

The suite is Vitest-based and integration-heavy: tests create real SQLite databases, temporary Git
repositories, and a real MCP client over an in-memory transport. A single test may take more than the
Vitest default; the repository config sets a 20-second timeout.

`npm run dev` runs the CLI from source with Bun. The published package supports Node.js 20+ and Bun.

### Architecture map

- `src/db/` — SQLite connection, schema, database path resolution, project records.
- `src/service/` — `MemoryService`: storage, retrieval, session brief, and graph-neighbor traversal.
- `src/indexer/` — TypeScript/JavaScript AST extraction and dependency indexing.
- `src/mcp/` — MCP server, tool registry, Zod schemas, argument normalization, bounded stdio.
- `src/commands/` — CLI handlers for memory, MCP, contract verification, and setup.
- `src/setup/` — agent catalog and path resolution (`registry.ts`), JSON `mcpServers` / OpenCode `mcp`
  target merging (`json-target.ts`), dependency-free Codex TOML merge/diagnostics (`toml-target.ts`),
  the portable MCP configuration installer/diagnostic (`portable.ts`), and the marked agent rules
  writer/diagnostic (`rules-target.ts`), including legacy Huginn-block detection and replacement.
- `src/contracts/` — in-process TypeScript contract verification.
- `src/util/` — terminal sanitization and path safety.

Read [`DESIGN.md`](./DESIGN.md) before changing the storage schema, service transactions, MCP tool
contract, indexer, or setup writer. Read [`SPEC.md`](./SPEC.md) for product behavior and [`plan.md`](./plan.md)
for the staged setup scope.

### Invariants

- `src/db/schema.sql` and the `SCHEMA_SQL` fallback in `src/db/client.ts` must stay in sync.
- Database migrations must be idempotent and preserve existing rows, indexes, FTS triggers, and data.
- Observation creation and decision supersession happen in one SQLite transaction.
- Default `search` and `getContext` exclude superseded observations; `includeSuperseded` opts in.
- Session bootstrap uses `getReadOnlyDatabase` / `readSessionBrief`: it must not create directories or
  files, run schema DDL/migrations, or insert a project row, and must fail open with a note.
- Graph recovery traverses only stored `entity_dependencies` edges. Keep the default depth at 1, clamp
  depth to 2 and the neighbor limit to 50, deduplicate entities, and use the same traversal for briefs
  and symbol inspection; never infer edges from names or paths.
- Every MCP input is validated with Zod after `normalizeArgs`; keep camelCase and snake_case aliases
  consistent.
- Protected database and JSONL paths go through `assertDocPath`; do not bypass symlink or containment
  checks.
- Setup configuration, target, and legacy paths go through `checkDocPath`; the legacy file is
  read-only, a final symlink is refused, writes are atomic with exclusive temporary files, and
  `--status`/`--dry-run` must not create or modify anything.
- Setup preserves unrelated JSON data and `mcpServers` / `mcp` siblings as well as unrelated TOML
  tables and keys, and leaves a conflicting or legacy `muninn` entry untouched unless `--force` is
  supplied. A correct entry is byte-for-byte idempotent.
- Relative imports use `.js` extensions and TypeScript strict mode is enforced.
- Add new ADRs to [`ADR.md`](./ADR.md) instead of editing past decisions. Mark unimplemented proposals
  as `Proposed` and keep documentation free of claims that they already exist.
- Update [`CHANGELOG.md`](./CHANGELOG.md) under `Unreleased` for user-visible changes.

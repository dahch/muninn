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

- `src/db/` — SQLite connection, schema.sql, `user_version` migrations, project records.
- `src/project/` — portable identity: marker, registry, Git worktrees, storage paths, and DSH
  session workspace resolution (`session.ts`).
- `src/graph/` — code graph: discovery, Tier A/B/C extraction (`extractor.ts`, `treesitter.ts`),
  incremental indexing, bounded queries and `explore` assembly.
- `src/service/` — `MemoryService`: storage, retrieval, session brief, handoffs, graph neighbors, and
  the query planner (`search-plan.ts`) behind tiered search.
- `src/indexer/` — legacy TypeScript/JavaScript AST extraction kept for compatibility.
- `src/mcp/` — MCP server, tool registry, Zod schemas, argument normalization, bounded stdio,
  compact result/schema projections (`compact.ts`, `schema-compact.ts`) and the debounced graph
  auto-index.
- `src/commands/` — CLI handlers for memory, MCP, contract verification, setup, seed, index/graph,
  project identity, migrate, handoff/end-session, doctor, snapshot/restore and hooks.
- `src/setup/` — agent catalog and path resolution (`registry.ts`), JSON `mcpServers` / OpenCode `mcp`
  target merging (`json-target.ts`), dependency-free Codex TOML merge/diagnostics (`toml-target.ts`),
  the portable MCP configuration installer/diagnostic (`portable.ts`), and the marked agent rules
  writer/diagnostic (`rules-target.ts`), including legacy Huginn-block detection and replacement.
- `src/contracts/` — in-process TypeScript contract verification.
- `src/util/` — terminal sanitization, path safety and grammatical count labels (`plural.ts`).

Read [`DESIGN.md`](./DESIGN.md) before changing the storage schema, service transactions, MCP tool
contract, indexer, or setup writer. Read [`SPEC.md`](./SPEC.md) for product behavior and [`plan.md`](./plan.md)
for the staged setup scope.

### Invariants

- `src/db/schema.sql` and the `SCHEMA_SQL` fallback in `src/db/client.ts` must stay in sync
  byte-for-byte (the test compares them).
- Database migrations must be idempotent, tracked with `PRAGMA user_version`, and preserve existing
  rows, indexes, FTS triggers, and data.
- Portable storage lives under `MUNINN_HOME`; never reintroduce a default database path inside the
  repository. `.muninn/project.json` is the committed identity and must be written atomically.
- The code graph is derived state: index incrementally by content hash, prune deleted files and
  dangling edges, and label every edge with `confidence` and `resolution`.
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
- Search runs tiered: the sanitized conjunction first, then a prefix-expanded disjunction, then the
  trigram tier; `match: "all"` keeps the strict conjunction. Compact MCP results are the default and
  `detail: "full"` is the opt-in.
- FTS tokenizer or column changes require a schema migration that drops and rebuilds the virtual
  table and its triggers, then backfills derived columns before the rebuild.
- Freshness is derived state: `code_index_roots` plus `INDEXER_VERSION` plus file fingerprints.
  Agents refresh it through the MCP server (`MUNINN_AUTO_INDEX=0` disables) and `muninn hook
  after-edit`; `muninn_project status`, the brief and `muninn doctor` must report it.
- Setup destinations are catalog data: declare `rulesStrategy` and, where the agent exposes one, a
  `hooks` descriptor in `src/setup/registry.ts` instead of adding agent-specific branches.
- Setup writes only the components the caller selects (`--components mcp,rules,portable`), and hooks
  are never installed by `setup`. `--status` and `--dry-run` must stay read-only.
- Relative imports use `.js` extensions and TypeScript strict mode is enforced.
- Add new ADRs to [`ADR.md`](./ADR.md) instead of editing past decisions. Mark unimplemented proposals
  as `Proposed` and keep documentation free of claims that they already exist.
- Update [`CHANGELOG.md`](./CHANGELOG.md) under `Unreleased` for user-visible changes.

<!-- muninn:rules:start -->
## Muninn project memory

- Call `muninn_bootstrap` once at the start of a session to load the project brief. It includes
  the active decisions and where the last session stopped.
- Before designing a change, use `muninn_search`, `muninn_explore` and `muninn_graph` instead of
  reading the repository. `muninn_explore` returns the relevant source, callers and callees.
- When a session settles something the project should remember — a convention, a tradeoff, a
  discovered constraint, or a bug that took real work — record it with `muninn_save` before you
  finish. Use a `topicKey` for anything a later decision could replace, so the newer one supersedes
  it instead of contradicting it.
- Before finishing, call `muninn_handoff` with the goal, the current state, the next steps and any
  open questions. This is required: it is what lets a new session in another agent start without
  re-reading the project.
- If the code index is empty or stale, call `muninn_project` with action `index`.
- Before completing code, use `muninn_verify_contract` to verify the execution contract.
<!-- muninn:rules:end -->

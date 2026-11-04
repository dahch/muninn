# Plan: Muninn Portable Memory

## Iteration 1 — Explicit decision supersession
modules: src/db/, src/service/, src/mcp/, test/, README.md, DESIGN.md, CHANGELOG.md

**Goal:** Clients can explicitly supersede a project decision and retrieve active decisions by default, while existing databases and memory operations remain usable.

**Acceptance criteria:**
- [ ] Add `status` and `superseded_by` to both schema definitions and migrate existing databases idempotently without losing rows, indexes, or triggers. (REQ-2)
- [ ] Saving a decision with `supersedesTopicKey` atomically supersedes only active decisions with the same topic key in the same project; non-decision observations remain unchanged. (REQ-4)
- [ ] Search and context exclude superseded observations by default, filter in SQL, and return status and replacement ID when `includeSuperseded` is true. (REQ-5)
- [ ] Extend MCP save, search, and context schemas with the optional arguments and snake_case aliases without breaking existing calls. (REQ-6)
- [ ] Add tests for migration from the pre-update schema, FTS behavior after migration, supersession transaction behavior, and default/opt-in retrieval. (REQ-2, REQ-4, REQ-5, REQ-6)
- [ ] Preserve the existing runnable CLI, MCP server, and memory functionality; update README, DESIGN, and CHANGELOG under `Unreleased`. (REQ-14–REQ-18)

**Verification:**
```sh
npm test
npm run typecheck
npm run build
```

Implement this vertical slice against the existing Muninn codebase. In `src/db/schema.sql` and `SCHEMA_SQL` in `src/db/client.ts`, add `observations.status` (`active` or `superseded`, non-null, default `active`) and nullable `observations.superseded_by`. Update `Observation` and service result types. In `getDatabase()`, inspect `PRAGMA table_info(observations)` and add each missing column with an idempotent `ALTER TABLE`; do not recreate tables or modify the FTS triggers. Add a migration test that constructs a database from the pre-update schema, inserts existing rows, then opens it with the new implementation and verifies preserved rows, defaults, and FTS insert/search/update behavior. In `src/service/memory-service.ts`, extend `saveObservation` with `supersedesTopicKey`; within its existing transaction, supersede only active decisions matching the topic key and project, and only when saving a new decision. Add SQL-level `includeSuperseded` filtering to search and context, defaulting to false. Extend the corresponding Zod schemas and handlers in `src/mcp/server.ts` with camelCase and snake_case inputs. Preserve existing interfaces and behavior, add focused service, DB, and MCP tests, and update `README.md`, `DESIGN.md`, and `CHANGELOG.md` under `Unreleased`. Do not add dependencies or schema elements beyond these two columns.

## Iteration 2 — Read-only session bootstrap
modules: src/service/, src/db/, src/mcp/, src/commands/, test/, README.md, DESIGN.md, CHANGELOG.md

**Goal:** An agent or developer can request the same bounded, deterministic session brief through the library, MCP, or CLI without bootstrap creating or modifying a database.

**Acceptance criteria:**
- [ ] Add a typed session brief containing project identity, active decisions, recent activity, path-selected indexed symbols, counts, and explanatory notes; omit empty sections rather than fabricating data. (REQ-7)
- [ ] Group active decisions by topic key; list decisions without a key separately, do not infer replacement by recency, count all observations, and label superseded activity clearly. (REQ-7)
- [ ] Accept up to 20 file or directory paths, normalize relative and in-project absolute paths, enforce project boundaries, and use only indexed symbols without scanning the repository. (REQ-8)
- [ ] Render deterministic Markdown within the requested budget, default 8,000 and maximum 20,000 characters, including headings, notes, and truncation markers. (REQ-9)
- [ ] Missing, inaccessible, or corrupt databases yield an empty brief with a cause in notes, without throwing, creating a database, running DDL, or inserting a project. (REQ-10)
- [ ] Add `muninn_bootstrap` and `muninn memory brief`; MCP and CLI output match the service renderer. (REQ-11)
- [ ] Add tests for empty and populated projects, path matching and containment, budget enforcement, deterministic rendering, read-only failure-open behavior, and MCP/CLI parity. (REQ-7–REQ-11)
- [ ] Preserve existing commands and tools; update README, DESIGN, and CHANGELOG under `Unreleased`. (REQ-17, REQ-18)

**Verification:**
```sh
npm test
npm run typecheck
npm run build
```

Implement the session bootstrap vertical slice. Add `MemoryService.getSessionBrief({ paths?, budgetChars? })` and a shared deterministic Markdown renderer in the service layer. The brief must include project name/root/Git remote when available, active decisions grouped by topic key, recent activity excluding decisions already listed, indexed symbols selected by paths, counts for all observations/entities/links, and notes explaining omitted or unavailable sections. Keep unkeyed decisions separate; group, but do not collapse, multiple active decisions sharing a topic key. Superseded activity must be labelled. Resolve file and directory paths relative to the selected project root, normalize separators, enforce directory boundaries and project containment, and query indexed entities only. Implement a read-only database access path: do not route bootstrap through initialization behavior that creates a database, runs DDL/migrations, or inserts a project record. A missing, inaccessible, or corrupt DB must return an empty brief and explanatory note without throwing; derive only project identity available from the selected root and Git when no project row exists. Enforce positive integer `budgetChars` up to 20,000, default 8,000, against the complete rendered Markdown; visibly mark truncation and ensure even a tiny valid budget is respected. Add MCP `muninn_bootstrap` with Zod validation and the existing registry/error patterns, plus `muninn memory brief [--project <path>] [--paths a,b] [--budget <n>]`; both must use the same renderer. Cover all acceptance cases, preserve existing runnable flows, and update `README.md`, `DESIGN.md`, and `CHANGELOG.md` under `Unreleased`. Do not add dependencies, tables, model-generated content, or repository scanning.

## Iteration 3 — Graph-aware recovery
modules: src/service/, src/mcp/, test/, README.md, DESIGN.md, CHANGELOG.md

**Goal:** Session briefs and symbol inspections expose bounded, deterministic neighbors from Muninn’s indexed dependency graph.

**Acceptance criteria:**
- [ ] Add `neighbors(identifier, { depth?, limit? })` traversing existing dependency edges in both directions, grouped by relation and direction, with stable ordering and cycle protection. (REQ-12)
- [ ] Clamp traversal depth to at most 2 (default 1) and neighbor limit to at most 50 (default 20); return no duplicate entities. (REQ-12)
- [ ] Add `expandGraph` to session briefs, default true, and include deduplicated related symbols within the brief’s existing total character budget. Omit the section and explain when no dependencies are available; disabled expansion adds no related section. (REQ-13)
- [ ] Extend `muninn_inspect_symbol` with bounded depth-1 neighbors from the same traversal implementation while retaining its existing inspection data. (REQ-13, REQ-15)
- [ ] Add tests for depth, direction, cycles, limits, clamping, empty graphs, brief expansion, and inspection integration. (REQ-12, REQ-13)
- [ ] Preserve existing MCP tools and update README, DESIGN, and CHANGELOG under `Unreleased`. (REQ-17)

**Verification:**
```sh
npm test
npm run typecheck
npm run build
```

Implement graph-aware recovery using the existing `entity_dependencies` table and service methods in `src/service/memory-service.ts`. Add `neighbors(identifier, { depth?, limit? })` with bidirectional traversal, grouping by relation type and direction, deterministic ordering, and visited-entity deduplication. Default depth to 1 and clamp it to a maximum of 2; default limit to 20 and clamp it to a maximum of 50. Handle cycles and high-degree nodes without duplicate results or unbounded traversal. Extend the session brief options with `expandGraph`, default true; for the indexed symbols selected by paths, collect deduplicated neighbors and render them within the same total Markdown budget. If expansion is disabled, omit related output; if no dependencies are available, omit the section and explain in notes. Extend the existing `muninn_inspect_symbol` result using this same service traversal at depth 1 and a bounded limit; do not add a new MCP tool or remove existing inspection fields. Add the specified graph and integration tests, preserve existing runnable behavior, and update `README.md`, `DESIGN.md`, and `CHANGELOG.md` under `Unreleased`. Do not infer relationships from names or paths, add schema elements, or add dependencies.

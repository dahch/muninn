## ADR-1: Track decision supersession in observation rows

### Context
Muninn currently stores observations without lifecycle state, so replaced decisions remain indistinguishable from current ones. The update requires explicit, traceable replacement while preserving existing SQLite databases and their data. Alternatives include inferring current decisions from recency, storing replacement history in a new table, or adding lifecycle fields to observations.

### Decision
Add `status` and nullable `superseded_by` columns to `observations`. Migrate existing databases idempotently by inspecting their columns and adding only those missing. A new decision may explicitly supersede active decisions with the same project and topic key; this update and the save occur in one transaction. Retrieval excludes superseded observations by default, with an opt-in to include them.

### Consequences
Existing observations migrate as active without rebuilding tables. Supersession is auditable and atomic, and no additional table is needed. Callers must explicitly request replacement; recency alone never determines validity. Both schema definitions and the existing FTS behavior must remain synchronized and tested.

## ADR-2: Provide bootstrap through a read-only, bounded brief

### Context
Agents need a session-start view of project identity, active decisions, recent activity, indexed symbols, and counts. Constructing the existing `MemoryService` may initialize a database and project record, which is unsuitable for a read-only bootstrap that must fail open. Alternatives include requiring callers to initialize memory first, allowing bootstrap to create the database, or implementing a separate read-only retrieval path.

### Decision
Provide a session-brief operation and shared Markdown renderer for the library, MCP tool, and CLI. Bootstrap reads the existing database without DDL or project insertion; if it is missing or unusable, it returns an empty brief with an explanatory note. The rendered brief has a configurable character budget and deterministic ordering. Path-based symbol selection uses only indexed entities within the project boundary.

### Consequences
Agents can bootstrap without creating project state, and MCP and CLI share one output contract. The implementation must distinguish read-only access from normal service initialization and enforce the character budget over the complete rendered Markdown. Missing data is reported rather than synthesized; the brief may contain less information when the database has not been initialized or indexed.

## ADR-3: Reuse the stored dependency graph for neighbor recovery

### Context
Muninn already persists symbol dependencies, but recovery does not traverse them. The update requires related symbols in session briefs and inspection without adding a new graph tool or inferring relationships. Alternatives include leaving graph data unused, deriving relationships from names or paths, or querying the existing dependency edges through a shared bounded traversal.

### Decision
Add a service-level neighbor traversal over `entity_dependencies`, following edges in both directions with bounded depth and result count, deterministic grouping, and cycle protection. Use the same traversal for brief graph expansion and symbol inspection.

### Consequences
Graph recovery uses only indexed evidence and avoids duplicate traversal implementations. Results are limited by the configured depth and neighbor cap; graph data that has not been indexed cannot provide related symbols and must be reported as absent rather than inferred.

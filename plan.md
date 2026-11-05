# Plan: Muninn Agent Setup

## Iteration 1 — Install and diagnose the portable MCP configuration
modules: src/setup/, src/commands/, src/cli.ts, test/

**Goal:** Developers can install, inspect, and dry-run Muninn’s portable MCP configuration using `muninn setup`.

**Acceptance criteria:**
- [x] `muninn setup` creates `{home}/.muninn/mcp.json` with a `mcpServers.muninn` entry invoking `muninn mcp run`; it does not pin a project path. [REQ-18, REQ-19]
- [x] `--portable` is accepted as equivalent to omitting `--agent`; `--no-portable` without `--agent` reports invalid usage, displays usage, and exits 1. [REQ-18, REQ-25]
- [x] `--status` reports the portable entry as `absent`, `registered`, `legacy`, `conflict`, or `malformed`; malformed JSON is reported with its path and cause and exits 1. [REQ-23, REQ-25]
- [x] `--dry-run` reports the intended portable action without writing files, creating directories, or creating temporaries. [REQ-23]
- [x] Writes preserve existing permissions or use `0o600` for new files, create parent directories with `0o700`, use an exclusive random temporary file and atomic rename, and reject a final-component symlink. [REQ-20]
- [x] A different existing `muninn` entry is left unchanged and reported as `skipped` without `--force`; with `--force`, it is replaced. Correct entries remain byte-identical and report `changed: false`. [REQ-19, REQ-20]
- [x] Tests exercise portable creation, safe merge, conflict and force behavior, malformed JSON, idempotency, dry-run read-only behavior, and symlink rejection. [AC-19, AC-20, AC-23]

**Verification:**
```sh
npm test
npm run typecheck
npm run build
```

Implement a runnable first slice of agent setup in `src/setup/`, wired through `src/commands/` and `src/cli.ts`. Support the portable `{home}/.muninn/mcp.json` flow and its `--portable`, `--no-portable`, `--force`, `--dry-run`, and `--status` options. Use the existing path-safety helpers and implement per-file atomic writes without adding dependencies. Preserve unrelated JSON content and bytes on no-op updates. Add tests for every acceptance criterion. Keep this iteration focused on the portable destination; do not implement the agent catalog or rules yet.

## Iteration 2 — Catalog and configure JSON agent targets
modules: src/setup/, src/commands/, src/cli.ts, test/

**Goal:** Developers can list, diagnose, and configure supported JSON-format agent destinations while retaining the portable configuration by default.

**Acceptance criteria:**
- [x] The registry defines all 13 unique agent IDs, labels, formats, MCP paths, and rules-file paths from the reference catalog. [REQ-17]
- [x] Path resolution expands `{project}`, `{home}`, and `{opencodeConfigDir}` using platform path APIs and supports `MUNINN_AGENT_<ID>_MCP_PATH` overrides separated by `:`. [REQ-17]
- [x] `muninn setup --list` prints the catalog without writing; `--agent` accepts one ID, `all`, or a comma-separated list, and unknown IDs report valid IDs and exit 1. [REQ-17, REQ-18]
- [x] JSON `mcpServers` and OpenCode `mcp` destinations receive the correct Muninn entry; only project-contained config paths receive `--project <absolute path>`. [REQ-19]
- [x] Setup includes the portable destination by default with selected agents; `--no-portable` suppresses it only when an agent is selected. `--status --agent ...` inspects selected agents plus the portable when applicable; without `--agent`, status inspects all agents plus the portable when applicable. [REQ-18, REQ-23]
- [x] Status and dry-run remain read-only. Status reports the MCP diagnostic states and file paths for applicable JSON targets. [REQ-23]
- [x] The setup report distinguishes per-destination MCP outcomes (`written`, `present`, `skipped`, `failed`) and identifies each file. [REQ-24]
- [x] Tests cover the complete registry, marker resolution, environment overrides, selection, JSON formats, project-path selection, read-only modes, and diagnostic states. [REQ-17–REQ-24]

**Verification:**
```sh
npm test
npm run typecheck
npm run build
```

Add the agent catalog and JSON-format installation flows to the existing setup command. Keep catalog data in `src/setup/registry.ts` and path resolution platform-safe. Implement `--list`, selection parsing, JSON merge/write behavior for the registered JSON targets, and selected-target status reporting. Use the Huginn integrator reference as the route and format baseline, without importing or depending on Huginn. Preserve the portable flow from Iteration 1 and add tests for all new behavior. Record rules-file paths in the catalog, but do not modify rules files in this iteration. Codex TOML writing is implemented in the next iteration.

## Iteration 3 — Configure Codex TOML and complete configuration diagnostics
modules: src/setup/, src/commands/, src/cli.ts, test/

**Goal:** Codex TOML configuration can be safely installed and diagnosed alongside JSON targets and the portable configuration.

**Acceptance criteria:**
- [x] Selecting Codex structurally merges `[mcp_servers.muninn]` with `command = "muninn"` and the appropriate `args`, preserving other TOML tables and keys. [REQ-19, REQ-20]
- [x] Malformed TOML reports the file and cause without modifying the original; a correct existing entry is byte-for-byte idempotent. [REQ-20]
- [x] The TOML writer follows the same path safety, permission, temporary-file, and atomic-rename rules as JSON configuration writes. [REQ-20]
- [x] `--status` and `--dry-run` handle TOML without writing, and `--status` reports malformed TOML while continuing to inspect all applicable destinations. [REQ-23, REQ-24]
- [x] With a selected agent, MCP status is reported per destination and the portable remains included unless suppressed. [REQ-18, REQ-23]
- [x] Tests cover structural TOML merge, preservation of unrelated tables, malformed TOML, permissions, symlinks, idempotency, and aggregate status behavior. [REQ-20, REQ-23, REQ-24]

**Verification:**
```sh
npm test
npm run typecheck
npm run build
```

Complete the TOML destination support for Codex in `src/setup/` without adding dependencies. Extend the shared setup flow so JSON and TOML destinations use consistent safety checks, conflict handling, reports, and read-only status/dry-run behavior. Ensure `--status` continues inspecting all applicable destinations after malformed configuration or protected-path errors, reports all such errors, and exits 1. Preserve successful earlier writes when normal setup stops at a fatal error. Add focused tests and keep all previous setup tests passing. Do not implement rules-file writes yet.

## Iteration 4 — Install marked rules and finalize setup behavior and documentation
modules: src/setup/, src/commands/, src/cli.ts, test/, README.md, DESIGN.md, ADR.md, CHANGELOG.md

**Goal:** Setup configures selected agents with idempotent usage rules, complete per-destination reporting, and documented standalone installation behavior.

**Acceptance criteria:**
- [x] Selecting one or more agents installs a marked rules block by default; no agent selection leaves rules files untouched, and `--no-rules` suppresses rules installation. [REQ-21]
- [x] Rules insertion and replacement are idempotent, preserve surrounding content and order, append to existing files, and create a missing file only when a write is required. Shared rules files receive only one Muninn block. [REQ-21]
- [x] A `huginn:muninn-rules` block is reported as `stale`, left unchanged without `--force`, and replaced while preserving surrounding content with `--force`. [REQ-22]
- [x] Rules paths use the existing path-safety checks. Reports identify the rules file and distinguish rules outcomes (`written`, `present`, `stale`, `skipped`, `failed`) from MCP outcomes. [REQ-22, REQ-24]
- [x] `--dry-run` reports MCP and rules actions without writes; fatal errors stop at the first failure in normal setup and dry-run, while earlier writes remain. Status aggregates all applicable diagnostics and failures. [REQ-23, REQ-24]
- [x] Missing agent binaries produce a `not installed` warning without preventing configuration or changing the exit code. [REQ-24, REQ-25]
- [x] Exit codes are limited to 0 for completed, present, or nonfatal skipped results and 1 for fatal file/path errors, unknown agents, or invalid usage. [REQ-25]
- [x] `README.md`, `DESIGN.md`, `ADR.md`, and `CHANGELOG.md` document setup. The ADR explains why machine-oriented MCP configuration is merged structurally while human-authored rules use marked, appended blocks and legacy-block detection. [REQ-21, REQ-22]
- [x] Tests verify rules insertion, preservation, idempotency, shared-file deduplication, stale handling, read-only modes, error behavior, exit codes, and `not installed` warnings. [REQ-21–REQ-25]

**Verification:**
```sh
npm test
npm run typecheck
npm run build
```

Complete the setup implementation against `src/setup/`, `src/commands/`, and `src/cli.ts`. Add marked rules-file insertion, status and dry-run reporting, legacy-block handling, and `--no-rules`; enforce `assertDocPath` for each rules file. Deduplicate selected destinations that share a rules file. Finish per-destination reporting and error semantics, including `not installed` warnings and the specified exit codes. Keep setup writes atomic per file and do not roll back earlier successful writes after a later fatal error. Update `README.md`, `DESIGN.md`, `ADR.md`, and `CHANGELOG.md` to describe the standalone setup command and its safety/ownership decisions. Add integration tests using temporary homes and project trees only; tests must not modify the checkout’s real agent configuration or the real home directory.

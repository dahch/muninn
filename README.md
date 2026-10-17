# Muninn

Persistent **semantic and symbol memory** for AI coding agents.

Muninn stores the things a coding session learns — architectural decisions, conventions,
discoveries, bugfixes — next to the symbols they refer to, in a single SQLite file that lives
with the project. It speaks **MCP** so any agent can save and query it, and it exposes the same
engine as a plain Node/Bun library and a CLI.

It used to live inside [Huginn](https://github.com/dahch/huginn); it is now an independent
package with no dependency on the orchestrator.

## What it gives you

- **Observations with categories** — `decision`, `convention`, `discovery`, `bugfix`,
  `architecture` — searchable with SQLite **FTS5 + BM25** ranking.
- **A symbol graph** — the TypeScript Compiler API extracts files, functions, classes,
  interfaces and modules from your sources, plus the `imports`/`calls`/`extends`/`implements`/
  `references` edges between them, and links observations to symbols.
- **MCP tools** for agents: `muninn_context`, `muninn_save`, `muninn_search`,
  `muninn_link_symbol`, `muninn_inspect_symbol`, `muninn_verify_contract`, `muninn_stats`.
- **Contract verification** — the same TypeScript execution-contract check as a CLI command
  (`muninn check`) and as the `muninn_verify_contract` MCP tool.
- **JSONL sync** — export/import the whole memory as portable line-delimited JSON.
- **Local-first and self-contained** — no embeddings, no network, no server: one SQLite file
  and one process.

## Install

```sh
npm install -g @dahch/muninn     # CLI + MCP server
# or as a library
npm install @dahch/muninn
```

Requires Node.js >= 20 (or Bun).

## CLI

```sh
muninn memory init   [--db <path>] [--project <path>]
muninn memory search <query> [--category <cat>] [--limit <n>] [--project <path>]
muninn memory sync   [--import] [--file <path>] [--project <path>]
muninn memory index  [files...] [--project <path>] [--db <path>]

muninn check [files...] [--project <path>]

muninn mcp run [--db <path>] [--project <path>]
```

The database resolves to `<git-root>/.huginn/muninn.db` inside a repository and to
`~/.huginn/muninn.db` outside one. `--db` overrides it; `:memory:` is accepted for tests.
Both the database file and the project record are resolved from the **same** root, so
`--project X` can never write into another project's database.

## MCP

Register Muninn with any MCP-capable agent. For example, a Claude Code / Codex / Cursor config
(`mcpServers`):

```json
{
  "mcpServers": {
    "muninn": {
      "command": "muninn",
      "args": ["mcp", "run", "--project", "/absolute/path/to/repo"]
    }
  }
}
```

OpenCode uses the same shape under the `mcp` key with `"type": "local"` and a `command` array.
Huginn's `huginn setup` writes this for you in every runtime it knows about.

```sh
muninn mcp run --project .
```

## Library

```ts
import { MemoryService, indexFilesIntoMuninn } from "@dahch/muninn";

const memory = new MemoryService({ projectRoot: process.cwd() });

memory.saveObservation({
  category: "decision",
  title: "Auth is a port",
  content: "Tokens are validated behind an AuthPort so the transport can change.",
  symbols: ["src/auth/port.ts"],
});

indexFilesIntoMuninn(memory, ["src/auth/port.ts"], { projectRoot: process.cwd() });

for (const hit of memory.search({ query: "token validation", limit: 5 })) {
  console.log(hit.category, hit.title, hit.rank);
}

memory.close();
```

Subpath entry points are available for narrower imports:

| Import | Contents |
|---|---|
| `@dahch/muninn` | everything below |
| `@dahch/muninn/db` | SQLite client, schema, path resolution, project records |
| `@dahch/muninn/service` | `MemoryService` (save, search, context, linking, sync, stats) |
| `@dahch/muninn/indexer` | AST symbol/dependency extraction and indexing |
| `@dahch/muninn/mcp` | MCP server, tool registry, bounded stdio transport |
| `@dahch/muninn/contracts` | TypeScript contract verification |
| `@dahch/muninn/util` | terminal-text sanitizer |

## Security notes

- Every path Muninn writes to — the SQLite file and the JSONL export — is screened: a symlink on
  the final component is refused, and a project-relative path must resolve inside the project, so
  a repository cannot redirect the write outside itself (the `src/util/path-safety.ts` rule, with
  the tests in `test/db.test.ts` and `test/service.test.ts`).
- The MCP stdio transport is bounded and survives a dead parent instead of crashing or hanging.
- MCP tool inputs are validated with zod; unknown tools and bad arguments fail closed.

## Development

```sh
npm ci
npm run build      # tsc -> dist/ (+ schema.sql, +x cli.js)
npm test           # vitest run (storage, service, indexer, MCP, CLI)
npm run typecheck  # tsc --noEmit
bun run src/cli.ts memory init --project .
```

Publishing is tag-driven: `git tag v0.1.0 && git push --tags` runs
`.github/workflows/publish.yml`, which verifies the tag matches `package.json`, builds, tests and
publishes to npm.

## License

MIT © Daniel Hernández

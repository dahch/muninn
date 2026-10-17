/**
 * Public API of the Muninn memory engine.
 *
 * Everything below is safe to import from a Node or Bun process:
 *
 * ```ts
 * import { MemoryService, indexFilesIntoMuninn } from "@dahch/muninn";
 *
 * const memory = new MemoryService({ projectRoot: process.cwd() });
 * indexFilesIntoMuninn(memory, ["src/app.ts"], { projectRoot: process.cwd() });
 * console.log(memory.search({ query: "auth", limit: 5 }));
 * ```
 *
 * Subpath entry points (`@dahch/muninn/db`, `/service`, `/indexer`, `/mcp`,
 * `/contracts`, `/util`) expose the same modules without the barrel.
 */
export * from "./db/client.js";
export * from "./service/index.js";
export * from "./indexer/index.js";
export * from "./mcp/index.js";
export * from "./contracts/index.js";
export * from "./util/text.js";

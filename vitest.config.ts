import { defineConfig } from "vitest/config";

// The whole Muninn suite runs under vitest (Node): the storage, service, indexer,
// MCP and CLI layers are integration-heavy — they create real SQLite databases,
// spawn git repositories and drive a real MCP client over an in-memory transport —
// so there is a single runner and no second, bun-only half to keep in sync.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Several suites build real TypeScript programs and git repositories; under a
    // loaded CI runner the default 5 s budget made healthy tests flaky.
    testTimeout: 20_000,
  },
});

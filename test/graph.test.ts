import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { getDatabase } from "../src/db/client.js";
import {
  MemoryService,
  readSessionBrief,
  type Entity,
} from "../src/service/index.js";
import { TOOL_REGISTRY } from "../src/mcp/server.js";

describe("Graph-aware recovery (Iteration 3)", () => {
  let tempDir: string;
  let db: Database.Database;
  let service: MemoryService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-graph-test-"));
    db = getDatabase(":memory:");
    service = new MemoryService({ db, projectRoot: tempDir });
  });

  afterEach(() => {
    service.close(true);
    if (db.open) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function entity(identifier: string, filePath = `src/${identifier}.ts`): Entity {
    const row: Entity = {
      id: crypto.randomUUID(),
      project_id: service.currentProject.id,
      entity_type: "function",
      identifier,
      file_path: filePath,
    };
    db.prepare(
      `INSERT INTO entities (id, project_id, entity_type, identifier, file_path)
       VALUES (?, ?, ?, ?, ?)`
    ).run(row.id, row.project_id, row.entity_type, row.identifier, row.file_path);
    return row;
  }

  function edge(
    source: Entity,
    target: Entity,
    relation: "imports" | "calls" | "implements" | "extends" | "references"
  ): void {
    db.prepare(
      `INSERT INTO entity_dependencies (source_entity_id, target_entity_id, relation_type)
       VALUES (?, ?, ?)`
    ).run(source.id, target.id, relation);
  }

  it("traverses both directions, groups by relation and direction, and deduplicates", () => {
    const root = entity("a", "src/a.ts");
    const outgoing = entity("b", "src/b.ts");
    const incoming = entity("c", "src/c.ts");

    edge(root, outgoing, "imports");
    edge(root, outgoing, "references");
    edge(incoming, root, "calls");

    const result = service.neighbors("a")!;
    expect(result).not.toBeNull();
    expect(result.entity.id).toBe(root.id);
    expect(result.depth).toBe(1);
    expect(result.limit).toBe(20);
    expect(result.neighbors.map((neighbor) => neighbor.entity.identifier)).toEqual([
      "b",
      "c",
    ]);
    expect(new Set(result.neighbors.map((neighbor) => neighbor.entity.id)).size).toBe(
      2
    );
    expect(result.groups).toEqual([
      expect.objectContaining({
        direction: "outgoing",
        relationType: "imports",
      }),
      expect.objectContaining({
        direction: "incoming",
        relationType: "calls",
      }),
    ]);
    // The same edge relation is represented once even when multiple stored
    // relation types point at the same entity.
    expect(result.groups[0].neighbors).toHaveLength(1);
  });

  it("respects depth, clamps it to two, and protects against cycles", () => {
    const a = entity("a");
    const b = entity("b");
    const c = entity("c");
    const d = entity("d");
    edge(a, b, "imports");
    edge(b, a, "references");
    edge(b, c, "calls");
    edge(c, d, "extends");

    expect(service.neighbors("a")!.neighbors.map((n) => n.entity.identifier)).toEqual([
      "b",
    ]);

    const depthTwo = service.neighbors("a", { depth: 2 })!;
    expect(depthTwo.depth).toBe(2);
    expect(depthTwo.neighbors.map((n) => n.entity.identifier)).toEqual(["b", "c"]);
    expect(depthTwo.neighbors.map((n) => n.depth)).toEqual([1, 2]);
    expect(depthTwo.neighbors.some((n) => n.entity.id === a.id)).toBe(false);

    const clamped = service.neighbors("a", { depth: 99 })!;
    expect(clamped.depth).toBe(2);
    expect(clamped.neighbors.map((n) => n.entity.identifier)).toEqual(["b", "c"]);
    expect(clamped.neighbors.some((n) => n.entity.identifier === "d")).toBe(false);
  });

  it("applies the default and maximum neighbor limits deterministically", () => {
    const root = entity("root");
    for (let index = 0; index < 60; index++) {
      const target = entity(`target-${String(index).padStart(2, "0")}`);
      edge(root, target, "imports");
    }

    const defaults = service.neighbors("root")!;
    expect(defaults.limit).toBe(20);
    expect(defaults.neighbors).toHaveLength(20);
    expect(defaults.truncated).toBe(true);
    expect(defaults.neighbors.map((n) => n.entity.identifier)).toEqual(
      Array.from({ length: 20 }, (_, index) =>
        `target-${String(index).padStart(2, "0")}`
      )
    );

    const limited = service.neighbors("root", { limit: 5 })!;
    expect(limited.limit).toBe(5);
    expect(limited.neighbors).toHaveLength(5);

    const clamped = service.neighbors("root", { limit: 999 })!;
    expect(clamped.limit).toBe(50);
    expect(clamped.neighbors).toHaveLength(50);
  });

  it("falls back to defaults for non-positive or non-finite depth and limit values", () => {
    const root = entity("root");
    const direct = entity("direct");
    const indirect = entity("indirect");
    edge(root, direct, "imports");
    edge(direct, indirect, "calls");

    for (const depth of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const result = service.neighbors("root", { depth })!;
      expect(result.depth).toBe(1);
      expect(result.neighbors.map((neighbor) => neighbor.entity.identifier)).toEqual([
        "direct",
      ]);
    }

    const fractionalDepth = service.neighbors("root", { depth: 1.9 })!;
    expect(fractionalDepth.depth).toBe(1);

    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const result = service.neighbors("root", { limit })!;
      expect(result.limit).toBe(20);
      expect(result.neighbors).toHaveLength(1);
    }

    const fractionalLimit = service.neighbors("root", { limit: 1.9 })!;
    expect(fractionalLimit.limit).toBe(1);
    expect(fractionalLimit.neighbors.map((neighbor) => neighbor.entity.identifier)).toEqual([
      "direct",
    ]);
  });

  it("orders groups deterministically by direction, relation, then identifier", () => {
    const root = entity("root");
    edge(root, entity("gamma"), "imports");
    edge(root, entity("beta"), "calls");
    edge(root, entity("alpha"), "imports");
    edge(entity("epsilon"), root, "imports");
    edge(entity("delta"), root, "references");

    const first = service.neighbors("root")!;
    const second = service.neighbors("root")!;

    expect(first.neighbors.map((neighbor) => neighbor.entity.identifier)).toEqual([
      "alpha",
      "gamma",
      "beta",
      "epsilon",
      "delta",
    ]);
    expect(first.groups.map((group) => [group.direction, group.relationType])).toEqual([
      ["outgoing", "imports"],
      ["outgoing", "calls"],
      ["incoming", "imports"],
      ["incoming", "references"],
    ]);
    expect(first.neighbors).toEqual(second.neighbors);
    expect(first.groups).toEqual(second.groups);
  });

  it("skips self-loops and repeated entities while traversing cycles", () => {
    const root = entity("root");
    const b = entity("b");
    edge(root, root, "references");
    edge(root, b, "imports");
    edge(b, root, "calls");
    edge(b, b, "calls");

    const result = service.neighbors("root", { depth: 2 })!;
    expect(result.neighbors.map((neighbor) => neighbor.entity.identifier)).toEqual([
      "b",
    ]);
    expect(result.neighbors[0].depth).toBe(1);
  });

  it("returns an empty traversal for an isolated symbol and null for unknown input", () => {
    entity("isolated");
    const empty = service.neighbors("isolated")!;
    expect(empty.neighbors).toEqual([]);
    expect(empty.groups).toEqual([]);
    expect(empty.truncated).toBe(false);

    expect(service.neighbors("missing")).toBeNull();
    expect(service.neighbors("")).toBeNull();
    expect(service.inspectSymbol("")).toBeNull();
    expect(service.inspectSymbol("   ")).toBeNull();
  });

  it("adds deduplicated related symbols to briefs and explains empty expansion", async () => {
    const root = entity("root", "src/root.ts");
    const b = entity("b", "src/b.ts");
    const c = entity("c", "src/c.ts");
    edge(root, b, "imports");
    edge(c, root, "references");

    const expanded = service.getSessionBrief({
      paths: ["src/root.ts"],
    });
    expect(expanded.symbols.map((symbol) => symbol.identifier)).toEqual(["root"]);
    expect(expanded.related.map((neighbor) => neighbor.entity.identifier)).toEqual([
      "b",
      "c",
    ]);
    expect(new Set(expanded.related.map((neighbor) => neighbor.entity.id)).size).toBe(
      expanded.related.length
    );
    expect(expanded.markdown).toContain("## Related Symbols");
    expect(expanded.markdown).toContain("`b`");
    expect(expanded.markdown).toContain("`c`");

    const disabled = service.getSessionBrief({
      paths: ["src/root.ts"],
      expandGraph: false,
    });
    expect(disabled.related).toEqual([]);
    expect(disabled.markdown).not.toContain("## Related Symbols");
    expect(disabled.notes.join(" ")).not.toContain("dependency neighbors");

    const mcpExpanded = await TOOL_REGISTRY.muninn_bootstrap.handler(service, {
      paths: ["src/root.ts"],
    });
    expect(mcpExpanded).toContain("## Related Symbols");
    const mcpDisabled = await TOOL_REGISTRY.muninn_bootstrap.handler(service, {
      paths: ["src/root.ts"],
      expandGraph: false,
    });
    expect(mcpDisabled).not.toContain("## Related Symbols");

    entity("lonely", "src/lonely.ts");
    const noEdges = service.getSessionBrief({ paths: ["src/lonely.ts"] });
    expect(noEdges.related).toEqual([]);
    expect(noEdges.markdown).not.toContain("## Related Symbols");
    expect(noEdges.notes.join(" ")).toContain(
      "No indexed dependency neighbors were found"
    );
  });

  it("deduplicates related symbols across selected symbols and caps the total", () => {
    const a = entity("a", "src/a.ts");
    const b = entity("b", "src/b.ts");
    const shared = entity("shared", "src/shared.ts");
    edge(a, shared, "imports");
    edge(b, shared, "references");

    const deduplicated = service.getSessionBrief({
      paths: ["src/a.ts", "src/b.ts"],
    });
    expect(deduplicated.symbols.map((symbol) => symbol.identifier)).toEqual([
      "a",
      "b",
    ]);
    expect(deduplicated.related.map((item) => item.entity.identifier)).toEqual([
      "shared",
    ]);

    const root = entity("root", "src/root.ts");
    const other = entity("other", "src/other.ts");
    entity("lonely", "src/lonely.ts");
    entity("zzz", "src/zzz.ts");
    for (let index = 0; index < 49; index++) {
      edge(root, entity(`root-related-${String(index).padStart(2, "0")}`), "imports");
    }
    for (let index = 0; index < 2; index++) {
      edge(other, entity(`other-related-${String(index).padStart(2, "0")}`), "imports");
    }

    const capped = service.getSessionBrief({
      paths: ["src/root.ts", "src/other.ts", "src/lonely.ts", "src/zzz.ts"],
    });
    expect(capped.related).toHaveLength(50);
    expect(new Set(capped.related.map((item) => item.entity.id)).size).toBe(50);
  });

  it("honors expandGraph on the standalone read-only helper", () => {
    const root = entity("root", "src/root.ts");
    edge(root, entity("neighbor", "src/neighbor.ts"), "imports");

    const expanded = readSessionBrief({
      db,
      projectRoot: tempDir,
      paths: ["src/root.ts"],
    });
    expect(expanded.related.map((item) => item.entity.identifier)).toEqual([
      "neighbor",
    ]);
    expect(expanded.markdown).toContain("## Related Symbols");

    const disabled = readSessionBrief({
      db,
      projectRoot: tempDir,
      paths: ["src/root.ts"],
      expandGraph: false,
    });
    expect(disabled.related).toEqual([]);
    expect(disabled.markdown).not.toContain("## Related Symbols");
    expect(disabled.notes.join(" ")).not.toContain("dependency neighbors");
  });

  it("keeps brief graph expansion within the existing Markdown budget", () => {
    const root = entity("root", "src/root.ts");
    for (let index = 0; index < 40; index++) {
      edge(root, entity(`related-${String(index).padStart(2, "0")}`), "imports");
    }

    const budget = 400;
    const brief = service.getSessionBrief({
      paths: ["src/root.ts"],
      budgetChars: budget,
    });
    expect(brief.markdown.length).toBeLessThanOrEqual(budget);
    expect(brief.truncated).toBe(true);
  });

  it("extends symbol inspection with bounded depth-1 neighbors while keeping its data", async () => {
    const root = entity("root", "src/root.ts");
    const direct = entity("direct", "src/direct.ts");
    const indirect = entity("indirect", "src/indirect.ts");
    edge(root, direct, "imports");
    edge(direct, indirect, "calls");

    const observation = service.saveObservation({
      category: "discovery",
      title: "Root inspection",
      content: "Root is indexed.",
      symbols: ["root"],
    });

    const inspection = service.inspectSymbol("root")!;
    expect(inspection.entity.id).toBe(root.id);
    expect(inspection.observations.map((item) => item.id)).toEqual([
      observation.id,
    ]);
    expect(inspection.dependencies.outgoing).toHaveLength(1);
    expect(inspection.neighbors.neighbors.map((n) => n.entity.identifier)).toEqual([
      "direct",
    ]);
    expect(
      inspection.neighbors.neighbors.some(
        (neighbor) => neighbor.entity.identifier === "indirect"
      )
    ).toBe(false);

    const mcpResult = (await TOOL_REGISTRY.muninn_inspect_symbol.handler(
      service,
      { symbol: "root" }
    )) as Record<string, unknown>;
    expect(mcpResult.found).toBe(true);
    expect(mcpResult.neighbors).toMatchObject({
      neighbors: [expect.objectContaining({ direction: "outgoing" })],
    });
  });
});

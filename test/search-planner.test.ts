import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { getDatabase } from "../src/db/client.js";
import { MemoryService } from "../src/service/memory-service.js";
import {
  extractSearchTerms,
  planSearchQuery,
} from "../src/service/search-plan.js";
import { compactSearchResults } from "../src/mcp/compact.js";
import { makeSnippet } from "../src/util/text.js";

describe("search planner", () => {
  it("extracts terms from words and quoted phrases", () => {
    expect(extractSearchTerms("session brief budget")).toEqual([
      "session",
      "brief",
      "budget",
    ]);
    expect(extractSearchTerms('"session brief" budget')).toEqual([
      "session brief",
      "budget",
    ]);
  });

  it("drops pure punctuation, reduces wildcards and deduplicates terms", () => {
    expect(extractSearchTerms("/// * --- budget* BUDGET")).toEqual(["budget"]);
    expect(extractSearchTerms("")).toEqual([]);
    expect(extractSearchTerms("...")).toEqual([]);
  });

  it("keeps path and symbol queries as single terms", () => {
    expect(extractSearchTerms("src/muninn/db/client.ts")).toEqual([
      "src/muninn/db/client.ts",
    ]);
  });

  it("builds an exact conjunction and a prefix-expanded disjunction", () => {
    const exact = '"session" "brief"';
    const plan = planSearchQuery("session brief", exact);
    expect(plan).not.toBeNull();
    expect(plan!.exact).toBe(exact);
    expect(plan!.broad).toBe('"session"* OR "brief"*');
    expect(plan!.multiTerm).toBe(true);
  });

  it("returns null when nothing searchable remains", () => {
    expect(planSearchQuery("***", "")).toBeNull();
  });
});

describe("makeSnippet", () => {
  it("returns the whole text when it already fits", () => {
    expect(makeSnippet("short text", ["text"], 100)).toBe("short text");
  });

  it("centers the excerpt on the first matching term and bounds its length", () => {
    const body = `${"padding ".repeat(40)}needle${" trailing".repeat(40)}`;
    const snippet = makeSnippet(body, ["needle"], 120);
    expect(snippet).toContain("needle");
    expect(snippet.length).toBeLessThanOrEqual(126);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("falls back to the start of the text when no term matches", () => {
    const snippet = makeSnippet("alpha beta gamma delta", ["zulu"], 12);
    expect(snippet.startsWith("alpha")).toBe(true);
  });
});

describe("tiered memory search", () => {
  let db: Database.Database;
  let service: MemoryService;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-search-test-"));
    db = getDatabase(":memory:");
    service = new MemoryService({ db, projectRoot: tempDir });
  });

  afterEach(() => {
    service.close(true);
    if (db.open) db.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns results for a natural-language question no document matches as a conjunction", () => {
    service.saveObservation({
      category: "discovery",
      title: "Index freshness",
      content: "The stale graph is refreshed by an incremental reindex after edits.",
    });
    service.saveObservation({
      category: "architecture",
      title: "Session brief",
      content: "The brief has a character budget and an escape hatch.",
    });

    const before = service.search({
      query: "how do we keep the graph updated after edits",
    });
    expect(before.length).toBeGreaterThan(0);
    expect(before[0].title).toBe("Index freshness");
  });

  it("honours strict match, which never falls back", () => {
    service.saveObservation({
      category: "discovery",
      title: "Index freshness",
      content: "The stale graph is refreshed by an incremental reindex after edits.",
    });

    const smart = service.search({
      query: "how do we keep the graph updated after edits",
    });
    expect(smart.length).toBeGreaterThan(0);

    const strict = service.search({
      query: "how do we keep the graph updated after edits",
      match: "all",
    });
    expect(strict).toHaveLength(0);
  });

  it("keeps exact conjunction results first and appends fallback matches", () => {
    service.saveObservation({
      category: "decision",
      title: "Exact match",
      content: "alpha beta gamma.",
    });
    service.saveObservation({
      category: "discovery",
      title: "Partial match",
      content: "only alpha appears here.",
    });

    const results = service.search({ query: "alpha beta" });
    expect(results[0].title).toBe("Exact match");
    expect(results.map((result) => result.title)).toContain("Partial match");
    expect(results[0].rank).toBeLessThan(results[1].rank);
  });

  it("collapses observations with identical title and content", () => {
    const first = service.saveObservation({
      category: "convention",
      title: "Same title",
      content: "Same body.",
    });
    service.saveObservation({
      category: "convention",
      title: "Same title",
      content: "Same body.",
    });

    const results = service.search({ query: "same body" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(first.id);
  });

  it("promotes an observation linked to an entity named in the query", () => {
    service.saveObservation({
      category: "architecture",
      title: "Linked decision",
      content: "zebra",
      symbols: ["src/zebra.ts"],
    });
    service.saveObservation({
      category: "discovery",
      title: "Unlinked note",
      content: "zebra",
    });

    const results = service.search({ query: "zebra" });
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Linked decision");
    expect(results[0].entities[0]?.identifier).toBe("src/zebra.ts");
  });
});

describe("compact search projection", () => {
  const entity = {
    id: "e1",
    project_id: "p1",
    entity_type: "file" as const,
    identifier: "src/db/client.ts",
    file_path: "src/db/client.ts",
  };
  const base = {
    id: "o1",
    project_id: "p1",
    category: "decision" as const,
    title: "Compact me",
    topic_key: "k",
    status: "active" as const,
    superseded_by: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
    content: "x".repeat(2_000),
    entities: [entity],
    rank: -1,
  };

  it("drops the full body, keeps identity and a bounded excerpt", () => {
    const [compact] = compactSearchResults([base], ["x"], 140);
    expect(compact).not.toHaveProperty("content");
    expect(compact.snippet.length).toBeLessThanOrEqual(146);
    expect(compact.id).toBe("o1");
    expect(compact.rank).toBe(-1);
    expect(compact.entities[0].identifier).toBe("src/db/client.ts");
  });
});

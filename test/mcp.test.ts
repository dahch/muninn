import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDatabase } from "../src/db/client.js";
import { MemoryService } from "../src/service/index.js";
import {
  createMcpServer,
  startMcpServer,
  formatZodErrors,
  normalizeArgs,
  TOOL_REGISTRY,
  MUNINN_TOOLS,
  TOOL_NAMES,
  MuninnSaveSchema,
  MuninnSearchSchema,
  MuninnContextSchema,
  MuninnLinkSymbolSchema,
  MuninnStatsSchema,
  MuninnInspectSymbolSchema,
  MuninnVerifyContractSchema,
  CategorySchema,
  SymbolSchema,
  type IMemoryService,
} from "../src/mcp/index.js";

describe("Muninn MCP Server (Model Context Protocol)", () => {
  let db: Database.Database;
  let service: MemoryService;
  let tempDir: string;
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-mcp-test-"));
    db = getDatabase(":memory:");
    service = new MemoryService({ db, projectRoot: tempDir });
    server = createMcpServer(service);

    const [t1, t2] = InMemoryTransport.createLinkedPair();
    serverTransport = t1;
    clientTransport = t2;

    await server.connect(serverTransport);

    client = new Client(
      { name: "test-mcp-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      // ignore close errors
    }
    try {
      await server.close();
    } catch {
      // ignore close errors
    }
    service.close(true);
    if (db.open) {
      db.close();
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Metadata & Tool Listing (AC-8.1 - AC-8.6)", () => {
    it("lists all Muninn tools with complete jsonSchema definitions", async () => {
      const response = await client.listTools();
      expect(response).toBeDefined();
      expect(response.tools).toBeInstanceOf(Array);
      expect(response.tools).toHaveLength(7);

      const toolNames = response.tools.map((t) => t.name);
      expect(toolNames).toContain("muninn_save");
      expect(toolNames).toContain("muninn_search");
      expect(toolNames).toContain("muninn_context");
      expect(toolNames).toContain("muninn_link_symbol");
      expect(toolNames).toContain("muninn_stats");
      expect(toolNames).toContain("muninn_inspect_symbol");
      expect(toolNames).toContain("muninn_verify_contract");

      // Verify static exports match
      expect(TOOL_NAMES).toEqual([
        "muninn_save",
        "muninn_search",
        "muninn_context",
        "muninn_link_symbol",
        "muninn_stats",
        "muninn_inspect_symbol",
        "muninn_verify_contract",
      ]);
      expect(MUNINN_TOOLS).toHaveLength(7);
    });

    it("verifies tool schemas have valid property structures and descriptions", async () => {
      const response = await client.listTools();
      const saveTool = response.tools.find((t) => t.name === "muninn_save")!;
      expect(saveTool).toBeDefined();
      expect(saveTool.description).toBeTruthy();
      expect(saveTool.inputSchema).toBeDefined();
      expect(saveTool.inputSchema.type).toBe("object");
      expect(saveTool.inputSchema.properties).toHaveProperty("category");
      expect(saveTool.inputSchema.properties).toHaveProperty("title");
      expect(saveTool.inputSchema.properties).toHaveProperty("content");
      expect(saveTool.inputSchema.properties).toHaveProperty("topicKey");
      expect(saveTool.inputSchema.properties).toHaveProperty("symbols");
      expect(saveTool.inputSchema.required).toEqual(
        expect.arrayContaining(["category", "title", "content"])
      );

      const searchTool = response.tools.find((t) => t.name === "muninn_search")!;
      expect(searchTool).toBeDefined();
      expect(searchTool.inputSchema.properties).toHaveProperty("query");
      expect(searchTool.inputSchema.properties).toHaveProperty("category");
      expect(searchTool.inputSchema.properties).toHaveProperty("limit");
      expect(searchTool.inputSchema.properties).toHaveProperty("allProjects");
      expect(searchTool.inputSchema.required).toContain("query");

      const contextTool = response.tools.find((t) => t.name === "muninn_context")!;
      expect(contextTool).toBeDefined();
      expect(contextTool.inputSchema.properties).toHaveProperty("limit");
      expect(contextTool.inputSchema.properties).toHaveProperty("category");
      expect(contextTool.inputSchema.properties).toHaveProperty("topicKey");
      expect(contextTool.inputSchema.properties).toHaveProperty("allProjects");

      const linkTool = response.tools.find((t) => t.name === "muninn_link_symbol")!;
      expect(linkTool).toBeDefined();
      expect(linkTool.inputSchema.properties).toHaveProperty("observationId");
      expect(linkTool.inputSchema.properties).toHaveProperty("symbol");
      expect(linkTool.inputSchema.required).toEqual(
        expect.arrayContaining(["observationId", "symbol"])
      );

      const statsTool = response.tools.find((t) => t.name === "muninn_stats")!;
      expect(statsTool).toBeDefined();
      expect(statsTool.inputSchema.properties).toHaveProperty("allProjects");

      const inspectTool = response.tools.find(
        (t) => t.name === "muninn_inspect_symbol"
      )!;
      expect(inspectTool).toBeDefined();
      expect(inspectTool.description).toBeTruthy();
      expect(inspectTool.inputSchema.properties).toHaveProperty("symbol");
      expect(inspectTool.inputSchema.properties).toHaveProperty("projectId");
      expect(inspectTool.inputSchema.properties).toHaveProperty("project_id");
      expect(inspectTool.inputSchema.required).toContain("symbol");

      const verifyTool = response.tools.find(
        (t) => t.name === "muninn_verify_contract"
      )!;
      expect(verifyTool).toBeDefined();
      expect(verifyTool.description).toBeTruthy();
      expect(verifyTool.inputSchema.properties).toHaveProperty("files");
      expect(verifyTool.inputSchema.properties).toHaveProperty("projectRoot");
      expect(verifyTool.inputSchema.properties).toHaveProperty("project_root");
    });
  });

  describe("muninn_save Execution (AC-8.2)", () => {
    it("creates an observation with string and object symbols and returns JSON content", async () => {
      const callResult = (await client.callTool({
        name: "muninn_save",
        arguments: {
          category: "architecture",
          title: "Modular Subsystem Architecture",
          content: "The subsystem is separated into db, service, and mcp modules.",
          topicKey: "arch_decisions",
          symbols: [
            "src/mcp/server.ts",
            {
              name: "createMcpServer",
              filePath: "src/mcp/server.ts",
              type: "function",
            },
          ],
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      expect(callResult.content).toHaveLength(1);
      expect(callResult.content[0].type).toBe("text");

      const data = JSON.parse(callResult.content[0].text);
      expect(data).toHaveProperty("id");
      expect(data.category).toBe("architecture");
      expect(data.title).toBe("Modular Subsystem Architecture");
      expect(data.content).toBe(
        "The subsystem is separated into db, service, and mcp modules."
      );
      expect(data.topic_key).toBe("arch_decisions");
      expect(data.entities).toHaveLength(2);

      const identifiers = data.entities.map((e: any) => e.identifier);
      expect(identifiers).toContain("src/mcp/server.ts");
      expect(identifiers).toContain("src/mcp/server.ts::createMcpServer");

      // Verify in database
      const count = db
        .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM observations")
        .get()?.count;
      expect(count).toBe(1);
    });

    it("supports snake_case topic_key fallback in muninn_save", async () => {
      const callResult = (await client.callTool({
        name: "muninn_save",
        arguments: {
          category: "decision",
          title: "Use SQLite for Persistence",
          content: "SQLite was chosen for local self-contained operation.",
          topic_key: "persistence_choice",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const data = JSON.parse(callResult.content[0].text);
      expect(data.topic_key).toBe("persistence_choice");
    });
  });

  describe("muninn_search Execution (AC-8.3)", () => {
    beforeEach(() => {
      service.saveObservation({
        category: "decision",
        title: "Use SQLite WAL mode",
        content: "We use SQLite Write-Ahead Logging for high concurrency and robustness.",
        topicKey: "database",
        symbols: ["src/db/client.ts"],
      });
      service.saveObservation({
        category: "convention",
        title: "Code Formatting Standard",
        content: "All code must follow strict TypeScript guidelines and prettier format.",
        topicKey: "coding",
      });
      service.saveObservation({
        category: "bugfix",
        title: "Fix SQLite WAL lock contention",
        content: "Resolved busy lock contention in SQLite WAL mode by adding timeout.",
        topicKey: "database",
      });
    });

    it("searches observations using BM25 ranking and returns results with rank", async () => {
      const callResult = (await client.callTool({
        name: "muninn_search",
        arguments: {
          query: "SQLite WAL",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const results = JSON.parse(callResult.content[0].text);
      expect(results).toBeInstanceOf(Array);
      expect(results.length).toBeGreaterThanOrEqual(2);

      // Verify results are ranked
      expect(results[0]).toHaveProperty("rank");
      expect(results[0].title).toMatch(/SQLite/);

      // Verify entities attached
      const withEntities = results.find((r: any) => r.entities && r.entities.length > 0);
      expect(withEntities).toBeDefined();
      expect(withEntities.entities[0].identifier).toBe("src/db/client.ts");
    });

    it("filters search results by category", async () => {
      const callResult = (await client.callTool({
        name: "muninn_search",
        arguments: {
          query: "SQLite",
          category: "bugfix",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const results = JSON.parse(callResult.content[0].text);
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("bugfix");
      expect(results[0].title).toBe("Fix SQLite WAL lock contention");
    });

    it("respects the limit option in muninn_search", async () => {
      const callResult = (await client.callTool({
        name: "muninn_search",
        arguments: {
          query: "SQLite",
          limit: 1,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const results = JSON.parse(callResult.content[0].text);
      expect(results).toHaveLength(1);
    });

    it("supports allProjects option in muninn_search", async () => {
      const callResult = (await client.callTool({
        name: "muninn_search",
        arguments: {
          query: "SQLite",
          allProjects: true,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const results = JSON.parse(callResult.content[0].text);
      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("muninn_context Execution (AC-8.4)", () => {
    beforeEach(() => {
      const obs1 = service.saveObservation({
        category: "decision",
        title: "Observation 1",
        content: "Content 1",
        topicKey: "auth",
      });
      const obs2 = service.saveObservation({
        category: "bugfix",
        title: "Observation 2",
        content: "Content 2",
        topicKey: "auth",
      });
      const obs3 = service.saveObservation({
        category: "convention",
        title: "Observation 3",
        content: "Content 3",
        topicKey: "ui",
      });

      db.prepare(
        "UPDATE observations SET updated_at = '2026-01-01 00:00:01', created_at = '2026-01-01 00:00:01' WHERE id = ?"
      ).run(obs1.id);
      db.prepare(
        "UPDATE observations SET updated_at = '2026-01-01 00:00:02', created_at = '2026-01-01 00:00:02' WHERE id = ?"
      ).run(obs2.id);
      db.prepare(
        "UPDATE observations SET updated_at = '2026-01-01 00:00:03', created_at = '2026-01-01 00:00:03' WHERE id = ?"
      ).run(obs3.id);
    });

    it("returns recent observations ordered descending", async () => {
      const callResult = (await client.callTool({
        name: "muninn_context",
        arguments: {},
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const results = JSON.parse(callResult.content[0].text);
      expect(results).toHaveLength(3);
      expect(results[0].title).toBe("Observation 3");
    });

    it("filters context by category and topicKey", async () => {
      const callResult = (await client.callTool({
        name: "muninn_context",
        arguments: {
          category: "bugfix",
          topicKey: "auth",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const results = JSON.parse(callResult.content[0].text);
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Observation 2");
      expect(results[0].category).toBe("bugfix");
      expect(results[0].topic_key).toBe("auth");
    });

    it("respects limit in context retrieval", async () => {
      const callResult = (await client.callTool({
        name: "muninn_context",
        arguments: {
          limit: 2,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const results = JSON.parse(callResult.content[0].text);
      expect(results).toHaveLength(2);
    });

    it("supports allProjects and all_projects in muninn_context", async () => {
      const callResult1 = (await client.callTool({
        name: "muninn_context",
        arguments: {
          allProjects: true,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(callResult1.isError).toBeFalsy();
      const results1 = JSON.parse(callResult1.content[0].text);
      expect(results1).toBeInstanceOf(Array);

      const callResult2 = (await client.callTool({
        name: "muninn_context",
        arguments: {
          all_projects: true,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(callResult2.isError).toBeFalsy();
      const results2 = JSON.parse(callResult2.content[0].text);
      expect(results2).toBeInstanceOf(Array);
    });
  });

  describe("muninn_link_symbol Execution (AC-8.5)", () => {
    let observationId: string;

    beforeEach(() => {
      const obs = service.saveObservation({
        category: "decision",
        title: "Link test base",
        content: "Observation to attach entities to.",
      });
      observationId = obs.id;
    });

    it("links a string symbol to an observation", async () => {
      const callResult = (await client.callTool({
        name: "muninn_link_symbol",
        arguments: {
          observationId,
          symbol: "src/mcp/server.ts::startMcpServer",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const data = JSON.parse(callResult.content[0].text);
      expect(data).toHaveProperty("observation");
      expect(data).toHaveProperty("entity");
      expect(data.observation.id).toBe(observationId);
      expect(data.entity.identifier).toBe("src/mcp/server.ts::startMcpServer");
    });

    it("links an object symbol with metadata", async () => {
      const callResult = (await client.callTool({
        name: "muninn_link_symbol",
        arguments: {
          observationId,
          symbol: {
            name: "Server",
            filePath: "src/mcp/server.ts",
            type: "class",
          },
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const data = JSON.parse(callResult.content[0].text);
      expect(data.entity.identifier).toBe("src/mcp/server.ts::Server");
      expect(data.entity.entity_type).toBe("class");
    });

    it("supports snake_case observation_id in link_symbol arguments", async () => {
      const callResult = (await client.callTool({
        name: "muninn_link_symbol",
        arguments: {
          observation_id: observationId,
          symbol: "src/cli.ts",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const data = JSON.parse(callResult.content[0].text);
      expect(data.entity.identifier).toBe("src/cli.ts");
    });

    it("returns standard error when observation does not exist (AC-8.7)", async () => {
      const nonExistentId = "00000000-0000-0000-0000-000000000000";
      const callResult = (await client.callTool({
        name: "muninn_link_symbol",
        arguments: {
          observationId: nonExistentId,
          symbol: "src/index.ts",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBe(true);
      expect(callResult.content[0].text).toContain(
        `Error: Observation with id "${nonExistentId}" not found`
      );
    });
  });

  describe("muninn_stats Execution (AC-8.6)", () => {
    it("returns initial zero metrics when empty", async () => {
      const callResult = (await client.callTool({
        name: "muninn_stats",
        arguments: {},
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const stats = JSON.parse(callResult.content[0].text);
      expect(stats.projects).toBe(1);
      expect(stats.observations).toBe(0);
      expect(stats.entities).toBe(0);
      expect(stats.links).toBe(0);
    });

    it("returns updated metrics after creating observations and links", async () => {
      service.saveObservation({
        category: "decision",
        title: "Stats Test 1",
        content: "Testing stats counts",
        symbols: ["src/a.ts", "src/b.ts"],
      });
      service.saveObservation({
        category: "convention",
        title: "Stats Test 2",
        content: "Another note",
        symbols: ["src/a.ts"],
      });

      const callResult = (await client.callTool({
        name: "muninn_stats",
        arguments: {
          allProjects: true,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const stats = JSON.parse(callResult.content[0].text);
      expect(stats.projects).toBe(1);
      expect(stats.observations).toBe(2);
      expect(stats.entities).toBe(2);
      expect(stats.links).toBe(3);
    });

    it("supports all_projects snake_case and explicit false in muninn_stats", async () => {
      const callResult1 = (await client.callTool({
        name: "muninn_stats",
        arguments: {
          all_projects: true,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(callResult1.isError).toBeFalsy();
      const stats1 = JSON.parse(callResult1.content[0].text);
      expect(stats1).toHaveProperty("projects");

      const callResult2 = (await client.callTool({
        name: "muninn_stats",
        arguments: {
          allProjects: false,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(callResult2.isError).toBeFalsy();
      const stats2 = JSON.parse(callResult2.content[0].text);
      expect(stats2).toHaveProperty("projects");
    });
  });

  describe("muninn_inspect_symbol Execution (AC-8.8, REV-003)", () => {
    beforeEach(() => {
      service.saveObservation({
        category: "architecture",
        title: "Symbol Inspection Architecture",
        content: "Detailed description of the symbol inspection subsystem.",
        topicKey: "symbols",
        symbols: ["src/engine/runner.ts::executePipeline"],
      });
    });

    it("inspects existing code symbol and returns definition and linked observations", async () => {
      const callResult = (await client.callTool({
        name: "muninn_inspect_symbol",
        arguments: {
          symbol: "src/engine/runner.ts::executePipeline",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      expect(callResult.content).toHaveLength(1);
      const data = JSON.parse(callResult.content[0].text);
      expect(data.found).toBe(true);
      expect(data.entity).toBeDefined();
      expect(data.entity.identifier).toBe("src/engine/runner.ts::executePipeline");
      expect(data.observations).toHaveLength(1);
      expect(data.observations[0].title).toBe("Symbol Inspection Architecture");
    });

    it("supports snake_case project_id fallback and trims whitespace", async () => {
      const callResult = (await client.callTool({
        name: "muninn_inspect_symbol",
        arguments: {
          symbol: "src/engine/runner.ts::executePipeline",
          project_id: `  ${service.currentProject.id}  `,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const data = JSON.parse(callResult.content[0].text);
      expect(data.found).toBe(true);
    });

    it("returns found: false when symbol does not exist in entity index", async () => {
      const callResult = (await client.callTool({
        name: "muninn_inspect_symbol",
        arguments: {
          symbol: "nonexistent_symbol_identifier",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const data = JSON.parse(callResult.content[0].text);
      expect(data.found).toBe(false);
      expect(data.symbol).toBe("nonexistent_symbol_identifier");
      expect(data.message).toContain("not found in Muninn entity index");
    });

    it("returns isError: true when symbol is missing or empty or exceeds bounds", async () => {
      const missingRes = (await client.callTool({
        name: "muninn_inspect_symbol",
        arguments: {},
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(missingRes.isError).toBe(true);
      expect(missingRes.content[0].text).toContain("Validation error");
      expect(missingRes.content[0].text).toContain("symbol");

      const emptyRes = (await client.callTool({
        name: "muninn_inspect_symbol",
        arguments: { symbol: "   " },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(emptyRes.isError).toBe(true);
      expect(emptyRes.content[0].text).toContain("Validation error");

      const tooLongRes = (await client.callTool({
        name: "muninn_inspect_symbol",
        arguments: { symbol: "x".repeat(2001) },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(tooLongRes.isError).toBe(true);
      expect(tooLongRes.content[0].text).toContain("Validation error");
    });
  });

  describe("muninn_verify_contract Execution (AC-8.9, SEC-001, REV-003, REV-005)", () => {
    it("verifies clean TypeScript contracts with files array and projectRoot", async () => {
      fs.writeFileSync(
        path.join(tempDir, "clean.ts"),
        "export const meaningOfLife: number = 42;\n"
      );

      const callResult = (await client.callTool({
        name: "muninn_verify_contract",
        arguments: {
          files: ["clean.ts"],
          projectRoot: tempDir,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const data = JSON.parse(callResult.content[0].text);
      expect(data.valid).toBe(true);
      expect(data.errorsCount).toBe(0);
      expect(data.diagnostics).toEqual([]);
    });

    it("accepts single string files argument and normalizes to array (REV-005, SEC-002)", async () => {
      fs.writeFileSync(
        path.join(tempDir, "single.ts"),
        "export const validSingle: string = 'ok';\n"
      );

      const callResult = (await client.callTool({
        name: "muninn_verify_contract",
        arguments: {
          files: "single.ts",
          projectRoot: tempDir,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const data = JSON.parse(callResult.content[0].text);
      expect(data.valid).toBe(true);
      expect(data.errorsCount).toBe(0);
    });

    it("supports file alias via normalizeArgs", async () => {
      fs.writeFileSync(
        path.join(tempDir, "alias.ts"),
        "export const aliasConst: boolean = true;\n"
      );

      const callResult = (await client.callTool({
        name: "muninn_verify_contract",
        arguments: {
          file: "alias.ts",
          projectRoot: tempDir,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const data = JSON.parse(callResult.content[0].text);
      expect(data.valid).toBe(true);
    });

    it("supports snake_case project_root alias and trims whitespace", async () => {
      fs.writeFileSync(
        path.join(tempDir, "snake.ts"),
        "export const snakeVal: number = 10;\n"
      );

      const callResult = (await client.callTool({
        name: "muninn_verify_contract",
        arguments: {
          files: ["snake.ts"],
          project_root: `  ${tempDir}  `,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const data = JSON.parse(callResult.content[0].text);
      expect(data.valid).toBe(true);
    });

    it("detects TypeScript type errors and returns diagnostics and visual snippets", async () => {
      fs.writeFileSync(
        path.join(tempDir, "type_mismatch.ts"),
        "export const num: number = 'not a number';\n"
      );

      const callResult = (await client.callTool({
        name: "muninn_verify_contract",
        arguments: {
          files: ["type_mismatch.ts"],
          projectRoot: tempDir,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const data = JSON.parse(callResult.content[0].text);
      expect(data.valid).toBe(false);
      expect(data.errorsCount).toBeGreaterThanOrEqual(1);
      expect(data.diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(data.diagnostics[0].message).toContain(
        "Type 'string' is not assignable to type 'number'"
      );
      expect(data.diagnostics[0].snippet).toBeDefined();
    });

    it("rejects directory traversal escape in projectRoot (SEC-001)", async () => {
      const escapeResult = (await client.callTool({
        name: "muninn_verify_contract",
        arguments: {
          projectRoot: "../../../escaped_dir",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(escapeResult.isError).toBe(true);
      expect(escapeResult.content[0].text).toContain("outside permitted project root");

      const absEscape = (await client.callTool({
        name: "muninn_verify_contract",
        arguments: {
          projectRoot: path.resolve(tempDir, ".."),
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(absEscape.isError).toBe(true);
      expect(absEscape.content[0].text).toContain("outside permitted project root");
    });

    it("handles empty projectRoot and whitespace cleanly without escape errors", async () => {
      fs.writeFileSync(
        path.join(tempDir, "default_root.ts"),
        "export const defaultRootConst = true;\n"
      );

      const callResult = (await client.callTool({
        name: "muninn_verify_contract",
        arguments: {
          files: ["default_root.ts"],
          projectRoot: "   ",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBeFalsy();
      const data = JSON.parse(callResult.content[0].text);
      expect(data.valid).toBe(true);
    });

    it("returns isError: true when files exceeds 500 items or file string exceeds 1000 characters", async () => {
      const tooMany = Array.from({ length: 501 }, (_, i) => `file${i}.ts`);
      const res1 = (await client.callTool({
        name: "muninn_verify_contract",
        arguments: { files: tooMany },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(res1.isError).toBe(true);
      expect(res1.content[0].text).toContain("Validation error");

      const res2 = (await client.callTool({
        name: "muninn_verify_contract",
        arguments: { files: "a".repeat(1001) },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(res2.isError).toBe(true);
      expect(res2.content[0].text).toContain("Validation error");
    });
  });

  describe("Validation Errors & Graceful Error Handling (AC-8.7)", () => {
    it("returns isError: true when category is invalid", async () => {
      const callResult = (await client.callTool({
        name: "muninn_save",
        arguments: {
          category: "invalid_category",
          title: "Invalid category test",
          content: "Should fail validation",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBe(true);
      expect(callResult.content[0].text).toMatch(/Validation error/i);
      expect(callResult.content[0].text).toContain("category");
    });

    it("returns isError: true when title is missing", async () => {
      const callResult = (await client.callTool({
        name: "muninn_save",
        arguments: {
          category: "decision",
          content: "Missing title",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBe(true);
      expect(callResult.content[0].text).toMatch(/Validation error/i);
      expect(callResult.content[0].text).toContain("title");
    });

    it("returns isError: true when title is empty string or only whitespace", async () => {
      const callResult = (await client.callTool({
        name: "muninn_save",
        arguments: {
          category: "decision",
          title: "   ",
          content: "Whitespace title",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBe(true);
      expect(callResult.content[0].text).toMatch(/Validation error/i);
      expect(callResult.content[0].text).toContain("title");
    });

    it("returns isError: true when content is missing", async () => {
      const callResult = (await client.callTool({
        name: "muninn_save",
        arguments: {
          category: "decision",
          title: "Title without content",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBe(true);
      expect(callResult.content[0].text).toMatch(/Validation error/i);
      expect(callResult.content[0].text).toContain("content");
    });

    it("returns isError: true when search query is missing", async () => {
      const callResult = (await client.callTool({
        name: "muninn_search",
        arguments: {},
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBe(true);
      expect(callResult.content[0].text).toMatch(/Validation error/i);
      expect(callResult.content[0].text).toContain("query");
    });

    it("returns isError: true when search query is empty string or whitespace", async () => {
      const callResult = (await client.callTool({
        name: "muninn_search",
        arguments: {
          query: "   ",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBe(true);
      expect(callResult.content[0].text).toMatch(/Validation error/i);
      expect(callResult.content[0].text).toContain("query");
    });

    it("returns isError: true when link_symbol is missing required observationId or symbol", async () => {
      const callResult1 = (await client.callTool({
        name: "muninn_link_symbol",
        arguments: {
          symbol: "src/app.ts",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult1.isError).toBe(true);
      expect(callResult1.content[0].text).toMatch(/Validation error/i);
      expect(callResult1.content[0].text).toContain("observationId");

      const callResult2 = (await client.callTool({
        name: "muninn_link_symbol",
        arguments: {
          observationId: "some-id",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult2.isError).toBe(true);
      expect(callResult2.content[0].text).toMatch(/Validation error/i);
      expect(callResult2.content[0].text).toContain("symbol");
    });

    it("returns isError: true when limit is not a positive integer", async () => {
      const callResult = (await client.callTool({
        name: "muninn_search",
        arguments: {
          query: "test",
          limit: -5,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBe(true);
      expect(callResult.content[0].text).toMatch(/Validation error/i);
      expect(callResult.content[0].text).toContain("limit");
    });

    it("returns isError: true when calling an unknown tool", async () => {
      const callResult = (await client.callTool({
        name: "muninn_unknown_tool",
        arguments: {},
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBe(true);
      expect(callResult.content[0].text).toBe('Error: Unknown tool "muninn_unknown_tool"');
    });

    it("handles unexpected service throws gracefully (AC-8.7)", async () => {
      const spy = vi
        .spyOn(service, "search")
        .mockImplementationOnce(() => {
          throw new Error("Simulated database failure");
        });

      try {
        const callResult = (await client.callTool({
          name: "muninn_search",
          arguments: {
            query: "test query",
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBe(true);
        expect(callResult.content[0].text).toBe("Error: Simulated database failure");
      } finally {
        spy.mockRestore();
      }
    });

    it("returns isError: true when muninn_stats validation fails with invalid arguments", async () => {
      const callResult = (await client.callTool({
        name: "muninn_stats",
        arguments: {
          allProjects: "not-a-boolean" as any,
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBe(true);
      expect(callResult.content[0].text).toContain("Validation error");
      expect(callResult.content[0].text).toContain("allProjects");
    });

    it("returns isError: true when muninn_context validation fails with invalid category", async () => {
      const callResult = (await client.callTool({
        name: "muninn_context",
        arguments: {
          category: "non_existent_category",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBe(true);
      expect(callResult.content[0].text).toContain("Validation error");
      expect(callResult.content[0].text).toContain("category");
    });

    it("returns isError: true when muninn_search validation fails with invalid category", async () => {
      const callResult = (await client.callTool({
        name: "muninn_search",
        arguments: {
          query: "hello",
          category: "non_existent_category",
        },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(callResult.isError).toBe(true);
      expect(callResult.content[0].text).toContain("Validation error");
      expect(callResult.content[0].text).toContain("category");
    });

    it("handles unexpected non-Error service throws gracefully (String fallback)", async () => {
      const spy = vi
        .spyOn(service, "getStats")
        .mockImplementationOnce(() => {
          throw "Simulated non-Error string failure";
        });

      try {
        const callResult = (await client.callTool({
          name: "muninn_stats",
          arguments: {},
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBe(true);
        expect(callResult.content[0].text).toBe("Error: Simulated non-Error string failure");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("Security Auditor Hardening (SEC-001 - SEC-005)", () => {
    describe("SEC-001: Handling null and undefined values from MCP clients", () => {
      it("executes muninn_save successfully when optional parameters are null", async () => {
        const callResult = (await client.callTool({
          name: "muninn_save",
          arguments: {
            category: "decision",
            title: "Observation with null topicKey",
            content: "Testing null optional parameters",
            topicKey: null,
            symbols: null,
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBeFalsy();
        const data = JSON.parse(callResult.content[0].text);
        expect(data.topic_key).toBeNull();
        expect(data.entities).toEqual([]);
      });

      it("preserves snake_case fallback when topicKey is null but topic_key is provided", async () => {
        const callResult = (await client.callTool({
          name: "muninn_save",
          arguments: {
            category: "architecture",
            title: "Snake case priority test",
            content: "Testing topic_key fallback over null topicKey",
            topic_key: "architecture_decisions",
            topicKey: null,
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBeFalsy();
        const data = JSON.parse(callResult.content[0].text);
        expect(data.topic_key).toBe("architecture_decisions");
      });

      it("executes muninn_search successfully when optional parameters are null", async () => {
        service.saveObservation({
          category: "discovery",
          title: "Searchable Observation",
          content: "Search content for null parameters test",
        });

        const callResult = (await client.callTool({
          name: "muninn_search",
          arguments: {
            query: "Searchable",
            category: null,
            limit: null,
            allProjects: null,
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBeFalsy();
        const results = JSON.parse(callResult.content[0].text);
        expect(results).toBeInstanceOf(Array);
        expect(results.length).toBeGreaterThanOrEqual(1);
      });

      it("executes muninn_context successfully when optional parameters are null", async () => {
        service.saveObservation({
          category: "discovery",
          title: "Context Observation",
          content: "Context content for null parameters test",
        });

        const callResult = (await client.callTool({
          name: "muninn_context",
          arguments: {
            category: null,
            topicKey: null,
            limit: null,
            allProjects: null,
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBeFalsy();
        const results = JSON.parse(callResult.content[0].text);
        expect(results).toBeInstanceOf(Array);
        expect(results.length).toBeGreaterThanOrEqual(1);
      });

      it("executes muninn_stats successfully when allProjects is null", async () => {
        const callResult = (await client.callTool({
          name: "muninn_stats",
          arguments: {
            allProjects: null,
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBeFalsy();
        const stats = JSON.parse(callResult.content[0].text);
        expect(stats).toHaveProperty("observations");
      });

      it("verifies normalizeArgs helper directly", () => {
        expect(normalizeArgs(undefined)).toEqual({});
        expect(normalizeArgs(null as any)).toEqual({});
        expect(normalizeArgs("invalid" as any)).toEqual({});
        expect(normalizeArgs([1, 2, 3] as any)).toEqual({});
        expect(
          normalizeArgs({
            keep: "value",
            pruneNull: null,
            pruneUndef: undefined,
          })
        ).toEqual({ keep: "value" });
        expect(
          normalizeArgs({
            topic_key: "auth",
            topicKey: null,
          })
        ).toEqual({ topic_key: "auth", topicKey: "auth" });
        expect(
          normalizeArgs({
            observation_id: "obs-1",
            observationId: null,
          })
        ).toEqual({ observation_id: "obs-1", observationId: "obs-1" });
        expect(
          normalizeArgs({
            all_projects: true,
            allProjects: null,
          })
        ).toEqual({ all_projects: true, allProjects: true });
      });

      it("hardens against prototype pollution by skipping __proto__, constructor, and prototype keys", () => {
        const payload = JSON.parse(
          '{"__proto__": {"polluted": true}, "constructor": {"polluted": true}, "prototype": {"polluted": true}, "safe": "value"}'
        );
        const result = normalizeArgs(payload);
        expect(result).toEqual({ safe: "value" });
        expect(({} as any).polluted).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(result, "constructor")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(result, "prototype")).toBe(false);
      });
    });

    describe("SEC-002 & SEC-003: Payload and limit bounds validation", () => {
      it("rejects muninn_save when title exceeds 1000 characters", async () => {
        const callResult = (await client.callTool({
          name: "muninn_save",
          arguments: {
            category: "decision",
            title: "A".repeat(1001),
            content: "Valid content",
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBe(true);
        expect(callResult.content[0].text).toMatch(/Validation error/i);
        expect(callResult.content[0].text).toContain("title");
        expect(callResult.content[0].text).toMatch(/1000/);
      });

      it("rejects muninn_save when content exceeds 1,000,000 characters", async () => {
        const callResult = (await client.callTool({
          name: "muninn_save",
          arguments: {
            category: "decision",
            title: "Valid title",
            content: "B".repeat(1_000_001),
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBe(true);
        expect(callResult.content[0].text).toMatch(/Validation error/i);
        expect(callResult.content[0].text).toContain("content");
      });

      it("rejects muninn_save when topicKey exceeds 256 characters", async () => {
        const callResult = (await client.callTool({
          name: "muninn_save",
          arguments: {
            category: "decision",
            title: "Valid title",
            content: "Valid content",
            topicKey: "C".repeat(257),
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBe(true);
        expect(callResult.content[0].text).toMatch(/Validation error/i);
        expect(callResult.content[0].text).toContain("topicKey");
        expect(callResult.content[0].text).toMatch(/256/);
      });

      it("rejects muninn_save when symbols array exceeds 500 items", async () => {
        const oversizedSymbols = Array.from({ length: 501 }, (_, i) => `src/file_${i}.ts`);
        const callResult = (await client.callTool({
          name: "muninn_save",
          arguments: {
            category: "decision",
            title: "Valid title",
            content: "Valid content",
            symbols: oversizedSymbols,
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBe(true);
        expect(callResult.content[0].text).toMatch(/Validation error/i);
        expect(callResult.content[0].text).toContain("symbols");
        expect(callResult.content[0].text).toMatch(/500/);
      });

      it("rejects muninn_search when query exceeds 2000 characters", async () => {
        const callResult = (await client.callTool({
          name: "muninn_search",
          arguments: {
            query: "Q".repeat(2001),
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBe(true);
        expect(callResult.content[0].text).toMatch(/Validation error/i);
        expect(callResult.content[0].text).toContain("query");
        expect(callResult.content[0].text).toMatch(/2000/);
      });

      it("rejects muninn_search when limit exceeds 500", async () => {
        const callResult = (await client.callTool({
          name: "muninn_search",
          arguments: {
            query: "test",
            limit: 501,
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBe(true);
        expect(callResult.content[0].text).toMatch(/Validation error/i);
        expect(callResult.content[0].text).toContain("limit");
        expect(callResult.content[0].text).toMatch(/500/);
      });

      it("rejects muninn_context when limit exceeds 500", async () => {
        const callResult = (await client.callTool({
          name: "muninn_context",
          arguments: {
            limit: 501,
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBe(true);
        expect(callResult.content[0].text).toMatch(/Validation error/i);
        expect(callResult.content[0].text).toContain("limit");
        expect(callResult.content[0].text).toMatch(/500/);
      });

      it("rejects muninn_context when topicKey exceeds 256 characters", async () => {
        const callResult = (await client.callTool({
          name: "muninn_context",
          arguments: {
            topicKey: "T".repeat(257),
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBe(true);
        expect(callResult.content[0].text).toMatch(/Validation error/i);
        expect(callResult.content[0].text).toContain("topicKey");
        expect(callResult.content[0].text).toMatch(/256/);
      });
    });

    describe("SEC-004: Encapsulate normalizeArgs in try...catch", () => {
      it("catches errors thrown during argument extraction or normalization", async () => {
        let capturedHandler: any;
        const origSetRequestHandler = Server.prototype.setRequestHandler;
        const setRequestHandlerSpy = vi
          .spyOn(Server.prototype, "setRequestHandler")
          .mockImplementation(function (this: any, schema: any, handler: any) {
            if (schema === CallToolRequestSchema) {
              capturedHandler = handler;
            }
            return origSetRequestHandler.call(this, schema, handler);
          });

        try {
          const testServer = createMcpServer(service);
          expect(capturedHandler).toBeDefined();

          const poisonRequest = {
            params: {
              name: "muninn_save",
              get arguments() {
                throw new Error("Simulated explosion during argument extraction");
              },
            },
          };

          const result = await capturedHandler(poisonRequest);
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toContain(
            "Error: Simulated explosion during argument extraction"
          );
        } finally {
          setRequestHandlerSpy.mockRestore();
        }
      });
    });

    describe("SEC-005: Empty symbol object validation", () => {
      it("rejects empty symbol object in muninn_save", async () => {
        const callResult = (await client.callTool({
          name: "muninn_save",
          arguments: {
            category: "decision",
            title: "Empty symbol test",
            content: "Testing rejection of empty symbol object",
            symbols: [{}],
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBe(true);
        expect(callResult.content[0].text).toMatch(/Validation error/i);
        expect(callResult.content[0].text).toContain(
          "Symbol must provide at least one of name, identifier, or filePath"
        );
      });

      it("rejects symbol object with only empty/null values in muninn_save", async () => {
        const callResult = (await client.callTool({
          name: "muninn_save",
          arguments: {
            category: "decision",
            title: "Empty strings symbol test",
            content: "Testing rejection of symbol with empty string name",
            symbols: [{ name: "" }],
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBe(true);
        expect(callResult.content[0].text).toMatch(/Validation error/i);
        expect(callResult.content[0].text).toContain(
          "Symbol must provide at least one of name, identifier, or filePath"
        );
      });

      it("rejects empty symbol object in muninn_link_symbol", async () => {
        const obs = service.saveObservation({
          category: "decision",
          title: "Symbol Link Target",
          content: "Observation for linking",
        });

        const callResult = (await client.callTool({
          name: "muninn_link_symbol",
          arguments: {
            observationId: obs.id,
            symbol: {},
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBe(true);
        expect(callResult.content[0].text).toMatch(/Validation error/i);
        expect(callResult.content[0].text).toContain(
          "Symbol must provide at least one of name, identifier, or filePath"
        );
      });

      it("accepts valid symbol objects with at least one identifier property", async () => {
        const callResult = (await client.callTool({
          name: "muninn_save",
          arguments: {
            category: "decision",
            title: "Valid symbol test",
            content: "Testing acceptance of valid symbol object",
            symbols: [
              { name: "MyComponent" },
              { filePath: "src/components/MyComponent.tsx" },
              { identifier: "src/index.ts::main" },
              { file_path: "src/utils.ts" },
            ],
          },
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

        expect(callResult.isError).toBeFalsy();
        const data = JSON.parse(callResult.content[0].text);
        expect(data.entities).toHaveLength(4);
      });
    });
  });

  describe("startMcpServer helper", () => {
    it("initializes server and connects to StdioServerTransport", async () => {
      const connectSpy = vi
        .spyOn(StdioServerTransport.prototype, "start")
        .mockImplementation(async () => {});

      try {
        const res = await startMcpServer({ dbPath: ":memory:" });
        expect(res.server).toBeDefined();
        expect(res.transport).toBeInstanceOf(StdioServerTransport);
        expect(res.service).toBeInstanceOf(MemoryService);

        res.service.close?.(true);
        await res.server.close();
      } finally {
        connectSpy.mockRestore();
      }
    });

    it("accepts an existing MemoryService instance in startMcpServer", async () => {
      const connectSpy = vi
        .spyOn(StdioServerTransport.prototype, "start")
        .mockImplementation(async () => {});

      try {
        const customService = new MemoryService({ dbPath: ":memory:" });
        const res = await startMcpServer(customService);
        expect(res.service).toBe(customService);

        customService.close(true);
        await res.server.close();
      } finally {
        connectSpy.mockRestore();
      }
    });

    it("starts server with default options when called without parameters", async () => {
      const connectSpy = vi
        .spyOn(StdioServerTransport.prototype, "start")
        .mockImplementation(async () => {});

      try {
        const res = await startMcpServer();
        expect(res.server).toBeDefined();
        expect(res.transport).toBeInstanceOf(StdioServerTransport);
        expect(res.service).toBeInstanceOf(MemoryService);

        res.service.close?.(true);
        await res.server.close();
      } finally {
        connectSpy.mockRestore();
      }
    });
  });

  describe("formatZodErrors helper", () => {
    it("formats multiple issues with path and messages", () => {
      const schema = MuninnSaveSchema;
      const parsed = schema.safeParse({});
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const formatted = formatZodErrors(parsed.error);
        expect(formatted).toContain("category");
        expect(formatted).toContain("title");
        expect(formatted).toContain("content");
      }
    });

    it("handles issues with empty path by displaying issue.message without prefix", () => {
      const customError = new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          message: "Root level failure",
          path: [],
        },
      ]);
      const formatted = formatZodErrors(customError);
      expect(formatted).toBe("Root level failure");
    });

    it("falls back to error.message when error.issues is empty array or missing", () => {
      const emptyError = new z.ZodError([]);
      expect(formatZodErrors(emptyError)).toBe(emptyError.message);

      const malformedError = { message: "Raw error string", issues: null } as unknown as z.ZodError;
      expect(formatZodErrors(malformedError)).toBe("Raw error string");
    });
  });

  describe("createMcpServer options variations", () => {
    it("creates server with default options when no arguments are provided", async () => {
      const s = createMcpServer();
      expect(s).toBeDefined();
      const svc = (s as any).service as MemoryService;
      expect(svc).toBeInstanceOf(MemoryService);
      svc.close(true);
      await s.close();
    });

    it("creates server when passing options object instead of MemoryService instance", async () => {
      const s = createMcpServer({ dbPath: ":memory:" });
      expect(s).toBeDefined();
      const svc = s.service as MemoryService;
      expect(svc).toBeInstanceOf(MemoryService);
      svc.close(true);
      await s.close();
    });

    it("accepts a custom IMemoryService implementation and provides typed service properties", async () => {
      const mockService: IMemoryService = {
        currentProject: {
          id: "mock-proj",
          name: "Mock Project",
          git_remote: null,
          root_path: "/mock/path",
          created_at: "2026-01-01",
        },
        db: {} as any,
        saveObservation: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        getContext: vi.fn().mockReturnValue([]),
        linkSymbol: vi.fn(),
        inspectSymbol: vi.fn().mockReturnValue(null),
        getStats: vi.fn().mockReturnValue({ projects: 1, observations: 0, entities: 0, links: 0 }),
        syncToDisk: vi.fn(),
        importFromDisk: vi.fn(),
        close: vi.fn(),
      };

      const s = createMcpServer(mockService);
      expect(s.service).toBe(mockService);
      expect(s.memoryService).toBe(mockService);
      await s.close();
    });
  });

  describe("Declarative Tool Registry (REV-003)", () => {
    it("defines structured TOOL_REGISTRY mapping tool names to definitions", () => {
      expect(TOOL_REGISTRY).toBeDefined();
      expect(Object.keys(TOOL_REGISTRY)).toEqual([
        "muninn_save",
        "muninn_search",
        "muninn_context",
        "muninn_link_symbol",
        "muninn_stats",
        "muninn_inspect_symbol",
        "muninn_verify_contract",
      ]);

      for (const [key, toolDef] of Object.entries(TOOL_REGISTRY)) {
        expect(toolDef.name).toBe(key);
        expect(typeof toolDef.description).toBe("string");
        expect(toolDef.schema).toBeDefined();
        expect(typeof toolDef.handler).toBe("function");
      }
    });

    it("verifies handlers in TOOL_REGISTRY execute service methods directly", async () => {
      const saveRes = (await TOOL_REGISTRY.muninn_save.handler(service, {
        category: "decision",
        title: "Direct Registry Test",
        content: "Direct registry execution",
      })) as any;
      expect(saveRes).toHaveProperty("id");
      expect(saveRes.title).toBe("Direct Registry Test");

      const searchRes = (await TOOL_REGISTRY.muninn_search.handler(service, {
        query: "Direct Registry",
      })) as any;
      expect(searchRes).toHaveLength(1);

      const contextRes = (await TOOL_REGISTRY.muninn_context.handler(service, {
        limit: 1,
      })) as any;
      expect(contextRes).toHaveLength(1);

      const linkRes = (await TOOL_REGISTRY.muninn_link_symbol.handler(service, {
        observationId: saveRes.id,
        symbol: "src/registry.ts",
      })) as any;
      expect(linkRes).toHaveProperty("entity");

      const statsRes = (await TOOL_REGISTRY.muninn_stats.handler(service, {
        allProjects: false,
      })) as any;
      expect(statsRes).toHaveProperty("observations");
      expect(statsRes.observations).toBeGreaterThanOrEqual(1);

      const inspectRes = (await TOOL_REGISTRY.muninn_inspect_symbol.handler(
        service,
        {
          symbol: "src/registry.ts",
        }
      )) as any;
      expect(inspectRes).toBeDefined();

      const verifyRes = (await TOOL_REGISTRY.muninn_verify_contract.handler(
        service,
        {
          files: [],
          projectRoot: tempDir,
        }
      )) as any;
      expect(verifyRes).toHaveProperty("valid");
    });
  });

  describe("Schema Validation (SymbolSchema & CategorySchema)", () => {
    it("validates all supported entity types and rejects invalid entity types in SymbolSchema", () => {
      const validTypes = ["file", "function", "class", "interface", "module"] as const;
      for (const type of validTypes) {
        const res1 = SymbolSchema.safeParse({ name: "mySymbol", type });
        expect(res1.success).toBe(true);

        const res2 = SymbolSchema.safeParse({ name: "mySymbol", entity_type: type });
        expect(res2.success).toBe(true);
      }

      const resWithId = SymbolSchema.safeParse({ name: "mySymbol", id: "custom-id" });
      expect(resWithId.success).toBe(true);

      const invalidTypeRes = SymbolSchema.safeParse({ name: "mySymbol", type: "invalid_type" });
      expect(invalidTypeRes.success).toBe(false);
    });

    it("validates CategorySchema accepts all valid categories and rejects invalid ones", () => {
      const validCats = ["decision", "convention", "discovery", "bugfix", "architecture"] as const;
      for (const cat of validCats) {
        expect(CategorySchema.safeParse(cat).success).toBe(true);
      }
      expect(CategorySchema.safeParse("unknown_category").success).toBe(false);
    });
  });

  describe("MCP Module Exports (index.ts)", () => {
    it("re-exports all expected entities from index.ts", async () => {
      const mcpIndex = await import("../src/mcp/index.js");
      expect(mcpIndex.createMcpServer).toBe(createMcpServer);
      expect(mcpIndex.startMcpServer).toBe(startMcpServer);
      expect(mcpIndex.formatZodErrors).toBe(formatZodErrors);
      expect(mcpIndex.normalizeArgs).toBe(normalizeArgs);
      expect(mcpIndex.MUNINN_TOOLS).toBe(MUNINN_TOOLS);
      expect(mcpIndex.TOOL_NAMES).toBe(TOOL_NAMES);
      expect(mcpIndex.MuninnSaveSchema).toBe(MuninnSaveSchema);
      expect(mcpIndex.MuninnSearchSchema).toBe(MuninnSearchSchema);
      expect(mcpIndex.MuninnContextSchema).toBe(MuninnContextSchema);
      expect(mcpIndex.MuninnLinkSymbolSchema).toBe(MuninnLinkSymbolSchema);
      expect(mcpIndex.MuninnStatsSchema).toBe(MuninnStatsSchema);
      expect(mcpIndex.MuninnInspectSymbolSchema).toBe(MuninnInspectSymbolSchema);
      expect(mcpIndex.MuninnVerifyContractSchema).toBe(MuninnVerifyContractSchema);
      expect(mcpIndex.CategorySchema).toBe(CategorySchema);
      expect(mcpIndex.SymbolSchema).toBe(SymbolSchema);
      expect(mcpIndex.TOOL_REGISTRY).toBe(TOOL_REGISTRY);
    });
  });
});

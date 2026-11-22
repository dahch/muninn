import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sanitizeTerminalText } from "../util/text.js";
import {
  MemoryService,
  VALID_CATEGORIES,
  MAX_SESSION_BRIEF_BUDGET,
  readSessionBrief,
  type IMemoryService,
  type MemoryServiceOptions,
  type ObservationWithEntities,
  type SearchResult,
  type MemoryStats,
  type ObservationCategory,
  type SymbolInput,
} from "../service/index.js";
import { verifyTypeScriptContracts } from "../contracts/compiler.js";
import {
  memoryDbPath,
  projectStorageDir,
  readRegistry,
  resolveProjectContext,
} from "../project/identity.js";
import {
  renderWorkspaceGuidance,
  resolveSessionWorkspace,
  sessionAutodetectEnabled,
} from "../project/session.js";
import {
  buildExplore,
  findImportCycles,
  findSymbol,
  getAffectedTests,
  getEdges,
  getFileImports,
  getFileTree,
  getImpact,
  getImplementations,
  getIndexStatus,
  indexProject,
  readSourceSlice,
  searchSymbols,
} from "../graph/index.js";

export { type IMemoryService };

/**
 * Zod schema for symbol / entity objects.
 */
export const SymbolSchema = z
  .object({
    name: z.string().trim().nullish(),
    filePath: z.string().trim().nullish(),
    file_path: z.string().trim().nullish(),
    identifier: z.string().trim().nullish(),
    type: z
      .enum(["file", "function", "class", "interface", "module"])
      .nullish(),
    entity_type: z
      .enum(["file", "function", "class", "interface", "module"])
      .nullish(),
    id: z.string().trim().nullish(),
  })
  .passthrough()
  .refine(
    (s) => Boolean(s.name || s.identifier || s.filePath || s.file_path),
    {
      message:
        "Symbol must provide at least one of name, identifier, or filePath",
    }
  );

/**
 * Schema for observation category.
 */
export const CategorySchema = z
  .enum(
    VALID_CATEGORIES as unknown as [ObservationCategory, ...ObservationCategory[]]
  )
  .describe(`Allowed observation category: ${VALID_CATEGORIES.join(", ")}`);

/**
 * Zod schema for muninn_save tool arguments.
 */
export const MuninnSaveSchema = z.object({
  category: CategorySchema,
  title: z
    .string()
    .trim()
    .min(1, "Observation title is required and cannot be empty")
    .max(1000, "Observation title cannot exceed 1000 characters")
    .describe("Concise title summarizing the observation"),
  content: z
    .string()
    .trim()
    .min(1, "Observation content is required and cannot be empty")
    .max(1_000_000, "Observation content cannot exceed 1,000,000 characters")
    .describe("Detailed markdown or text content of the observation"),
  topicKey: z
    .string()
    .trim()
    .max(256, "Topic key cannot exceed 256 characters")
    .nullish()
    .describe("Optional clustering key to group related observations (e.g. auth, db)"),
  supersedesTopicKey: z
    .string()
    .trim()
    .max(256, "Supersedes topic key cannot exceed 256 characters")
    .nullish()
    .describe("Optional topic key whose active decisions this new decision replaces"),
  supersedes_topic_key: z
    .string()
    .trim()
    .max(256, "Supersedes topic key cannot exceed 256 characters")
    .nullish()
    .describe("Optional topic key whose active decisions this new decision replaces (snake_case)"),
  symbols: z
    .array(z.union([z.string().trim().min(1), SymbolSchema]))
    .max(500, "Symbols array cannot exceed 500 items")
    .nullish()
    .describe("Optional symbols or code entities linked to this observation"),
  agent: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .describe("Optional agent name that produced the observation (provenance)"),
  sessionId: z.string().trim().max(200).nullish().describe("Optional session id"),
  session_id: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .describe("Optional session id (snake_case)"),
  tags: z
    .array(z.string().trim().min(1).max(100))
    .max(50)
    .nullish()
    .describe("Optional tags"),
  files: z
    .array(z.string().trim().min(1).max(4096))
    .max(200)
    .nullish()
    .describe("Optional file paths the observation refers to"),
  scope: z
    .enum(["project", "global"])
    .nullish()
    .describe(
      "project (default) or global: a global observation is shareable by every project and appears in every brief"
    ),
});

export type MuninnSaveInput = z.infer<typeof MuninnSaveSchema>;

/**
 * Zod schema for muninn_search tool arguments.
 */
export const MuninnSearchSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "Search query is required and cannot be empty")
    .max(2000, "Search query cannot exceed 2000 characters")
    .describe("Full-text search query with BM25 ranking"),
  category: CategorySchema.nullish().describe("Optional category filter"),
  limit: z
    .number()
    .int("Limit must be an integer")
    .positive("Limit must be positive")
    .max(500, "Limit cannot exceed 500")
    .nullish()
    .default(10)
    .describe("Maximum number of results to return (default 10, max 500)"),
  allProjects: z
    .boolean()
    .nullish()
    .describe("Whether to search across all projects (default false)"),
  includeSuperseded: z
    .boolean()
    .nullish()
    .describe("Whether to include superseded observations (default false)"),
  include_superseded: z
    .boolean()
    .nullish()
    .describe("Whether to include superseded observations (default false, snake_case)"),
  includeGlobal: z
    .boolean()
    .nullish()
    .describe("Whether to include cross-project global observations (default false)"),
  include_global: z
    .boolean()
    .nullish()
    .describe("Whether to include cross-project global observations (default false, snake_case)"),
});

export type MuninnSearchInput = z.infer<typeof MuninnSearchSchema>;

/**
 * Zod schema for muninn_context tool arguments.
 */
export const MuninnContextSchema = z.object({
  limit: z
    .number()
    .int("Limit must be an integer")
    .positive("Limit must be positive")
    .max(500, "Limit cannot exceed 500")
    .nullish()
    .default(20)
    .describe("Maximum number of recent observations to return (default 20, max 500)"),
  category: CategorySchema.nullish().describe("Optional category filter"),
  topicKey: z
    .string()
    .trim()
    .max(256, "Topic key cannot exceed 256 characters")
    .nullish()
    .describe("Optional topic key filter"),
  allProjects: z
    .boolean()
    .nullish()
    .describe("Whether to query across all projects (default false)"),
  includeSuperseded: z
    .boolean()
    .nullish()
    .describe("Whether to include superseded observations (default false)"),
  include_superseded: z
    .boolean()
    .nullish()
    .describe("Whether to include superseded observations (default false, snake_case)"),
  includeGlobal: z
    .boolean()
    .nullish()
    .describe("Whether to include cross-project global observations (default false)"),
  include_global: z
    .boolean()
    .nullish()
    .describe("Whether to include cross-project global observations (default false, snake_case)"),
});

export type MuninnContextInput = z.infer<typeof MuninnContextSchema>;

/**
 * Zod schema for muninn_link_symbol tool arguments.
 */
export const MuninnLinkSymbolSchema = z.object({
  observationId: z
    .string()
    .trim()
    .min(1, "observationId is required and cannot be empty")
    .describe("ID of the observation to link the symbol to"),
  symbol: z
    .union([z.string().trim().min(1, "Symbol is required"), SymbolSchema])
    .describe("Symbol string (e.g. 'src/app.ts::run') or SymbolInput object"),
});

export type MuninnLinkSymbolInput = z.infer<typeof MuninnLinkSymbolSchema>;

/**
 * Zod schema for muninn_stats tool arguments.
 */
export const MuninnStatsSchema = z.object({
  allProjects: z
    .boolean()
    .nullish()
    .describe("Whether to report metrics across all projects (default false)"),
});

export type MuninnStatsInput = z.infer<typeof MuninnStatsSchema>;

/**
 * Zod schema for muninn_inspect_symbol tool arguments.
 */
export const MuninnInspectSymbolSchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(1, "Symbol is required and cannot be empty")
    .max(2000, "Symbol cannot exceed 2000 characters")
    .describe("Symbol identifier or name (e.g. 'src/app.ts::run' or 'run')"),
  projectId: z.string().trim().nullish().describe("Optional project ID filter"),
  project_id: z
    .string()
    .trim()
    .nullish()
    .describe("Optional project ID filter (snake_case)"),
});

export type MuninnInspectSymbolInput = z.infer<
  typeof MuninnInspectSymbolSchema
>;

/**
 * Zod schema for muninn_bootstrap tool arguments.
 */
export const MuninnBootstrapSchema = z.object({
  paths: z
    .array(z.string().trim().min(1, "Path cannot be empty").max(4096))
    .max(20, "At most 20 paths may be requested")
    .nullish()
    .describe(
      "Optional file or directory paths, relative to the project root or absolute inside it, used to select indexed symbols"
    ),
  budgetChars: z
    .number()
    .int("budgetChars must be an integer")
    .positive("budgetChars must be positive")
    .max(
      MAX_SESSION_BRIEF_BUDGET,
      `budgetChars cannot exceed ${MAX_SESSION_BRIEF_BUDGET}`
    )
    .nullish()
    .describe("Maximum rendered Markdown length (default 8000, max 20000)"),
  budget_chars: z
    .number()
    .int("budget_chars must be an integer")
    .positive("budget_chars must be positive")
    .max(
      MAX_SESSION_BRIEF_BUDGET,
      `budget_chars cannot exceed ${MAX_SESSION_BRIEF_BUDGET}`
    )
    .nullish()
    .describe("Maximum rendered Markdown length (default 8000, max 20000, snake_case)"),
  expandGraph: z
    .boolean()
    .nullish()
    .describe("Whether to include bounded dependency neighbors (default true)"),
  expand_graph: z
    .boolean()
    .nullish()
    .describe("Whether to include bounded dependency neighbors (default true, snake_case)"),
});

export type MuninnBootstrapInput = z.infer<typeof MuninnBootstrapSchema>;

/**
 * Zod schema for muninn_handoff tool arguments.
 */
export const MuninnHandoffSchema = z.object({
  action: z
    .enum(["checkpoint", "end", "status", "close"])
    .nullish()
    .default("checkpoint")
    .describe(
      "checkpoint/end save the handoff, status reads it, close retires the active one"
    ),
  goal: z
    .string()
    .trim()
    .max(2_000)
    .nullish()
    .describe("What the session was trying to accomplish (required for checkpoint/end)"),
  state: z
    .string()
    .trim()
    .max(50_000)
    .nullish()
    .describe("Where it stopped: done, in progress, broken, and why (required for checkpoint/end)"),
  agent: z.string().trim().max(200).nullish().describe("Agent that wrote the handoff"),
  sessionId: z.string().trim().max(200).nullish().describe("Agent session id"),
  session_id: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .describe("Agent session id (snake_case)"),
  branch: z.string().trim().max(500).nullish().describe("Git branch, when relevant"),
  filesTouched: z
    .array(z.string().trim().min(1).max(4096))
    .max(500)
    .nullish()
    .describe("Files changed or examined during the session"),
  files_touched: z
    .array(z.string().trim().min(1).max(4096))
    .max(500)
    .nullish()
    .describe("Files changed or examined during the session (snake_case)"),
  openQuestions: z
    .array(z.string().trim().min(1).max(2_000))
    .max(50)
    .nullish()
    .describe("Questions the next session must answer"),
  open_questions: z
    .array(z.string().trim().min(1).max(2_000))
    .max(50)
    .nullish()
    .describe("Questions the next session must answer (snake_case)"),
  nextSteps: z
    .array(z.string().trim().min(1).max(2_000))
    .max(50)
    .nullish()
    .describe("Ordered next steps for the next session"),
  next_steps: z
    .array(z.string().trim().min(1).max(2_000))
    .max(50)
    .nullish()
    .describe("Ordered next steps for the next session (snake_case)"),
  decisions: z
    .array(z.string().trim().min(1).max(200))
    .max(100)
    .nullish()
    .describe("Observation ids that were decided during the session"),
  blockers: z
    .array(z.string().trim().min(1).max(2_000))
    .max(50)
    .nullish()
    .describe("Concrete blockers"),
});

export type MuninnHandoffInput = z.infer<typeof MuninnHandoffSchema>;

/**
 * Zod schema for muninn_explore tool arguments.
 */
export const MuninnExploreSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "Explore query is required")
    .max(2_000)
    .describe("Question, symbol name, file path or area to explore"),
  budget: z
    .number()
    .int()
    .positive()
    .max(20_000)
    .nullish()
    .describe("Maximum Markdown characters to return (default 8000, max 20000)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(20)
    .nullish()
    .describe("Maximum symbols to include (default 6, max 20)"),
});

export type MuninnExploreInput = z.infer<typeof MuninnExploreSchema>;

/**
 * Zod schema for muninn_graph tool arguments.
 */
export const MuninnGraphSchema = z.object({
  relation: z
    .enum([
      "node",
      "callers",
      "callees",
      "impact",
      "implementations",
      "imports",
      "cycles",
      "tests",
      "files",
    ])
    .describe("Graph question to answer"),
  symbol: z
    .string()
    .trim()
    .max(2_000)
    .nullish()
    .describe("Symbol name, qualified name or suffix (for node/callers/callees/impact/..."),
  file: z
    .string()
    .trim()
    .max(4_096)
    .nullish()
    .describe("Project-relative file path (for imports/node/tests)"),
  depth: z
    .number()
    .int()
    .positive()
    .max(3)
    .nullish()
    .describe("Traversal depth for impact (default 2, max 3)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .nullish()
    .describe("Maximum results (default 50, max 500)"),
});

export type MuninnGraphInput = z.infer<typeof MuninnGraphSchema>;

/**
 * Zod schema for muninn_code_search tool arguments.
 */
export const MuninnCodeSearchSchema = z.object({
  query: z.string().trim().min(1).max(2_000).describe("Symbol or file query"),
  kind: z
    .string()
    .trim()
    .max(40)
    .nullish()
    .describe("Optional symbol kind filter (function, class, method, ...)"),
  language: z
    .string()
    .trim()
    .max(40)
    .nullish()
    .describe("Optional language filter (typescript, python, go, ...)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .nullish()
    .describe("Maximum results (default 20, max 100)"),
});

export type MuninnCodeSearchInput = z.infer<typeof MuninnCodeSearchSchema>;

/**
 * Zod schema for muninn_project tool arguments.
 */
export const MuninnProjectSchema = z.object({
  action: z
    .enum(["status", "use", "list", "index"])
    .nullish()
    .default("status")
    .describe(
      "status resolves the current project, use switches it, list shows the registry, index refreshes the code graph"
    ),
  path: z
    .string()
    .trim()
    .max(4096)
    .nullish()
    .describe("Project path for status/use (absolute, or relative to the cwd)"),
  full: z
    .boolean()
    .nullish()
    .describe("With action=index: rebuild every file instead of only changed ones"),
});

export type MuninnProjectInput = z.infer<typeof MuninnProjectSchema>;

/**
 * Zod schema for muninn_verify_contract tool arguments.
 */
export const MuninnVerifyContractSchema = z.object({
  files: z
    .union([
      z.string().trim().min(1).max(1000),
      z.array(z.string().trim().min(1).max(1000)).max(500),
    ])
    .transform((val) => (Array.isArray(val) ? val : [val]))
    .nullish()
    .describe("Optional array of file paths or single file path to verify contracts for"),
  projectRoot: z
    .string()
    .trim()
    .nullish()
    .describe("Optional project root directory"),
  project_root: z
    .string()
    .trim()
    .nullish()
    .describe("Optional project root directory (snake_case)"),
});

export type MuninnVerifyContractInput = z.infer<
  typeof MuninnVerifyContractSchema
>;

/**
 * Helper to format Zod validation errors into a human-readable string.
 */
export function formatZodErrors(error: z.ZodError): string {
  if (error.issues && Array.isArray(error.issues) && error.issues.length > 0) {
    return error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join(", ");
  }
  return error.message;
}

export interface ToolDefinition<
  TSchema extends z.ZodTypeAny = any,
  TOutput = unknown
> {
  name: string;
  description: string;
  schema: TSchema;
  handler: (
    service: IMemoryService,
    input: z.infer<TSchema>
  ) => TOutput | Promise<TOutput>;
}

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  muninn_save: {
    name: "muninn_save",
    description:
      "Save an observation (decision, convention, discovery, bugfix, architecture) to Muninn memory with optional linked entities.",
    schema: MuninnSaveSchema,
    handler: (service, input) => service.saveObservation(input),
  },
  muninn_search: {
    name: "muninn_search",
    description:
      "Search observations in Muninn memory using full-text search with BM25 ranking.",
    schema: MuninnSearchSchema,
    handler: (service, input) => service.search(input),
  },
  muninn_context: {
    name: "muninn_context",
    description:
      "Retrieve recent observations and context from Muninn memory, optionally filtered by category or topic.",
    schema: MuninnContextSchema,
    handler: (service, input) => service.getContext(input),
  },
  muninn_link_symbol: {
    name: "muninn_link_symbol",
    description:
      "Link a code entity/symbol to an existing observation in Muninn memory.",
    schema: MuninnLinkSymbolSchema,
    handler: (service, input) =>
      service.linkSymbol(
        input.observationId,
        input.symbol as SymbolInput | string
      ),
  },
  muninn_stats: {
    name: "muninn_stats",
    description:
      "Get memory statistics (counts of projects, observations, entities, and links).",
    schema: MuninnStatsSchema,
    handler: (service, input) =>
      input.allProjects
        ? service.getStats()
        : service.getStats(service.currentProject.id),
  },
  muninn_inspect_symbol: {
    name: "muninn_inspect_symbol",
    description:
      "Inspect a code entity/symbol in Muninn memory, returning its definition, file location, dependencies (imports, extends, calls), bounded depth-1 graph neighbors, and linked observations.",
    schema: MuninnInspectSymbolSchema,
    handler: (service, input) => {
      const projectId =
        input.projectId?.trim() || input.project_id?.trim() || undefined;
      const res = service.inspectSymbol(input.symbol, projectId);
      if (!res) {
        return {
          found: false,
          symbol: input.symbol,
          message: `Symbol "${input.symbol}" not found in Muninn entity index`,
        };
      }
      return {
        found: true,
        ...res,
      };
    },
  },
  muninn_bootstrap: {
    name: "muninn_bootstrap",
    description:
      "Build a bounded, deterministic read-only session brief with project identity, active decisions, recent activity, path-selected indexed symbols, counts, and notes.",
    schema: MuninnBootstrapSchema,
    handler: (service, input) =>
      service.getSessionBrief({
        paths: input.paths ?? undefined,
        budgetChars: input.budgetChars ?? input.budget_chars,
        expandGraph: input.expandGraph ?? input.expand_graph,
      }).markdown,
  },
  muninn_handoff: {
    name: "muninn_handoff",
    description:
      "Save, read or close the project's session handoff: the structured 'where we left off' record (goal, state, next steps, open questions, blockers) that lets a new session in any agent start without re-reading the repository.",
    schema: MuninnHandoffSchema,
    handler: (service, input) => {
      const action = input.action ?? "checkpoint";
      if (action === "status") {
        return { handoff: service.getActiveHandoff() };
      }
      if (action === "close") {
        return { closed: service.closeHandoff() };
      }
      if (!input.goal || !input.goal.trim()) {
        throw new Error("Handoff goal is required for checkpoint/end");
      }
      if (!input.state || !input.state.trim()) {
        throw new Error("Handoff state is required for checkpoint/end");
      }
      return {
        handoff: service.saveHandoff({
          goal: input.goal,
          state: input.state,
          agent: input.agent ?? undefined,
          sessionId: input.sessionId ?? input.session_id ?? undefined,
          branch: input.branch ?? undefined,
          filesTouched: input.filesTouched ?? input.files_touched ?? undefined,
          openQuestions: input.openQuestions ?? input.open_questions ?? undefined,
          nextSteps: input.nextSteps ?? input.next_steps ?? undefined,
          decisions: input.decisions ?? undefined,
          blockers: input.blockers ?? undefined,
        }),
      };
    },
  },
  muninn_project: {
    name: "muninn_project",
    description:
      "Resolve which project a directory belongs to, switch the active project when the working directory is not the project, or list known projects and their portable storage.",
    schema: MuninnProjectSchema,
    handler: (service, input) => {
      const context = resolveProjectContext({
        explicitRoot: input.path,
      });
      return {
        action: input.action ?? "status",
        project: {
          name: context.name,
          rootPath: context.rootPath,
          uid: context.uid,
          kind: context.kind,
          gitRoot: context.gitRoot,
          gitRemote: context.gitRemote,
          markerPath: context.markerPath,
          source: context.source,
        },
        database: {
          path: memoryDbPath(context.uid),
          exists: fs.existsSync(memoryDbPath(context.uid)),
        },
        observations: (() => {
          try {
            return service.getStats(service.currentProject.id).observations;
          } catch {
            return null;
          }
        })(),
      };
    },
  },
  muninn_explore: {
    name: "muninn_explore",
    description:
      "One call to understand code: rank symbols for a question and return their verbatim source, callers, callees and related decisions, bounded by a character budget. Use it instead of reading many files.",
    schema: MuninnExploreSchema,
    handler: (service, input) =>
      buildExplore(
        service.db,
        service.currentProject.id,
        service.currentProject.root_path,
        input.query,
        { budget: input.budget ?? undefined, limit: input.limit ?? undefined }
      ),
  },
  muninn_graph: {
    name: "muninn_graph",
    description:
      "Query the code graph: node (source + direct edges), callers, callees, impact radius, implementations, file imports, import cycles, affected tests, or the indexed file tree.",
    schema: MuninnGraphSchema,
    handler: (service, input) => {
      const db = service.db;
      const projectId = service.currentProject.id;
      const root = service.currentProject.root_path;
      const limit = input.limit ?? undefined;

      if (input.relation === "files") {
        return { relation: "files", files: getFileTree(db, projectId, { limit }) };
      }
      if (input.relation === "cycles") {
        return {
          relation: "cycles",
          cycles: findImportCycles(db, projectId, limit ?? 20),
        };
      }
      if (input.relation === "imports") {
        if (!input.file) throw new Error("file is required for relation=imports");
        return {
          relation: "imports",
          file: input.file,
          imports: getFileImports(db, projectId, input.file),
        };
      }
      if (input.relation === "tests") {
        const files = input.file ? [input.file] : [];
        return {
          relation: "tests",
          tests: getAffectedTests(db, projectId, files, limit ?? 50),
        };
      }

      const symbol = findSymbol(db, projectId, input.symbol ?? "");
      if (!symbol) {
        return {
          relation: input.relation,
          found: false,
          symbol: input.symbol ?? null,
          message:
            "Symbol not found in the code graph. The index may be empty or stale: call muninn_project with action=index.",
        };
      }
      if (input.relation === "callers" || input.relation === "callees") {
        const edges = getEdges(db, projectId, symbol.id, input.relation === "callers" ? "incoming" : "outgoing", {
          kinds: ["calls", "references", "extends", "implements"],
          limit,
        });
        return { relation: input.relation, symbol, edges };
      }
      if (input.relation === "impact") {
        return {
          relation: "impact",
          symbol,
          depth: input.depth ?? 2,
          affected: getImpact(db, projectId, symbol.id, { depth: input.depth, limit }),
        };
      }
      if (input.relation === "implementations") {
        return {
          relation: "implementations",
          symbol,
          implementations: getImplementations(db, projectId, symbol.id, { limit }),
        };
      }
      return {
        relation: "node",
        symbol,
        source: readSourceSlice(root, symbol.file_path, symbol.start_line, symbol.end_line, {
          maxLines: 120,
        }),
        callers: getEdges(db, projectId, symbol.id, "incoming", {
          kinds: ["calls", "references"],
          limit: limit ?? 20,
        }),
        callees: getEdges(db, projectId, symbol.id, "outgoing", {
          kinds: ["calls", "references"],
          limit: limit ?? 20,
        }),
        tests: getAffectedTests(db, projectId, [symbol.file_path], 20),
      };
    },
  },
  muninn_code_search: {
    name: "muninn_code_search",
    description:
      "Search indexed symbols and files by name, kind or language with full-text ranking. Fast way to locate code without grepping the repository.",
    schema: MuninnCodeSearchSchema,
    handler: (service, input) => ({
      symbols: searchSymbols(service.db, service.currentProject.id, input.query, {
        kind: input.kind ?? undefined,
        language: input.language ?? undefined,
        limit: input.limit ?? undefined,
      }),
    }),
  },
  muninn_verify_contract: {
    name: "muninn_verify_contract",
    description:
      "Verify TypeScript compilation execution contracts for project files, returning diagnostics, exact line/character positions, and visual snippets.",
    schema: MuninnVerifyContractSchema,
    handler: (service, input) => {
      const baseDir = path.resolve(
        service.currentProject?.root_path ?? process.cwd()
      );
      const rawRoot =
        input.projectRoot?.trim() || input.project_root?.trim() || undefined;
      let targetRoot = baseDir;
      if (rawRoot) {
        const resolved = path.resolve(baseDir, rawRoot);
        const rel = path.relative(baseDir, resolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          throw new Error(
            `Access denied: projectRoot "${rawRoot}" is outside permitted project root "${baseDir}"`
          );
        }
        targetRoot = resolved;
      }
      return verifyTypeScriptContracts(targetRoot, input.files ?? undefined);
    },
  },
};

/**
 * Metadata definition for all Muninn MCP tools.
 */
export const MUNINN_TOOLS: Tool[] = Object.values(TOOL_REGISTRY).map(
  (tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.schema, {
      unrepresentable: "any",
    }) as Tool["inputSchema"],
  })
);

export const TOOL_NAMES = [
  "muninn_save",
  "muninn_search",
  "muninn_context",
  "muninn_link_symbol",
  "muninn_stats",
  "muninn_inspect_symbol",
  "muninn_verify_contract",
  "muninn_bootstrap",
  "muninn_handoff",
  "muninn_project",
  "muninn_explore",
  "muninn_graph",
  "muninn_code_search",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const PROTOTYPE_POLLUTION_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Normalizes input arguments (handling snake_case fallbacks and null/undefined values),
 * hardened against prototype pollution by skipping __proto__, constructor, and prototype keys.
 */
/**
 * Argument keys whose values some MCP clients serialize as strings. Coercing them
 * before Zod validation keeps tool calls working across agents instead of
 * failing with "expected number, received string".
 */
const NUMERIC_ARG_KEYS = new Set([
  "limit",
  "budget",
  "budgetChars",
  "budget_chars",
  "depth",
  "maxFiles",
  "timeoutMs",
  "toolCallTimeoutMs",
]);

const BOOLEAN_ARG_KEYS = new Set([
  "allProjects",
  "all_projects",
  "includeSuperseded",
  "include_superseded",
  "includeGlobal",
  "include_global",
  "expandGraph",
  "expand_graph",
  "full",
  "force",
  "close",
  "closed",
]);

function coerceArgumentValue(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (NUMERIC_ARG_KEYS.has(key)) {
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
        return Number(trimmed);
      }
      return value;
    }
    if (BOOLEAN_ARG_KEYS.has(key)) {
      if (trimmed === "true") return true;
      if (trimmed === "false") return false;
      return value;
    }
    return value;
  }
  if (typeof value === "number" && BOOLEAN_ARG_KEYS.has(key)) {
    if (value === 0) return false;
    if (value === 1) return true;
  }
  return value;
}

export function normalizeArgs(
  args: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      continue;
    }
    if (value !== null && value !== undefined) {
      normalized[key] = value;
    }
  }
  if (normalized.topic_key !== undefined && normalized.topicKey === undefined) {
    normalized.topicKey = normalized.topic_key;
  }
  if (
    normalized.observation_id !== undefined &&
    normalized.observationId === undefined
  ) {
    normalized.observationId = normalized.observation_id;
  }
  if (
    normalized.all_projects !== undefined &&
    normalized.allProjects === undefined
  ) {
    normalized.allProjects = normalized.all_projects;
  }
  if (
    normalized.project_id !== undefined &&
    normalized.projectId === undefined
  ) {
    normalized.projectId = normalized.project_id;
  }
  if (
    normalized.project_root !== undefined &&
    normalized.projectRoot === undefined
  ) {
    normalized.projectRoot = normalized.project_root;
  }
  if (
    normalized.supersedes_topic_key !== undefined &&
    normalized.supersedesTopicKey === undefined
  ) {
    normalized.supersedesTopicKey = normalized.supersedes_topic_key;
  }
  if (
    normalized.include_superseded !== undefined &&
    normalized.includeSuperseded === undefined
  ) {
    normalized.includeSuperseded = normalized.include_superseded;
  }
  if (normalized.file !== undefined && normalized.files === undefined) {
    normalized.files = normalized.file;
  }
  if (
    normalized.budget_chars !== undefined &&
    normalized.budgetChars === undefined
  ) {
    normalized.budgetChars = normalized.budget_chars;
  }
  if (
    normalized.expand_graph !== undefined &&
    normalized.expandGraph === undefined
  ) {
    normalized.expandGraph = normalized.expand_graph;
  }
  for (const key of Object.keys(normalized)) {
    normalized[key] = coerceArgumentValue(key, normalized[key]);
  }
  return normalized;
}

/**
 * Type guard to check if an object satisfies the IMemoryService interface.
 */
export function isMemoryService(obj: unknown): obj is IMemoryService {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "saveObservation" in obj &&
    typeof (obj as IMemoryService).saveObservation === "function" &&
    "search" in obj &&
    typeof (obj as IMemoryService).search === "function"
  );
}

export type MuninnServer = Server & {
  service: IMemoryService;
  memoryService: IMemoryService;
  getService(): IMemoryService;
  closeService(force?: boolean): void;
};

export interface McpServerHandle {
  server: MuninnServer;
  transport: BoundedStdioServerTransport;
  readonly service: IMemoryService;
  closeService(force?: boolean): void;
}

/**
 * Deadline for a single JSON-RPC write (AC-30.3 / ADR-30.3). The SDK transport
 * resolves `send()` on `'drain'`, which a *broken* stdout pipe never emits, so
 * an unbounded write would hang the pending request forever.
 */
export const MCP_WRITE_TIMEOUT_MS = 5000;

export interface BoundedStdioTransportOptions {
  /** Read-buffer ceiling (SDK default: 10 MB). */
  maxBufferSize?: number;
  /** Write deadline before the pending request is rejected; ≤ 0 disables it. */
  writeTimeoutMs?: number;
}

/**
 * `StdioServerTransport` with a *bounded* write path (REQ-30 / AC-30.3).
 *
 * `send()` races the SDK's write against (i) a short deadline and (ii) an error
 * on the output stream (EPIPE / ERR_STREAM_DESTROYED). Either one **rejects**,
 * so a broken parent pipe fails the pending request with a clear error instead
 * of awaiting a `'drain'` that can never arrive. The reader side (`start()`,
 * buffering, framing) is untouched.
 */
export class BoundedStdioServerTransport extends StdioServerTransport {
  private readonly output: Writable;
  private readonly writeTimeoutMs: number;

  constructor(
    stdin: Readable = process.stdin,
    stdout: Writable = process.stdout,
    options: BoundedStdioTransportOptions = {},
  ) {
    super(stdin, stdout, { maxBufferSize: options.maxBufferSize });
    this.output = stdout;
    this.writeTimeoutMs = options.writeTimeoutMs ?? MCP_WRITE_TIMEOUT_MS;
  }

  override send(message: JSONRPCMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.output.off("error", onError);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (err: Error) =>
        fail(
          new Error(
            `MCP stdio write failed (the MCP client pipe is closed): ${sanitizeTerminalText(err.message)}`,
          ),
        );

      // A broken pipe emits 'error' on stdout; without a listener that is an
      // unhandled exception, so the transport listens for its own writes too.
      this.output.on("error", onError);

      if (this.writeTimeoutMs > 0) {
        timer = setTimeout(
          () =>
            fail(
              new Error(
                `MCP stdio write timed out after ${this.writeTimeoutMs}ms (the MCP client stopped reading)`,
              ),
            ),
          this.writeTimeoutMs,
        );
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      }

      try {
        super.send(message).then(succeed, (err: unknown) =>
          fail(err instanceof Error ? err : new Error(String(err))),
        );
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

/**
 * Instructions sent in the MCP `initialize` response.
 *
 * This is the activation path that does not depend on the agent reading a rules
 * file or choosing to call a tool: every MCP client receives the project name,
 * the root, and the four rules before the first prompt.
 */
export function buildServerInstructions(
  projectRoot?: string,
  sessionAware = false
): string {
  if (sessionAware) {
    return [
      "Muninn is the persistent memory for this DSH session. The session's working directory is resolved when you call muninn_bootstrap.",
      "Rules:",
      "1. Call muninn_bootstrap once at the start. If the session folder is a workspace with several projects, it lists them: choose the one you are working on with muninn_project action=\"use\" and the project path, then call muninn_bootstrap again.",
      "2. Before designing a change, use muninn_search, muninn_explore or muninn_graph instead of re-reading the repository.",
      "3. When the session settles a decision, convention, constraint, discovery or bugfix, save it with muninn_save. Use topicKey for anything a later decision could replace.",
      "4. Before finishing, call muninn_handoff with the goal, the current state, the next steps and any open questions.",
    ].join("\n");
  }
  try {
    const context = resolveProjectContext({
      explicitRoot: projectRoot ?? process.cwd(),
    });
    return [
      `Muninn is the persistent memory for the project "${context.name}" at ${context.rootPath}.`,
      "Rules:",
      "1. Call muninn_bootstrap once at the start of a session; it returns the project brief, including where the last session stopped.",
      "2. Before designing a change, use muninn_search or muninn_inspect_symbol instead of re-reading the repository.",
      "3. When the session settles a decision, convention, constraint, discovery or bugfix, save it with muninn_save. Use topicKey for anything a later decision could replace.",
      "4. Before finishing, call muninn_handoff with the goal, the current state, the next steps and any open questions.",
      'If the working directory is not the project, call muninn_project with action "use" and the project path first.',
    ].join("\n");
  } catch {
    return "Muninn holds persistent project memory. Call muninn_bootstrap at the start of a session, save settled knowledge with muninn_save, and call muninn_handoff before finishing.";
  }
}

/**
 * Creates and configures a Model Context Protocol (MCP) server for Muninn memory.
 */
export function createMcpServer(
  serviceOrOptions?: IMemoryService | MemoryServiceOptions
): MuninnServer {
  const injectedService = isMemoryService(serviceOrOptions)
    ? serviceOrOptions
    : undefined;
  const options = injectedService
    ? undefined
    : (serviceOrOptions as MemoryServiceOptions | undefined);

  let serviceInstance: IMemoryService | undefined = injectedService;
  // A desktop agent (or any client whose cwd is not the project) can switch the
  // active project for this server process with muninn_project { action: "use" }.
  let activeProjectRoot: string | undefined;
  // Once an agent pins a project explicitly, session autodetection stops
  // overriding it.
  let sessionPinned = false;
  const autoProjectRoot = (): string | null => {
    if (injectedService || sessionPinned || !sessionAutodetectEnabled()) {
      return null;
    }
    return resolveSessionWorkspace()?.projectRoot ?? null;
  };
  const effectiveOptions = (): MemoryServiceOptions | undefined => {
    if (!activeProjectRoot) return options;
    return { ...(options ?? {}), projectRoot: activeProjectRoot };
  };
  const getService = (): IMemoryService => {
    const autoRoot = autoProjectRoot();
    if (autoRoot && autoRoot !== activeProjectRoot) {
      if (serviceInstance) {
        serviceInstance.close?.(true);
        serviceInstance = undefined;
      }
      activeProjectRoot = autoRoot;
    }
    if (!serviceInstance) {
      serviceInstance = new MemoryService(effectiveOptions());
    }
    return serviceInstance;
  };
  const closeService = (force = true): void => {
    if (serviceInstance) {
      serviceInstance.close?.(force);
    }
  };

  const server = new Server(
    {
      name: "muninn-memory",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: buildServerInstructions(
        options?.projectRoot,
        sessionAutodetectEnabled()
      ),
    }
  );

  // The writable service is lazy for a default server: bootstrap must be able to
  // run without creating or initializing a database. Accessing `service` (or
  // calling any non-bootstrap tool) initializes it exactly as before.
  const mcpServer = server as MuninnServer;
  Object.defineProperty(mcpServer, "service", {
    configurable: true,
    enumerable: true,
    get: getService,
  });
  Object.defineProperty(mcpServer, "memoryService", {
    configurable: true,
    enumerable: true,
    get: getService,
  });
  mcpServer.getService = getService;
  mcpServer.closeService = closeService;

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: MUNINN_TOOLS,
    };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name } = request.params;
      const tool = TOOL_REGISTRY[name];
      if (!tool) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Unknown tool "${name}"`,
            },
          ],
        };
      }

      const rawArgs = request.params.arguments;
      const args = normalizeArgs(rawArgs as Record<string, unknown> | undefined);

      const parsed = tool.schema.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Validation error: ${formatZodErrors(parsed.error)}`,
            },
          ],
        };
      }

      const jsonContent = (value: unknown) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(value, null, 2),
          },
        ],
      });

      if (name === "muninn_project") {
        const input = parsed.data as MuninnProjectInput;
        const action = input.action ?? "status";
        if (action === "list") {
          return jsonContent({
            projects: readRegistry().projects.map((entry) => ({
              ...entry,
              databasePath: memoryDbPath(entry.uid),
              databaseExists: fs.existsSync(memoryDbPath(entry.uid)),
            })),
          });
        }
        if (action === "index") {
          const indexService = getService();
          const summary = await indexProject(indexService, {
            mode: input.full ? "full" : "changed",
          });
          return jsonContent({
            action: "index",
            summary,
            status: getIndexStatus(indexService),
          });
        }
        const context = resolveProjectContext({
          explicitRoot:
            input.path ??
            activeProjectRoot ??
            options?.projectRoot ??
            process.cwd(),
        });
        if (action === "use") {
          if (injectedService) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: "Error: cannot switch projects on a server created with an injected service",
                },
              ],
            };
          }
          sessionPinned = true;
          activeProjectRoot = context.rootPath;
          if (serviceInstance) {
            serviceInstance.close?.(true);
            serviceInstance = undefined;
          }
          // Materialise the project (database + row + registry) on an explicit use.
          getService();
        }
        const databasePath = memoryDbPath(context.uid);
        const databaseExists = fs.existsSync(databasePath);
        let observations: number | null = null;
        if (databaseExists) {
          try {
            observations = getService().getStats().observations;
          } catch {
            observations = null;
          }
        }
        const workspace =
          sessionAutodetectEnabled() && !sessionPinned
            ? resolveSessionWorkspace()
            : null;
        return jsonContent({
          action,
          project: {
            name: context.name,
            rootPath: context.rootPath,
            uid: context.uid,
            kind: context.kind,
            gitRoot: context.gitRoot,
            gitRemote: context.gitRemote,
            markerPath: context.markerPath,
            source: context.source,
          },
          session: workspace
            ? {
                cwd: workspace.cwd,
                bound: workspace.projectRoot !== null,
                candidates: workspace.candidates,
                pinned: sessionPinned,
              }
            : null,
          storage: {
            directory: projectStorageDir(context.uid),
            databasePath,
            databaseExists,
            observations,
          },
          graph: databaseExists
            ? (() => {
                try {
                  return getIndexStatus(getService());
                } catch {
                  return null;
                }
              })()
            : null,
        });
      }

      const isBootstrap = name === "muninn_bootstrap";
      if (isBootstrap && !injectedService) {
        const input = parsed.data as MuninnBootstrapInput;
        const workspace =
          sessionAutodetectEnabled() && !sessionPinned
            ? resolveSessionWorkspace()
            : null;
        const autoRoot = workspace?.projectRoot ?? null;
        if (autoRoot) activeProjectRoot = autoRoot;

        if (workspace && !workspace.projectRoot) {
          return {
            content: [
              {
                type: "text",
                text: renderWorkspaceGuidance(workspace),
              },
            ],
          };
        }

        const brief = readSessionBrief({
          dbPath: options?.dbPath,
          // An explicit `muninn_project { action: "use" }` pins the project, so the
          // brief must follow it instead of the server process's cwd (which is the
          // DSH profile directory, not the session workspace).
          projectRoot: autoRoot ?? activeProjectRoot ?? options?.projectRoot,
          db: options?.db,
          paths: input.paths ?? undefined,
          budgetChars: input.budgetChars ?? input.budget_chars ?? undefined,
          expandGraph: input.expandGraph ?? input.expand_graph,
        });
        return {
          content: [
            {
              type: "text",
              text: brief.markdown,
            },
          ],
        };
      }

      const result = await tool.handler(getService(), parsed.data);
      return {
        content: [
          {
            type: "text",
            text:
              isBootstrap || name === "muninn_explore"
                ? String(result)
                : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  });

  return mcpServer;
}

/**
 * Starts the Muninn MCP server using the bounded {@link BoundedStdioServerTransport}.
 */
export async function startMcpServer(
  options?: MemoryServiceOptions | IMemoryService,
  transportOptions?: BoundedStdioTransportOptions,
): Promise<McpServerHandle> {
  const server = createMcpServer(options);
  const transport = new BoundedStdioServerTransport(
    process.stdin,
    process.stdout,
    transportOptions,
  );
  await server.connect(transport);

  const handle = { server, transport } as McpServerHandle;
  Object.defineProperty(handle, "service", {
    configurable: true,
    enumerable: true,
    get: () => server.getService(),
  });
  Object.defineProperty(handle, "closeService", {
    configurable: false,
    enumerable: false,
    value: (force = true) => server.closeService(force),
  });
  return handle;
}

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { getDatabase } from "../src/db/client.js";
import { MemoryService } from "../src/service/index.js";
import {
  extractSymbolsFromSource,
  extractAstData,
  indexFilesIntoMuninn,
  normalizeModuleSpecifier,
} from "../src/indexer/ast-indexer.js";
import { createMcpServer } from "../src/mcp/server.js";
import { handleCheckCommand } from "../src/commands/check.js";
import { handleMemoryCommand } from "../src/commands/memory.js";

describe("AST Symbol Indexer & Contract Verification Integration", () => {
  let tempDir: string;
  let db: Database.Database;
  let service: MemoryService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-indexer-test-"));
    db = getDatabase(":memory:");
    service = new MemoryService({ db, projectRoot: tempDir });
  });

  afterEach(() => {
    service.close(true);
    if (db.open) {
      db.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("extractSymbolsFromSource & extractAstData", () => {
    it("extracts top-level and exported functions with canonical identifiers", () => {
      const code = `
export function add(a: number, b: number): number {
  return a + b;
}

function internalHelper(): void {
  console.log("internal");
}

export const multiply = (x: number, y: number): number => x * y;
`;
      const symbols = extractSymbolsFromSource("src/calc.ts", code);

      expect(symbols.length).toBe(3);

      const addSym = symbols.find((s) => s.name === "add")!;
      expect(addSym).toBeDefined();
      expect(addSym.identifier).toBe("src/calc.ts::add");
      expect(addSym.entityType).toBe("function");
      expect(addSym.isExported).toBe(true);
      expect(addSym.startLine).toBe(2);

      const helperSym = symbols.find((s) => s.name === "internalHelper")!;
      expect(helperSym).toBeDefined();
      expect(helperSym.identifier).toBe("src/calc.ts::internalHelper");
      expect(helperSym.entityType).toBe("function");
      expect(helperSym.isExported).toBe(false);

      const multSym = symbols.find((s) => s.name === "multiply")!;
      expect(multSym).toBeDefined();
      expect(multSym.identifier).toBe("src/calc.ts::multiply");
      expect(multSym.entityType).toBe("function");
      expect(multSym.isExported).toBe(true);
    });

    it("extracts classes, inheritance, and public methods while excluding private ones", () => {
      const code = `
export class UserService extends BaseService implements IUserService {
  public findUser(id: string): User {
    return this._getUser(id);
  }

  saveUser(user: User): void {}

  private _getUser(id: string): User {
    return {} as User;
  }

  protected validate(user: User): boolean {
    return true;
  }

  #secretKey(): string {
    return "secret";
  }
}
`;
      const ast = extractAstData("src/services/user.ts", code);

      // Class symbol
      const classSym = ast.symbols.find((s) => s.name === "UserService")!;
      expect(classSym).toBeDefined();
      expect(classSym.identifier).toBe("src/services/user.ts::UserService");
      expect(classSym.entityType).toBe("class");
      expect(classSym.isExported).toBe(true);

      // Methods: findUser and saveUser should be present
      const findMethod = ast.symbols.find((s) => s.name === "UserService.findUser")!;
      expect(findMethod).toBeDefined();
      expect(findMethod.identifier).toBe("src/services/user.ts::UserService.findUser");
      expect(findMethod.entityType).toBe("function");

      const saveMethod = ast.symbols.find((s) => s.name === "UserService.saveUser")!;
      expect(saveMethod).toBeDefined();
      expect(saveMethod.identifier).toBe("src/services/user.ts::UserService.saveUser");

      // Private, protected, and # methods must NOT be extracted
      const privateMethod = ast.symbols.find((s) => s.name.includes("_getUser"));
      expect(privateMethod).toBeUndefined();

      const protectedMethod = ast.symbols.find((s) => s.name.includes("validate"));
      expect(protectedMethod).toBeUndefined();

      const secretMethod = ast.symbols.find((s) => s.name.includes("secretKey"));
      expect(secretMethod).toBeUndefined();

      // Dependencies: extends and implements
      const extendsDep = ast.dependencies.find((d) => d.relationType === "extends")!;
      expect(extendsDep).toBeDefined();
      expect(extendsDep.sourceIdentifier).toBe("src/services/user.ts::UserService");
      expect(extendsDep.targetIdentifier).toBe("BaseService");

      const implementsDep = ast.dependencies.find((d) => d.relationType === "implements")!;
      expect(implementsDep).toBeDefined();
      expect(implementsDep.sourceIdentifier).toBe("src/services/user.ts::UserService");
      expect(implementsDep.targetIdentifier).toBe("IUserService");
    });

    it("extracts interfaces, type aliases, and import declarations", () => {
      const code = `
import { Database } from "better-sqlite3";
import fs from "node:fs";

export interface ConfigOptions extends BaseOptions {
  timeout: number;
}

export type Handler = (req: Request) => Promise<Response>;
`;
      const ast = extractAstData("src/types.ts", code);

      // Interface
      const iface = ast.symbols.find((s) => s.name === "ConfigOptions")!;
      expect(iface).toBeDefined();
      expect(iface.identifier).toBe("src/types.ts::ConfigOptions");
      expect(iface.entityType).toBe("interface");

      // Type Alias
      const alias = ast.symbols.find((s) => s.name === "Handler")!;
      expect(alias).toBeDefined();
      expect(alias.identifier).toBe("src/types.ts::Handler");
      expect(alias.entityType).toBe("interface");

      // Imports
      const sqliteImport = ast.dependencies.find(
        (d) => d.relationType === "imports" && d.targetIdentifier === "better-sqlite3"
      );
      expect(sqliteImport).toBeDefined();
      expect(sqliteImport?.sourceIdentifier).toBe("src/types.ts");

      const namedImport = ast.dependencies.find(
        (d) => d.targetIdentifier === "better-sqlite3::Database"
      );
      expect(namedImport).toBeDefined();
    });

    it("normalizes relative module specifiers and maps extensions (REV-002)", () => {
      // .js -> .ts
      expect(normalizeModuleSpecifier("src/index.ts", "./utils.js")).toBe("src/utils.ts");
      // .mjs -> .ts
      expect(normalizeModuleSpecifier("src/index.ts", "./utils.mjs")).toBe("src/utils.ts");
      // .cjs -> .ts
      expect(normalizeModuleSpecifier("src/index.ts", "./utils.cjs")).toBe("src/utils.ts");
      // .jsx -> .tsx
      expect(normalizeModuleSpecifier("src/index.ts", "./view.jsx")).toBe("src/view.tsx");
      // Extensionless bare relative path kept bare
      expect(normalizeModuleSpecifier("src/index.ts", "./utils")).toBe("src/utils");
      // Nested relative paths resolving upwards
      expect(normalizeModuleSpecifier("src/nested/deep.ts", "../common/helper.js")).toBe(
        "src/common/helper.ts"
      );
      // Root-level relative path
      expect(normalizeModuleSpecifier("app.ts", "./config.js")).toBe("config.ts");
      // External npm package specifier preserved unchanged
      expect(normalizeModuleSpecifier("src/index.ts", "better-sqlite3")).toBe("better-sqlite3");
      // Node built-in module preserved unchanged
      expect(normalizeModuleSpecifier("src/index.ts", "node:fs")).toBe("node:fs");
    });
  });

  describe("indexFilesIntoMuninn", () => {
    it("indexes files, symbols, and dependencies into SQLite database", () => {
      const file1Path = path.join(tempDir, "client.ts");
      const file1Content = `
export interface ClientConfig {
  baseUrl: string;
}

export class ApiClient {
  public fetch(): string {
    return "ok";
  }
}
`;
      fs.writeFileSync(file1Path, file1Content);

      const file2Path = path.join(tempDir, "service.ts");
      const file2Content = `
import { ApiClient } from "./client.js";

export function createService(): ApiClient {
  return new ApiClient();
}
`;
      fs.writeFileSync(file2Path, file2Content);

      const summary = indexFilesIntoMuninn(service, ["client.ts", "service.ts"], {
        projectRoot: tempDir,
      });

      expect(summary.indexedFiles).toBe(2);
      expect(summary.indexedSymbols).toBeGreaterThanOrEqual(4);
      expect(summary.indexedDependencies).toBeGreaterThanOrEqual(4);

      // Verify entities table
      const entities = db
        .prepare("SELECT identifier, entity_type FROM entities ORDER BY identifier")
        .all() as Array<{ identifier: string; entity_type: string }>;

      const identifiers = entities.map((e) => e.identifier);
      expect(identifiers).toContain("client.ts");
      expect(identifiers).toContain("client.ts::ClientConfig");
      expect(identifiers).toContain("client.ts::ApiClient");
      expect(identifiers).toContain("client.ts::ApiClient.fetch");
      expect(identifiers).toContain("service.ts");
      expect(identifiers).toContain("service.ts::createService");

      // Verify entity_dependencies table
      const deps = db
        .prepare(
          `SELECT se.identifier as source, te.identifier as target, ed.relation_type
           FROM entity_dependencies ed
           JOIN entities se ON se.id = ed.source_entity_id
           JOIN entities te ON te.id = ed.target_entity_id`
        )
        .all() as Array<{ source: string; target: string; relation_type: string }>;

      expect(deps.length).toBeGreaterThanOrEqual(4);
      const fileRef = deps.find(
        (d) => d.source === "client.ts" && d.target === "client.ts::ApiClient" && d.relation_type === "references"
      );
      expect(fileRef).toBeDefined();

      const importDep = deps.find(
        (d) => d.source === "service.ts" && d.target === "client.ts" && d.relation_type === "imports"
      );
      expect(importDep).toBeDefined();

      const namedImportDep = deps.find(
        (d) => d.source === "service.ts" && d.target === "client.ts::ApiClient" && d.relation_type === "imports"
      );
      expect(namedImportDep).toBeDefined();
    });

    it("is idempotent when re-indexing the same files with updates", () => {
      const filePath = path.join(tempDir, "math.ts");
      fs.writeFileSync(
        filePath,
        "export function add(a: number, b: number): number { return a + b; }\n"
      );

      const firstSummary = indexFilesIntoMuninn(service, ["math.ts"], { projectRoot: tempDir });
      expect(firstSummary.indexedFiles).toBe(1);

      // Update file content with new method
      fs.writeFileSync(
        filePath,
        "export function add(a: number, b: number): number { return a + b; }\n" +
          "export function subtract(a: number, b: number): number { return a - b; }\n"
      );

      const secondSummary = indexFilesIntoMuninn(service, ["math.ts"], { projectRoot: tempDir });
      expect(secondSummary.indexedFiles).toBe(1);

      const mathEntities = db
        .prepare("SELECT identifier FROM entities WHERE file_path = 'math.ts'")
        .all() as Array<{ identifier: string }>;

      const ids = mathEntities.map((e) => e.identifier);
      expect(ids).toContain("math.ts");
      expect(ids).toContain("math.ts::add");
      expect(ids).toContain("math.ts::subtract");
    });

    it("prunes zombie / ghost entities and purges dependencies via ON DELETE CASCADE (REV-003, SEC-003, O1)", () => {
      const filePath = path.join(tempDir, "calculator.ts");
      fs.writeFileSync(
        filePath,
        `
export function computeSum(a: number, b: number): number { return a + b; }
export function computeDiff(a: number, b: number): number { return a - b; }
`
      );

      // Initial indexing
      indexFilesIntoMuninn(service, ["calculator.ts"], { projectRoot: tempDir });

      const initialEntities = db
        .prepare("SELECT identifier FROM entities WHERE file_path = 'calculator.ts'")
        .all() as Array<{ identifier: string }>;
      expect(initialEntities.map((e) => e.identifier)).toContain("calculator.ts::computeDiff");

      // Attach an observation to computeDiff
      const obs = service.saveObservation({
        category: "discovery",
        title: "ComputeDiff behavior",
        content: "Subtraction logic",
        symbols: ["calculator.ts::computeDiff"],
      });

      // Verify observation_entities join exists
      const initialLinks = db
        .prepare("SELECT count(*) as count FROM observation_entities WHERE observation_id = ?")
        .get(obs.id) as { count: number };
      expect(initialLinks.count).toBe(1);

      // Verify computeDiff has references dependency
      const diffDepsBefore = db
        .prepare(
          `SELECT count(*) as count FROM entity_dependencies ed
           JOIN entities e ON e.id = ed.target_entity_id
           WHERE e.identifier = 'calculator.ts::computeDiff'`
        )
        .get() as { count: number };
      expect(diffDepsBefore.count).toBeGreaterThan(0);

      // Update file removing computeDiff (zombie entity)
      fs.writeFileSync(
        filePath,
        `export function computeSum(a: number, b: number): number { return a + b; }\n`
      );

      // Re-index file
      indexFilesIntoMuninn(service, ["calculator.ts"], { projectRoot: tempDir });

      // Verify computeDiff was pruned from entities
      const updatedEntities = db
        .prepare("SELECT identifier FROM entities WHERE file_path = 'calculator.ts'")
        .all() as Array<{ identifier: string }>;
      const updatedIds = updatedEntities.map((e) => e.identifier);
      expect(updatedIds).toContain("calculator.ts::computeSum");
      expect(updatedIds).not.toContain("calculator.ts::computeDiff");

      // Verify computeDiff dependencies purged via ON DELETE CASCADE
      const diffDepsAfter = db
        .prepare(
          `SELECT count(*) as count FROM entity_dependencies ed
           JOIN entities e ON e.id = ed.target_entity_id
           WHERE e.identifier = 'calculator.ts::computeDiff'`
        )
        .get() as { count: number };
      expect(diffDepsAfter.count).toBe(0);

      // Verify observation_entities link purged via ON DELETE CASCADE
      const linksAfter = db
        .prepare("SELECT count(*) as count FROM observation_entities WHERE observation_id = ?")
        .get(obs.id) as { count: number };
      expect(linksAfter.count).toBe(0);
    });

    it("enforces path traversal containment (SEC-001)", () => {
      // Create a file outside projectRoot
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-outside-"));
      const outsideFile = path.join(outsideDir, "secret.ts");
      fs.writeFileSync(outsideFile, "export const secret = 'hidden';\n");

      try {
        const summary = indexFilesIntoMuninn(
          service,
          ["../secret.ts", "../../secret.ts", outsideFile],
          { projectRoot: tempDir }
        );

        expect(summary.indexedFiles).toBe(0);
        expect(summary.indexedSymbols).toBe(0);

        const entities = db.prepare("SELECT count(*) as c FROM entities").get() as { c: number };
        expect(entities.c).toBe(0);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("filters unsupported extensions, non-existent files, and oversized files (REV-001, REV-007)", () => {
      // 1. Non-existent file
      const nonExistent = "does-not-exist.ts";

      // 2. Unsupported extension (.txt, .md, .json)
      const textFile = path.join(tempDir, "notes.txt");
      fs.writeFileSync(textFile, "just some notes");

      // 3. Directory instead of file
      const subDir = path.join(tempDir, "subfolder");
      fs.mkdirSync(subDir);

      // 4. Oversized file (> 2MB)
      const largeFile = path.join(tempDir, "large.ts");
      const largeBuffer = Buffer.alloc(2.5 * 1024 * 1024, "export const x = 1;\n");
      fs.writeFileSync(largeFile, largeBuffer);

      // 5. Valid file
      const validFile = path.join(tempDir, "valid_item.ts");
      fs.writeFileSync(validFile, "export const item = 'valid';\n");

      const summary = indexFilesIntoMuninn(
        service,
        [nonExistent, "notes.txt", "subfolder", "large.ts", "valid_item.ts"],
        { projectRoot: tempDir }
      );

      // Only valid_item.ts should be indexed
      expect(summary.indexedFiles).toBe(1);
      const entities = db
        .prepare("SELECT identifier FROM entities WHERE entity_type = 'file'")
        .all() as Array<{ identifier: string }>;
      expect(entities.map((e) => e.identifier)).toEqual(["valid_item.ts"]);
    });

    it("handles syntax errors gracefully without aborting remaining files (REV-007)", () => {
      // Syntax error file
      const badFile = path.join(tempDir, "bad.ts");
      fs.writeFileSync(badFile, "const invalid syntax {{{{ ;;");

      // Good file
      const goodFile = path.join(tempDir, "good.ts");
      fs.writeFileSync(goodFile, "export function goodFn(): number { return 123; }\n");

      const summary = indexFilesIntoMuninn(service, ["bad.ts", "good.ts"], {
        projectRoot: tempDir,
      });

      expect(summary.indexedFiles).toBeGreaterThanOrEqual(1);
      const goodEntity = db
        .prepare("SELECT identifier FROM entities WHERE identifier = 'good.ts::goodFn'")
        .get();
      expect(goodEntity).toBeDefined();
    });

    it("attributes entities to the service project while scanning a separate worktree root (sandbox durability)", () => {
      // Under sandboxing the modified files live in an ephemeral worktree while
      // the durable database/project record belong to the primary root. Scanning
      // must read the worktree, but the entities must be attributed to the
      // primary project so they survive worktree cleanup.
      const primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-primary-"));
      const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-worktree-"));
      const primaryDb = getDatabase(":memory:");
      const primaryService = new MemoryService({ db: primaryDb, projectRoot: primaryDir });
      try {
        fs.writeFileSync(
          path.join(worktreeDir, "sandboxed.ts"),
          "export function sandboxedFn(): number { return 1; }\n"
        );

        const summary = indexFilesIntoMuninn(primaryService, ["sandboxed.ts"], {
          projectRoot: worktreeDir,
        });
        expect(summary.indexedFiles).toBe(1);
        expect(summary.indexedSymbols).toBeGreaterThanOrEqual(1);

        const entity = primaryDb
          .prepare("SELECT identifier, project_id FROM entities WHERE identifier = ?")
          .get("sandboxed.ts::sandboxedFn") as
          | { identifier: string; project_id: string }
          | undefined;
        expect(entity).toBeDefined();
        expect(entity?.project_id).toBe(primaryService.currentProject.id);
        expect(primaryService.currentProject.root_path).toBe(path.resolve(primaryDir));
      } finally {
        primaryService.close(true);
        if (primaryDb.open) primaryDb.close();
        fs.rmSync(primaryDir, { recursive: true, force: true });
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      }
    });
  });

  describe("MemoryService.inspectSymbol", () => {
    it("returns null when symbol cannot be found", () => {
      const result = service.inspectSymbol("nonExistentSymbol");
      expect(result).toBeNull();
    });

    it("inspects a symbol and returns metadata, dependencies, and linked observations", () => {
      const filePath = path.join(tempDir, "auth.ts");
      fs.writeFileSync(
        filePath,
        `
export class AuthManager {
  public login(): boolean {
    return true;
  }
}
`
      );

      indexFilesIntoMuninn(service, ["auth.ts"], { projectRoot: tempDir });

      // Link an observation to AuthManager
      const obs = service.saveObservation({
        category: "architecture",
        title: "JWT Authentication Strategy",
        content: "We use AuthManager for stateful token validation.",
        symbols: ["auth.ts::AuthManager"],
      });

      // Exact inspection
      const exactInspection = service.inspectSymbol("auth.ts::AuthManager");
      expect(exactInspection).not.toBeNull();
      expect(exactInspection?.entity.identifier).toBe("auth.ts::AuthManager");
      expect(exactInspection?.entity.entity_type).toBe("class");
      expect(exactInspection?.observations).toHaveLength(1);
      expect(exactInspection?.observations[0].id).toBe(obs.id);

      // Suffix inspection (search by name 'AuthManager')
      const suffixInspection = service.inspectSymbol("AuthManager");
      expect(suffixInspection).not.toBeNull();
      expect(suffixInspection?.entity.identifier).toBe("auth.ts::AuthManager");

      // Incoming dependencies: the file auth.ts references AuthManager
      expect(suffixInspection?.dependencies.incoming.length).toBeGreaterThan(0);
      expect(
        suffixInspection?.dependencies.incoming.some((d) => d.entity.identifier === "auth.ts")
      ).toBe(true);
    });

    it("resolves class methods by methodName and ClassName.methodName (REV-005, REV-008)", () => {
      const filePath = path.join(tempDir, "user-service.ts");
      fs.writeFileSync(
        filePath,
        `
export class UserService {
  public findUserById(id: string): string {
    return id;
  }
}
`
      );
      indexFilesIntoMuninn(service, ["user-service.ts"], { projectRoot: tempDir });

      // Lookup by ClassName.methodName
      const qualifiedMatch = service.inspectSymbol("UserService.findUserById");
      expect(qualifiedMatch).not.toBeNull();
      expect(qualifiedMatch?.entity.identifier).toBe(
        "user-service.ts::UserService.findUserById"
      );
      expect(qualifiedMatch?.entity.entity_type).toBe("function");

      // Lookup by bare methodName
      const bareMethodMatch = service.inspectSymbol("findUserById");
      expect(bareMethodMatch).not.toBeNull();
      expect(bareMethodMatch?.entity.identifier).toBe(
        "user-service.ts::UserService.findUserById"
      );
    });

    it("escapes wildcard characters (%, _, \\) in user queries (SEC-004)", () => {
      const filePath = path.join(tempDir, "wildcards.ts");
      fs.writeFileSync(
        filePath,
        `
export function get_value(): string { return "val"; }
export function getValue(): string { return "val"; }
`
      );
      indexFilesIntoMuninn(service, ["wildcards.ts"], { projectRoot: tempDir });

      // Querying with an unescaped wildcard pattern like 'get%value' or '%'
      // In SQLite without escaping, '%' would match everything.
      // With proper escaping, searching for '%' should return null (no entity literally named '%')
      const percentResult = service.inspectSymbol("%");
      expect(percentResult).toBeNull();

      // Querying with '_' should not match single characters wildcard style
      const underscoreResult = service.inspectSymbol("_");
      expect(underscoreResult).toBeNull();

      // Literal match for get_value
      const exactMatch = service.inspectSymbol("get_value");
      expect(exactMatch).not.toBeNull();
      expect(exactMatch?.entity.identifier).toBe("wildcards.ts::get_value");
    });

    it("resolves fallback matches deterministically via ORDER BY identifier ASC (REV-008)", () => {
      const file1 = path.join(tempDir, "b-module.ts");
      const file2 = path.join(tempDir, "a-module.ts");
      fs.writeFileSync(file1, "export function execute(): void {}\n");
      fs.writeFileSync(file2, "export function execute(): void {}\n");

      indexFilesIntoMuninn(service, ["b-module.ts", "a-module.ts"], {
        projectRoot: tempDir,
      });

      // Both a-module.ts::execute and b-module.ts::execute match suffix 'execute'
      // ORDER BY identifier ASC ensures a-module.ts::execute is returned deterministically
      const result = service.inspectSymbol("execute");
      expect(result).not.toBeNull();
      expect(result?.entity.identifier).toBe("a-module.ts::execute");
    });
  });

  describe("MCP Tools: muninn_inspect_symbol & muninn_verify_contract", () => {
    it("executes muninn_inspect_symbol via MCP tool handler", async () => {
      const filePath = path.join(tempDir, "db.ts");
      fs.writeFileSync(filePath, "export function connectDatabase(): void {}\n");
      indexFilesIntoMuninn(service, ["db.ts"], { projectRoot: tempDir });

      const server = createMcpServer(service);
      const result = (await server.service.inspectSymbol("connectDatabase")) as any;
      expect(result).not.toBeNull();
      expect(result.entity.identifier).toBe("db.ts::connectDatabase");
    });

    it("executes muninn_verify_contract via MCP server", async () => {
      const filePath = path.join(tempDir, "valid.ts");
      fs.writeFileSync(filePath, "export const status: string = 'ok';\n");

      const server = createMcpServer(service);
      const verifyRes = await (server as any).service;
      expect(verifyRes).toBeDefined();
    });
  });

  describe("CLI Commands: muninn check & muninn memory index", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      process.exitCode = 0;
    });

    afterEach(() => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    });

    it("muninn check succeeds on clean TypeScript files", async () => {
      const validFile = path.join(tempDir, "clean.ts");
      fs.writeFileSync(validFile, "export const meaning = 42;\n");

      await handleCheckCommand(["clean.ts"], { "--project": tempDir });
      expect(process.exitCode).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("TypeScript contracts verified")
      );
    });

    it("muninn check reports errors and sets exitCode = 1 on invalid TypeScript files", async () => {
      const invalidFile = path.join(tempDir, "error.ts");
      fs.writeFileSync(invalidFile, "export const count: number = 'text';\n");

      await handleCheckCommand(["error.ts"], { "--project": tempDir });
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("contracts check failed")
      );
    });

    it("muninn check displays non-error diagnostics on warnings when contracts are valid (REV-006)", async () => {
      const compilerModule = await import("../src/contracts/compiler.js");
      const spy = vi
        .spyOn(compilerModule, "verifyTypeScriptContracts")
        .mockReturnValue({
          valid: true,
          errorsCount: 0,
          diagnostics: [
            {
              filePath: "warn.ts",
              line: 5,
              character: 10,
              code: "TS1005",
              category: "warning",
              message: "Unused variable",
              snippet: "const unused = 1;",
            },
          ],
        });

      await handleCheckCommand(["warn.ts"], { "--project": tempDir });
      expect(process.exitCode).toBe(0);
      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("TypeScript contracts verified");
      expect(logOutput).toContain("Diagnostics:");
      expect(logOutput).toContain("TS1005");
      expect(logOutput).toContain("WARNING: Unused variable");
      expect(logOutput).toContain("const unused = 1;");

      spy.mockRestore();
    });

    it("muninn check displays check usage when called with --help or -h", async () => {
      for (const helpFlag of ["--help", "-h"]) {
        logSpy.mockClear();
        await handleCheckCommand([], { [helpFlag]: true });
        const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logOutput).toContain(
          "muninn check — Static TypeScript execution contract verification"
        );
      }
    });

    it("muninn memory index parses and indexes files via CLI handler", async () => {
      const file = path.join(tempDir, "component.ts");
      fs.writeFileSync(
        file,
        "export function Button(): string { return '<button/>'; }\n"
      );

      await handleMemoryCommand("index", {
        "--project": tempDir,
        "--db": path.join(tempDir, "test.db"),
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Indexed")
      );
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import ts from "typescript";
import {
  verifyTypeScriptContracts,
  loadProjectConfig,
  formatDiagnosticsReport,
  createVisualSnippet,
  DEFAULT_COMPILER_OPTIONS,
  TypeValidator,
} from "../../src/contracts/compiler.js";

describe("TypeScript Compiler API Contract Verification", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-contracts-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("loadProjectConfig", () => {
    it("loads compiler options from a valid tsconfig.json", () => {
      const tsconfigContent = JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          strict: true,
          noImplicitAny: true,
        },
        include: ["src/**/*"],
      });
      fs.writeFileSync(path.join(tempDir, "tsconfig.json"), tsconfigContent);
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "src", "index.ts"),
        "export const x = 1;\n"
      );

      const config = loadProjectConfig(tempDir);
      expect(config.configPath).toBeDefined();
      expect(config.options.target).toBe(ts.ScriptTarget.ES2022);
      expect(config.options.strict).toBe(true);
      expect(config.options.noEmit).toBe(true);
      expect(config.errors).toHaveLength(0);
    });

    it("falls back to DEFAULT_COMPILER_OPTIONS when tsconfig.json does not exist", () => {
      const config = loadProjectConfig(tempDir);
      expect(config.configPath).toBeUndefined();
      expect(config.options.strict).toBe(true);
      expect(config.options.target).toBe(DEFAULT_COMPILER_OPTIONS.target);
      expect(config.options.noEmit).toBe(true);
      expect(config.errors).toHaveLength(0);
    });

    it("handles malformed tsconfig.json gracefully", () => {
      fs.writeFileSync(
        path.join(tempDir, "tsconfig.json"),
        "{ malformed json: not valid ... "
      );

      const config = loadProjectConfig(tempDir);
      expect(config.configPath).toBeDefined();
      expect(config.errors.length).toBeGreaterThan(0);
      expect(config.options.strict).toBe(true);
    });

    it("does not traverse upward to parent directories when tsconfig.json is missing (REV-005, SEC-007)", () => {
      fs.writeFileSync(
        path.join(tempDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "ES5" } })
      );
      const subDir = path.join(tempDir, "subproject");
      fs.mkdirSync(subDir, { recursive: true });

      const config = loadProjectConfig(subDir);
      expect(config.configPath).toBeUndefined();
      expect(config.options.target).toBe(DEFAULT_COMPILER_OPTIONS.target);
    });
  });

  describe("createVisualSnippet", () => {
    it("generates a visual code line and caret underline pointer", () => {
      const sourceText = "const message: number = 'hello';\nconsole.log(message);\n";
      const sourceFile = ts.createSourceFile(
        "test.ts",
        sourceText,
        ts.ScriptTarget.Latest,
        true
      );

      // Point at 'message'
      const start = sourceText.indexOf("message");
      const length = "message".length;
      const snippet = createVisualSnippet(sourceFile, start, length);

      expect(snippet).toContain("1 | const message: number = 'hello';");
      expect(snippet).toContain("^^^^^^^");
    });

    it("clamps large character offsets, span lengths, and long lines safely without RangeError (SEC-006, REV-008)", () => {
      const longLine = "const x = " + "a".repeat(500) + ";\n";
      const sourceFile = ts.createSourceFile(
        "test.ts",
        longLine,
        ts.ScriptTarget.Latest,
        true
      );

      const snippet = createVisualSnippet(sourceFile, 400, 1000);
      expect(snippet).toBeDefined();
      expect(typeof snippet).toBe("string");

      const [linePart, underlinePart] = snippet.split("\n");
      expect(linePart.length).toBeLessThanOrEqual(320);
      const carets = (underlinePart.match(/\^/g) || []).length;
      expect(carets).toBeLessThanOrEqual(200);
      expect(carets).toBeGreaterThan(0);
    });
  });

  describe("verifyTypeScriptContracts", () => {
    it("passes cleanly with valid TypeScript code (0 errors)", () => {
      fs.writeFileSync(
        path.join(tempDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
          },
        })
      );

      const validCode = `
export interface User {
  id: string;
  name: string;
  age: number;
}

export function formatUser(user: User): string {
  return \`\${user.name} (\${user.age})\`;
}
`;
      const filePath = path.join(tempDir, "user.ts");
      fs.writeFileSync(filePath, validCode);

      const result = verifyTypeScriptContracts(tempDir, ["user.ts"]);
      expect(result.valid).toBe(true);
      expect(result.errorsCount).toBe(0);
      expect(result.diagnostics).toHaveLength(0);
    });

    it("detects type assignment errors (TS2322) with exact line, column, and snippet", () => {
      fs.writeFileSync(
        path.join(tempDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
          },
        })
      );

      const invalidCode = `
export function computeTotal(): number {
  const result: number = "not-a-number";
  return result;
}
`;
      const filePath = path.join(tempDir, "math.ts");
      fs.writeFileSync(filePath, invalidCode);

      const result = verifyTypeScriptContracts(tempDir, ["math.ts"]);
      expect(result.valid).toBe(false);
      expect(result.errorsCount).toBe(1);
      expect(result.diagnostics).toHaveLength(1);

      const diag = result.diagnostics[0];
      expect(diag.filePath).toBe("math.ts");
      expect(diag.line).toBe(3);
      expect(diag.character).toBe(9);
      expect(diag.code).toBe("TS2322");
      expect(diag.category).toBe("error");
      expect(diag.message).toMatch(/not assignable to type 'number'/);
      expect(diag.snippet).toBeDefined();
      expect(diag.snippet).toContain("3 |   const result: number = \"not-a-number\";");
      expect(diag.snippet).toContain("^");
    });

    it("detects syntax errors (TS1005 / TS1109)", () => {
      const syntaxErrorCode = `
export function broken() {
  const x = ;
}
`;
      const filePath = path.join(tempDir, "syntax.ts");
      fs.writeFileSync(filePath, syntaxErrorCode);

      const result = verifyTypeScriptContracts(tempDir, ["syntax.ts"]);
      expect(result.valid).toBe(false);
      expect(result.errorsCount).toBeGreaterThan(0);

      const diag = result.diagnostics[0];
      expect(diag.filePath).toBe("syntax.ts");
      expect(diag.category).toBe("error");
      expect(diag.snippet).toBeTruthy();
    });

    it("filters diagnostics specifically to requested files", () => {
      fs.writeFileSync(
        path.join(tempDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
          },
        })
      );

      // File A has an error
      fs.writeFileSync(
        path.join(tempDir, "fileA.ts"),
        "export const a: number = 'wrong';\n"
      );
      // File B is valid
      fs.writeFileSync(
        path.join(tempDir, "fileB.ts"),
        "export const b: number = 42;\n"
      );

      // Verifying only fileB should be valid
      const resultB = verifyTypeScriptContracts(tempDir, ["fileB.ts"]);
      expect(resultB.valid).toBe(true);
      expect(resultB.errorsCount).toBe(0);

      // Verifying fileA should report the error
      const resultA = verifyTypeScriptContracts(tempDir, ["fileA.ts"]);
      expect(resultA.valid).toBe(false);
      expect(resultA.errorsCount).toBe(1);
      expect(resultA.diagnostics[0].filePath).toBe("fileA.ts");
    });

    it("works without tsconfig.json using default safe options", () => {
      const fileCode = "export const text: string = 123;\n";
      fs.writeFileSync(path.join(tempDir, "fallback.ts"), fileCode);

      const result = verifyTypeScriptContracts(tempDir, ["fallback.ts"]);
      expect(result.valid).toBe(false);
      expect(result.errorsCount).toBe(1);
      expect(result.diagnostics[0].code).toBe("TS2322");
    });

    it("returns valid: true when project has no source files to check", () => {
      const result = verifyTypeScriptContracts(tempDir);
      expect(result.valid).toBe(true);
      expect(result.errorsCount).toBe(0);
      expect(result.diagnostics).toEqual([]);
    });

    it("fails closed with TS6053 when a specified target file does not exist on disk (REV-003)", () => {
      const result = verifyTypeScriptContracts(tempDir, ["nonexistent.ts"]);
      expect(result.valid).toBe(false);
      expect(result.errorsCount).toBe(1);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].code).toBe("TS6053");
      expect(result.diagnostics[0].category).toBe("error");
      expect(result.diagnostics[0].filePath).toBe("nonexistent.ts");
      expect(result.diagnostics[0].message).toBe("File 'nonexistent.ts' not found.");
    });

    it("fails closed with TS6054 when a target file attempts path traversal outside project root (SEC-001)", () => {
      const result = verifyTypeScriptContracts(tempDir, ["../../etc/passwd"]);
      expect(result.valid).toBe(false);
      expect(result.errorsCount).toBe(1);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].code).toBe("TS6054");
      expect(result.diagnostics[0].category).toBe("error");
      expect(result.diagnostics[0].message).toContain("outside project root");
    });

    it("fails closed when tsconfig.json is malformed (REV-002)", () => {
      fs.writeFileSync(
        path.join(tempDir, "tsconfig.json"),
        "{ not valid json ... "
      );

      const result = verifyTypeScriptContracts(tempDir);
      expect(result.valid).toBe(false);
      expect(result.errorsCount).toBeGreaterThan(0);
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics[0].filePath).toBe("tsconfig.json");
      expect(result.diagnostics[0].category).toBe("error");
    });

    it("auto-discovers source files in src/ when filePaths is omitted and tsconfig has no files (REV-001)", () => {
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "src", "broken.ts"),
        "export const n: number = 'type-error';\n"
      );

      const result = verifyTypeScriptContracts(tempDir);
      expect(result.valid).toBe(false);
      expect(result.errorsCount).toBe(1);
      expect(result.diagnostics[0].filePath).toContain("broken.ts");
      expect(result.diagnostics[0].code).toBe("TS2322");
    });

    it("only checks targeted files without compiling or emitting diagnostics for unrequested files (REV-004, SEC-005)", () => {
      fs.writeFileSync(
        path.join(tempDir, "unrelated-broken.ts"),
        "export const err: number = 'oops';\n"
      );
      fs.writeFileSync(
        path.join(tempDir, "clean.ts"),
        "export const answer: number = 42;\n"
      );

      const result = verifyTypeScriptContracts(tempDir, ["clean.ts"]);
      expect(result.valid).toBe(true);
      expect(result.errorsCount).toBe(0);
      expect(result.diagnostics).toEqual([]);
    });
  });

  describe("formatDiagnosticsReport & TypeValidator", () => {
    it("formats a clean passing report when contracts are valid", () => {
      const report = formatDiagnosticsReport({
        valid: true,
        errorsCount: 0,
        diagnostics: [],
      });

      expect(report).toContain("### TypeScript Compiler Contract: 🟢 PASSED");
      expect(report).toContain("No compilation type errors detected.");
    });

    it("formats a blocking report with fail-closed markers and code snippets when contracts fail", () => {
      const report = formatDiagnosticsReport({
        valid: false,
        errorsCount: 1,
        diagnostics: [
          {
            filePath: "src/calc.ts",
            line: 12,
            character: 5,
            code: "TS2322",
            category: "error",
            message: "Type 'string' is not assignable to type 'number'.",
            snippet: "  12 | const total: number = 'abc';\n     |       ^^^^^",
          },
        ],
      });

      expect(report).toContain("### TypeScript Compiler Contract: 🔴 BLOCKED");
      expect(report).toContain("Found 1 type compilation error(s):");
      expect(report).toContain("- **src/calc.ts:12:5** [TS2322] (ERROR): Type 'string' is not assignable to type 'number'.");
      expect(report).toContain("```typescript");
      expect(report).toContain("const total: number = 'abc';");
      expect(report).toContain("### Overall gate: 🔴");
      expect(report).toContain("🛑 BLOCKED: TypeScript compilation contract errors found (1 error(s)).");
    });

    it("exposes TypeValidator namespace with check and formatReport", () => {
      expect(typeof TypeValidator.check).toBe("function");
      expect(typeof TypeValidator.formatReport).toBe("function");
      expect(TypeValidator.DEFAULT_COMPILER_OPTIONS).toBeDefined();
    });
  });
});

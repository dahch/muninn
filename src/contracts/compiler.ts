import path from "node:path";
import fs from "node:fs";
import ts from "typescript";

export type DiagnosticCategoryName =
  | "error"
  | "warning"
  | "message"
  | "suggestion";

export interface FormattedDiagnostic {
  filePath: string;
  line: number;
  character: number;
  code: string;
  category: DiagnosticCategoryName;
  message: string;
  snippet?: string;
}

export interface ContractVerificationResult {
  valid: boolean;
  errorsCount: number;
  diagnostics: FormattedDiagnostic[];
}

/**
 * Safe default TypeScript compiler options used when tsconfig.json is absent or invalid.
 */
export const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  allowJs: true,
  noEmit: true,
};

function mapDiagnosticCategory(
  category: ts.DiagnosticCategory
): DiagnosticCategoryName {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
    default:
      return "message";
  }
}

/**
 * Creates a formatted visual snippet of the line of code containing the error,
 * with a caret pointer underlining the exact error span.
 * Clamps input positions, line lengths, and span lengths to bounded limits (SEC-006, REV-008).
 */
export function createVisualSnippet(
  sourceFile: ts.SourceFile,
  start: number,
  length: number = 1
): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
  const lineStarts = sourceFile.getLineStarts();
  const lineStartPos = lineStarts[line];
  const lineEndPos =
    line < lineStarts.length - 1
      ? lineStarts[line + 1]
      : sourceFile.text.length;

  const rawLineText = sourceFile.text
    .substring(lineStartPos, lineEndPos)
    .replace(/\r?\n$/, "");

  // Clamp line text length to max 300 to avoid huge string allocations
  const lineText =
    rawLineText.length > 300 ? rawLineText.substring(0, 300) : rawLineText;

  const lineNumStr = String(line + 1);
  // Clamp character indentation to max 300
  const safeCharacter = Math.min(Math.max(0, character), 300);
  const indent = " ".repeat(safeCharacter);

  // Clamp span length between 1 and 200, bounded by remaining line text
  const maxSpan = Math.max(1, lineText.length - safeCharacter);
  const spanLength = Math.max(
    1,
    Math.min(length || 1, maxSpan, 200)
  );
  const underline = "^".repeat(spanLength);

  return `${lineNumStr} | ${lineText}\n${" ".repeat(lineNumStr.length)} | ${indent}${underline}`;
}

/**
 * Formats a raw TypeScript compiler diagnostic into a structured FormattedDiagnostic.
 */
export function formatDiagnostic(
  diagnostic: ts.Diagnostic,
  projectRoot: string
): FormattedDiagnostic {
  const category = mapDiagnosticCategory(diagnostic.category);
  const code = `TS${diagnostic.code}`;
  const message = ts.flattenDiagnosticMessageText(
    diagnostic.messageText,
    "\n"
  );

  if (!diagnostic.file || diagnostic.start === undefined) {
    return {
      filePath: "tsconfig.json",
      line: 1,
      character: 1,
      code,
      category,
      message,
      snippet: undefined,
    };
  }

  const sourceFile = diagnostic.file;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    diagnostic.start
  );
  const relativePath = path.relative(projectRoot, sourceFile.fileName);
  const snippet = createVisualSnippet(
    sourceFile,
    diagnostic.start,
    diagnostic.length ?? 1
  );

  return {
    filePath: relativePath || sourceFile.fileName,
    line: line + 1,
    character: character + 1,
    code,
    category,
    message,
    snippet,
  };
}

/**
 * Loads tsconfig.json strictly from projectRoot without walking up parent directories (REV-005, SEC-007).
 */
export function loadProjectConfig(projectRoot: string): {
  configPath: string | undefined;
  options: ts.CompilerOptions;
  fileNames: string[];
  errors: ts.Diagnostic[];
} {
  const resolvedRoot = path.resolve(projectRoot);
  const configPath = path.join(resolvedRoot, "tsconfig.json");

  if (!fs.existsSync(configPath)) {
    return {
      configPath: undefined,
      options: { ...DEFAULT_COMPILER_OPTIONS },
      fileNames: [],
      errors: [],
    };
  }

  const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
  if (readResult.error) {
    return {
      configPath,
      options: { ...DEFAULT_COMPILER_OPTIONS },
      fileNames: [],
      errors: [readResult.error],
    };
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    path.dirname(configPath)
  );

  return {
    configPath,
    options: {
      ...DEFAULT_COMPILER_OPTIONS,
      ...parsedConfig.options,
      noEmit: true,
    },
    fileNames: parsedConfig.fileNames,
    errors: parsedConfig.errors ?? [],
  };
}

export const TS_JS_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/**
 * Recursively discovers TypeScript/JavaScript source files within a directory.
 */
export function findSourceFilesInDir(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        results.push(...findSourceFilesInDir(fullPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (TS_JS_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  } catch {
    // Ignore unreadable paths
  }
  return results;
}

export type ResolveTargetFilesResult =
  | { success: true; targetFiles?: string[] }
  | { success: false; failure: ContractVerificationResult };

/**
 * Validates requested file paths against path traversal and file existence (SEC-001, REV-003).
 */
export function resolveTargetFiles(
  projectRoot: string,
  filePaths?: string[]
): ResolveTargetFilesResult {
  if (!filePaths || filePaths.length === 0) {
    return { success: true, targetFiles: undefined };
  }

  const targetFiles: string[] = [];
  for (const f of filePaths) {
    const resolved = path.resolve(projectRoot, f);
    const rel = path.relative(projectRoot, resolved);

    // Path traversal containment check (SEC-001)
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        success: false,
        failure: {
          valid: false,
          errorsCount: 1,
          diagnostics: [
            {
              filePath: f,
              line: 1,
              character: 1,
              code: "TS6054",
              category: "error",
              message: `File '${f}' is outside project root.`,
            },
          ],
        },
      };
    }

    // Fail-closed non-existent file check (REV-003)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      const relPath = rel || f;
      return {
        success: false,
        failure: {
          valid: false,
          errorsCount: 1,
          diagnostics: [
            {
              filePath: relPath,
              line: 1,
              character: 1,
              code: "TS6053",
              category: "error",
              message: `File '${relPath}' not found.`,
            },
          ],
        },
      };
    }

    targetFiles.push(resolved);
  }

  return { success: true, targetFiles };
}

/**
 * Verifies TypeScript compilation contracts for the given project and files.
 * Returns structured pre-emit diagnostics with line/character locations and visual code snippets.
 */
export function verifyTypeScriptContracts(
  projectRoot: string,
  filePaths?: string[]
): ContractVerificationResult {
  const resolvedRoot = path.resolve(projectRoot);

  // 1. Resolve and validate target files for path traversal and missing files (SEC-001, REV-003)
  const targetResolution = resolveTargetFiles(resolvedRoot, filePaths);
  if (!targetResolution.success) {
    return targetResolution.failure;
  }
  const targetFiles = targetResolution.targetFiles;
  const targetFilesSet = targetFiles
    ? new Set(targetFiles.map((f) => path.resolve(f)))
    : undefined;

  // 2. Load configuration strictly from project root (REV-005, SEC-007)
  const { configPath, options, fileNames, errors: configErrors } =
    loadProjectConfig(resolvedRoot);

  // 3. Fail-closed on configuration parse errors (REV-002)
  if (configErrors && configErrors.length > 0) {
    const formattedDiagnostics = configErrors.map((d) =>
      formatDiagnostic(d, resolvedRoot)
    );
    const errorsCount = formattedDiagnostics.filter(
      (d) => d.category === "error"
    ).length;
    return {
      valid: errorsCount === 0,
      errorsCount,
      diagnostics: formattedDiagnostics,
    };
  }

  // 4. Determine rootNames (REV-001, REV-004, SEC-005)
  let rootNames: string[];
  if (targetFiles && targetFiles.length > 0) {
    rootNames = targetFiles;
  } else if (fileNames.length > 0) {
    rootNames = fileNames.map((fn) => path.resolve(fn));
  } else {
    // If tsconfig not present or has no files, check for sources in src/
    const srcDir = path.join(resolvedRoot, "src");
    if (fs.existsSync(srcDir)) {
      rootNames = findSourceFilesInDir(srcDir);
    } else {
      rootNames = [];
    }
  }

  // If no files to check, return cleanly
  if (rootNames.length === 0) {
    return {
      valid: true,
      errorsCount: 0,
      diagnostics: [],
    };
  }

  // 5. Create TypeScript program with targeted rootNames (REV-004)
  const program = ts.createProgram({
    rootNames,
    options,
    configFileParsingDiagnostics: configErrors,
  });

  // 6. Targeted diagnostics: iterate over target files instead of full program (REV-004, SEC-005)
  const checkFiles = targetFiles ?? rootNames;
  const rawDiagnostics: ts.Diagnostic[] = [];

  rawDiagnostics.push(...program.getOptionsDiagnostics());
  rawDiagnostics.push(...program.getGlobalDiagnostics());

  for (const tf of checkFiles) {
    const normalized = path.resolve(tf);
    const sourceFile =
      program.getSourceFile(normalized) ||
      program.getSourceFile(normalized.replace(/\\/g, "/")) ||
      program.getSourceFiles().find((s) => path.resolve(s.fileName) === normalized);

    if (sourceFile) {
      rawDiagnostics.push(...ts.getPreEmitDiagnostics(program, sourceFile));
    }
  }

  // Deduplicate raw diagnostics
  const seen = new Set<string>();
  const uniqueDiagnostics: ts.Diagnostic[] = [];
  for (const diag of rawDiagnostics) {
    const key = `${diag.file?.fileName}:${diag.start}:${diag.code}:${typeof diag.messageText === "string" ? diag.messageText : diag.messageText.messageText}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueDiagnostics.push(diag);
    }
  }

  // 7. Filter diagnostics with trailing separator check (SEC-004)
  const rootWithSep = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;

  const filteredDiagnostics: ts.Diagnostic[] = [];
  for (const diag of uniqueDiagnostics) {
    if (!diag.file) {
      filteredDiagnostics.push(diag);
      continue;
    }

    const diagFilePath = path.resolve(diag.file.fileName);

    // Skip node_modules diagnostics
    if (diagFilePath.includes("node_modules")) {
      continue;
    }

    if (targetFilesSet) {
      if (targetFilesSet.has(diagFilePath)) {
        filteredDiagnostics.push(diag);
      }
    } else {
      if (diagFilePath.startsWith(rootWithSep) || diagFilePath === resolvedRoot) {
        filteredDiagnostics.push(diag);
      }
    }
  }

  const formattedDiagnostics = filteredDiagnostics.map((d) =>
    formatDiagnostic(d, resolvedRoot)
  );
  const errorsCount = formattedDiagnostics.filter(
    (d) => d.category === "error"
  ).length;

  return {
    valid: errorsCount === 0,
    errorsCount,
    diagnostics: formattedDiagnostics,
  };
}

/**
 * Formats a ContractVerificationResult into a markdown report suitable for
 * gate evaluation and thinker fix prompts.
 */
export function formatDiagnosticsReport(
  result: ContractVerificationResult
): string {
  if (result.valid) {
    return "### TypeScript Compiler Contract: 🟢 PASSED\n\nNo compilation type errors detected.";
  }

  const lines: string[] = [
    `### TypeScript Compiler Contract: 🔴 BLOCKED`,
    `Found ${result.errorsCount} type compilation error(s):\n`,
  ];

  for (const d of result.diagnostics) {
    lines.push(
      `- **${d.filePath}:${d.line}:${d.character}** [${d.code}] (${d.category.toUpperCase()}): ${d.message}`
    );
    if (d.snippet) {
      lines.push("```typescript\n" + d.snippet + "\n```");
    }
  }

  lines.push("\n### Overall gate: 🔴");
  lines.push(
    `🛑 BLOCKED: TypeScript compilation contract errors found (${result.errorsCount} error(s)).`
  );

  return lines.join("\n");
}

export const TypeValidator = {
  check: verifyTypeScriptContracts,
  formatReport: formatDiagnosticsReport,
  DEFAULT_COMPILER_OPTIONS,
};

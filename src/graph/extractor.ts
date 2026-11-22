/**
 * Structural extraction for the code graph.
 *
 * Tier A uses the TypeScript compiler for TypeScript/JavaScript: precise spans,
 * imports, heritage and local call sites. Every other language gets a
 * grammar-free heuristic scan (Tier C) so a project is never a blank graph. Both
 * produce the same shape and every edge carries its confidence.
 */
import path from "node:path";
import ts from "typescript";
import {
  detectLanguage,
  normalizePath,
  isGeneratedFile,
  isTestFile,
} from "./languages.js";
import type {
  CodeEdgeKind,
  CodeSymbolKind,
  ExtractedEdge,
  ExtractedFile,
  ExtractedSymbol,
} from "./types.js";

const MAX_SYMBOLS_PER_FILE = 4_000;
const MAX_EDGES_PER_FILE = 4_000;
const MAX_SIGNATURE = 240;

function collectDoc(rawLines: string[], startLine: number): string | null {
  const docs: string[] = [];
  for (let index = startLine - 2; index >= 0 && docs.length < 12; index--) {
    const line = rawLines[index]?.trim() ?? "";
    if (line.length === 0) {
      if (docs.length > 0) break;
      continue;
    }
    if (
      line.startsWith("//") ||
      line.startsWith("#") ||
      line.startsWith("*") ||
      line.startsWith("/*") ||
      line.startsWith("--") ||
      line.startsWith('"""') ||
      line.startsWith("'''")
    ) {
      docs.unshift(line.replace(/^\/\*\*?|^\/\/\/?|^\*\s?|^#\s?|^--\s?/g, "").trim());
      continue;
    }
    break;
  }
  const doc = docs.filter(Boolean).join(" ").trim();
  return doc ? doc.slice(0, 500) : null;
}

function makeBuilder(filePath: string) {
  const used = new Set<string>();
  function qualify(symbol: ExtractedSymbol): string {
    const base = `${filePath}::${symbol.parentName ? `${symbol.parentName}.` : ""}${symbol.name}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}@${symbol.startLine}#${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  }
  return { qualify };
}

// ---------------------------------------------------------------------------
// Tier A — TypeScript / JavaScript
// ---------------------------------------------------------------------------

function resolveRelativeSpecifier(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  // Keep the specifier as written (minus a redundant `./`); the indexer tries
  // the real extensions, so a JavaScript project is not mapped to `.ts`.
  return normalizePath(path.join(path.dirname(fromPath), specifier));
}

const TS_CALL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "typeof",
  "new",
  "super",
  "import",
  "require",
  "constructor",
]);

export function extractTypeScript(
  filePath: string,
  sourceText: string
): ExtractedFile {
  const language = detectLanguage(filePath) ?? "typescript";
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    false
  );
  const rawLines = sourceText.split(/\r?\n/);
  const symbols: ExtractedSymbol[] = [];
  const edges: ExtractedEdge[] = [];
  const { qualify } = makeBuilder(filePath);
  const lineOf = (pos: number): number =>
    sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  const signatureOf = (node: ts.Node): string =>
    sourceText
      .slice(node.getStart(sourceFile), node.getEnd())
      .split("\n")[0]
      .slice(0, MAX_SIGNATURE)
      .trim();

  function addSymbol(
    node: ts.Node,
    name: string,
    kind: CodeSymbolKind,
    parentName: string | null,
    isExported: boolean,
    startNode: ts.Node = node
  ): string {
    const startLine = lineOf(startNode.getStart(sourceFile));
    const symbol: ExtractedSymbol = {
      name,
      kind,
      startLine,
      endLine: lineOf(node.getEnd()),
      startCol: sourceFile.getLineAndCharacterOfPosition(startNode.getStart(sourceFile)).character,
      signature: signatureOf(startNode),
      doc: collectDoc(rawLines, startLine),
      isExported,
      parentName,
      visibility: hasPrivateModifier(node) ? "private" : isExported ? "public" : "internal",
    };
    symbol.qualified = qualify(symbol);
    symbols.push(symbol);
    edges.push({
      src: filePath,
      kind: "contains",
      target: symbol.qualified!,
      targetFile: filePath,
      line: startLine,
      confidence: "exact",
    });
    return symbol.qualified!;
  }

  function hasPrivateModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    return Boolean(
      ts
        .getModifiers(node)
        ?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.PrivateKeyword ||
            modifier.kind === ts.SyntaxKind.ProtectedKeyword
        )
    );
  }

  function isExportedNode(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    return Boolean(
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    );
  }

  function recordImport(moduleSpecifier: string, names: string[], line: number): void {
    const targetFile = resolveRelativeSpecifier(filePath, moduleSpecifier);
    edges.push({
      src: filePath,
      kind: "imports",
      target: moduleSpecifier,
      targetFile,
      line,
      confidence: targetFile ? "exact" : "heuristic",
    });
    for (const name of names) {
      edges.push({
        src: filePath,
        kind: "references",
        target: name,
        targetFile,
        line,
        confidence: targetFile ? "exact" : "heuristic",
      });
    }
  }

  function visit(node: ts.Node, current: string | null): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names: string[] = [];
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.push(element.name.text);
      }
      if (node.importClause?.name) names.push(node.importClause.name.text);
      recordImport(node.moduleSpecifier.text, names, lineOf(node.getStart(sourceFile)));
      return;
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      recordImport(node.moduleSpecifier.text, [], lineOf(node.getStart(sourceFile)));
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      const qualified = addSymbol(
        node,
        node.name.text,
        "function",
        null,
        isExportedNode(node)
      );
      ts.forEachChild(node, (child) => visit(child, qualified));
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        ) {
          const qualified = addSymbol(
            declaration.initializer,
            declaration.name.text,
            "function",
            null,
            isExportedNode(node),
            declaration
          );
          ts.forEachChild(declaration.initializer, (child) => visit(child, qualified));
        }
      }
      return;
    }

    if (ts.isClassDeclaration(node)) {
      const name = node.name?.text ?? "AnonymousClass";
      const qualified = addSymbol(
        node,
        name,
        "class",
        null,
        isExportedNode(node),
        node.name ?? node
      );
      for (const clause of node.heritageClauses ?? []) {
        const kind: CodeEdgeKind =
          clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
        for (const typeNode of clause.types) {
          edges.push({
            src: qualified,
            kind,
            target: typeNode.expression.getText(sourceFile),
            line: lineOf(typeNode.getStart(sourceFile)),
            confidence: "heuristic",
          });
        }
      }
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          if (hasPrivateModifier(member)) continue;
          const methodQualified = addSymbol(
            member,
            member.name.text,
            "method",
            name,
            isExportedNode(node),
            member.name
          );
          ts.forEachChild(member, (child) => visit(child, methodQualified));
        }
      }
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      const qualified = addSymbol(
        node,
        node.name.text,
        "interface",
        null,
        isExportedNode(node)
      );
      for (const clause of node.heritageClauses ?? []) {
        for (const typeNode of clause.types) {
          edges.push({
            src: qualified,
            kind: "extends",
            target: typeNode.expression.getText(sourceFile),
            line: lineOf(typeNode.getStart(sourceFile)),
            confidence: "heuristic",
          });
        }
      }
      return;
    }

    if (ts.isTypeAliasDeclaration(node)) {
      addSymbol(node, node.name.text, "type", null, isExportedNode(node));
      return;
    }

    if (ts.isEnumDeclaration(node)) {
      addSymbol(node, node.name.text, "enum", null, isExportedNode(node));
      return;
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression;
      let name: string | null = null;
      if (ts.isIdentifier(expression)) name = expression.text;
      else if (ts.isPropertyAccessExpression(expression)) name = expression.name.text;
      if (name && !TS_CALL_KEYWORDS.has(name) && symbols.length < MAX_SYMBOLS_PER_FILE) {
        edges.push({
          src: current ?? filePath,
          kind: "calls",
          target: name,
          line: lineOf(node.getStart(sourceFile)),
          confidence: "heuristic",
        });
      }
    }

    ts.forEachChild(node, (child) => visit(child, current));
  }

  visit(sourceFile, null);

  return {
    path: normalizePath(filePath),
    language,
    symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE),
    edges: edges.slice(0, MAX_EDGES_PER_FILE),
  };
}

// ---------------------------------------------------------------------------
// Tier C — heuristic scan for every other language
// ---------------------------------------------------------------------------

const CALL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "sizeof",
  "typeof",
  "new",
  "delete",
  "import",
  "require",
  "function",
  "def",
  "fn",
  "func",
  "class",
  "struct",
  "match",
  "print",
  "println",
  "printf",
  "echo",
]);

interface HeuristicPattern {
  regex: RegExp;
  kind: CodeSymbolKind;
  nameGroup: number;
  parentGroup?: number;
  exported?: boolean;
}

function patternsFor(language: string): HeuristicPattern[] {
  switch (language) {
    case "python":
      return [
        { regex: /^(\s*)class\s+(\w+)/, kind: "class", nameGroup: 2 },
        { regex: /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/, kind: "function", nameGroup: 2 },
        { regex: /^(\s*)([A-Z][A-Z0-9_]{2,})\s*=/, kind: "constant", nameGroup: 2 },
      ];
    case "go":
      return [
        { regex: /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/, kind: "function", nameGroup: 1 },
        { regex: /^\s*type\s+(\w+)\s+struct\b/, kind: "struct", nameGroup: 1 },
        { regex: /^\s*type\s+(\w+)\s+interface\b/, kind: "interface", nameGroup: 1 },
        { regex: /^\s*type\s+(\w+)\s+/, kind: "type", nameGroup: 1 },
      ];
    case "rust":
      return [
        { regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/, kind: "function", nameGroup: 1 },
        { regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: "struct", nameGroup: 1 },
        { regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, kind: "enum", nameGroup: 1 },
        { regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, kind: "trait", nameGroup: 1 },
        { regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+(\w+)/, kind: "type", nameGroup: 1 },
        { regex: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?(\w+)/, kind: "class", nameGroup: 1 },
      ];
    case "java":
    case "kotlin":
    case "scala":
    case "csharp":
    case "swift":
    case "dart":
      return [
        { regex: /^\s*(?:public\s+|private\s+|protected\s+|internal\s+|open\s+|final\s+|abstract\s+)*(?:class|record|object)\s+(\w+)/, kind: "class", nameGroup: 1 },
        { regex: /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)*(?:interface|protocol)\s+(\w+)/, kind: "interface", nameGroup: 1 },
        { regex: /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)*enum(?:\s+class)?\s+(\w+)/, kind: "enum", nameGroup: 1 },
        { regex: /^\s*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|abstract\s+|async\s+|override\s+|suspend\s+|open\s+|external\s+|native\s+|sync\s+|mutating\s+)*[\w<>\[\],.?]+\s+(\w+)\s*\([^;]*\)\s*(?:[:{]|throws|=>)/, kind: "method", nameGroup: 1 },
      ];
    case "c":
    case "cpp":
      return [
        { regex: /^\s*(?:typedef\s+)?(?:class|struct|union)\s+(\w+)/, kind: "struct", nameGroup: 1 },
        { regex: /^\s*enum(?:\s+class)?\s+(\w+)/, kind: "enum", nameGroup: 1 },
        { regex: /^\s*(?:[A-Za-z_][\w:<>,*&\s]*?)\s+(\w+)\s*\([^;]*\)\s*(?:const\s*)?\{/, kind: "function", nameGroup: 1 },
        { regex: /^\s*#define\s+(\w+)/, kind: "macro", nameGroup: 1 },
      ];
    case "ruby":
      return [
        { regex: /^\s*class\s+(\w+(?:::\w+)*)/, kind: "class", nameGroup: 1 },
        { regex: /^\s*module\s+(\w+)/, kind: "module", nameGroup: 1 },
        { regex: /^\s*def\s+(?:self\.)?(\w+[?!=]?)/, kind: "method", nameGroup: 1 },
      ];
    case "php":
      return [
        { regex: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, kind: "class", nameGroup: 1 },
        { regex: /^\s*interface\s+(\w+)/, kind: "interface", nameGroup: 1 },
        { regex: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+(\w+)\s*\(/, kind: "function", nameGroup: 1 },
      ];
    case "lua":
      return [
        { regex: /^\s*(?:local\s+)?function\s+([\w.:]+)\s*\(/, kind: "function", nameGroup: 1 },
      ];
    case "shell":
      return [
        { regex: /^\s*(?:function\s+)?(\w+)\s*\(\)\s*\{/, kind: "function", nameGroup: 1 },
      ];
    case "sql":
      return [
        { regex: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."`]+)/i, kind: "class", nameGroup: 1 },
      ];
    case "elixir":
      return [
        { regex: /^\s*defmodule\s+([\w.]+)/, kind: "module", nameGroup: 1 },
        { regex: /^\s*defp?\s+(\w+[?!]?)/, kind: "function", nameGroup: 1 },
      ];
    default:
      return [
        { regex: /^\s*(?:export\s+)?(?:async\s+)?(?:function|def|fn|func)\s+(\w+)/, kind: "function", nameGroup: 1 },
        { regex: /^\s*(?:export\s+)?(?:class|interface|struct|trait|enum|type)\s+(\w+)/, kind: "class", nameGroup: 1 },
      ];
  }
}

function resolveHeuristicImport(
  filePath: string,
  language: string,
  rawLine: string,
  specifier: string
): string | null {
  if (language === "python") {
    const relative = rawLine.match(/^\s*from\s+(\.+)([\w.]*)\s+import/);
    if (relative) {
      let base = path.posix.dirname(filePath);
      for (let index = 1; index < relative[1].length; index++) {
        base = path.posix.dirname(base);
      }
      const modulePath = relative[2].replace(/\./g, "/");
      return normalizePath(path.posix.join(base, modulePath));
    }
    const absolute = rawLine.match(/^\s*from\s+([\w.]+)\s+import/);
    if (absolute) return absolute[1].replace(/\./g, "/");
    const plain = rawLine.match(/^\s*import\s+([\w.]+)/);
    if (plain) return plain[1].replace(/\./g, "/");
  }
  if (language === "ruby" && /require_relative/.test(rawLine)) {
    return normalizePath(path.posix.join(path.posix.dirname(filePath), specifier));
  }
  return null;
}

const IMPORT_PATTERNS: RegExp[] = [
  /^\s*#include\s+[<"]([^>"]+)[>"]/,
  /^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?;?$/,
  /^\s*from\s+([\w.]+)\s+import\s+/,
  /^\s*import\s+"([^"]+)"/,
  /^\s*use\s+([\w:]+)/,
  /^\s*package\s+([\w.]+);?/,
  /^\s*(?:require|require_relative)\s+['"]([^'"]+)['"]/,
  /^\s*using\s+([\w.]+);/,
];

const CALL_REGEX = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

export function extractHeuristic(filePath: string, sourceText: string): ExtractedFile {
  const language = detectLanguage(filePath) ?? "unknown";
  const rawLines = sourceText.split(/\r?\n/);
  const symbols: ExtractedSymbol[] = [];
  const edges: ExtractedEdge[] = [];
  const { qualify } = makeBuilder(filePath);
  const patterns = patternsFor(language);
  // Enclosing symbol for call attribution. Heuristic languages have no AST, so
  // the scope is the last symbol declared at an indentation level shallower than
  // the current line; a line at the same or lower indentation ends it.
  let classScope: string | null = null;
  let classIndent = -1;
  let scopeQualified: string | null = null;
  let scopeIndent = -1;

  for (let index = 0; index < rawLines.length; index++) {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
    const rawLine = rawLines[index];
    const lineNumber = index + 1;
    if (rawLine.trim().length === 0) continue;

    for (const pattern of IMPORT_PATTERNS) {
      const match = rawLine.match(pattern);
      if (match) {
        edges.push({
          src: filePath,
          kind: "imports",
          target: match[1],
          targetFile: resolveHeuristicImport(filePath, language, rawLine, match[1]),
          line: lineNumber,
          confidence: "heuristic",
        });
        break;
      }
    }

    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    for (const pattern of patterns) {
      const match = rawLine.match(pattern.regex);
      if (!match) continue;
      const name = match[pattern.nameGroup];
      if (!name || CALL_KEYWORDS.has(name)) continue;
      // Method patterns inside a class keep the class as parent.
      let parentName: string | null = null;
      if (pattern.kind === "method" && classScope && indent > classIndent) {
        parentName = classScope;
      }
      const symbol: ExtractedSymbol = {
        name,
        kind: pattern.kind,
        startLine: lineNumber,
        endLine: lineNumber,
        startCol: indent,
        signature: rawLine.trim().slice(0, MAX_SIGNATURE),
        doc: collectDoc(rawLines, lineNumber),
        isExported: !rawLine.trim().startsWith("_") && !/\bprivate\b/.test(rawLine),
        parentName,
      };
      symbol.qualified = qualify(symbol);
      symbols.push(symbol);
      edges.push({
        src: filePath,
        kind: "contains",
        target: symbol.qualified,
        targetFile: filePath,
        line: lineNumber,
        confidence: "heuristic",
      });
      if (pattern.kind === "class" || pattern.kind === "struct" || pattern.kind === "trait" || pattern.kind === "module") {
        classScope = name;
        classIndent = indent;
      }
      scopeQualified = symbol.qualified ?? null;
      scopeIndent = indent;
      break;
    }

    const isDefinitionLine = symbols.some((symbol) => symbol.startLine === lineNumber);
    if (!isDefinitionLine && scopeQualified && indent <= scopeIndent) {
      // A new statement at the declaration's indentation closes the previous
      // function body.
      scopeQualified = null;
      scopeIndent = -1;
    }
    if (!isDefinitionLine) {
      for (const match of rawLine.matchAll(CALL_REGEX)) {
        const name = match[1];
        if (CALL_KEYWORDS.has(name)) continue;
        edges.push({
          src: scopeQualified ?? filePath,
          kind: "calls",
          target: name,
          line: lineNumber,
          confidence: "heuristic",
        });
        if (edges.length >= MAX_EDGES_PER_FILE) break;
      }
    }
    if (edges.length >= MAX_EDGES_PER_FILE) break;
  }

  return {
    path: normalizePath(filePath),
    language,
    symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE),
    edges: edges.slice(0, MAX_EDGES_PER_FILE),
  };
}

/** Extracts a file with the best available tier. */
export function extractFile(
  filePath: string,
  sourceText: string
): ExtractedFile {
  const language = detectLanguage(filePath);
  const extracted =
    language === "typescript" || language === "javascript"
      ? extractTypeScript(filePath, sourceText)
      : extractHeuristic(filePath, sourceText);
  if (isGeneratedFile(filePath)) {
    // Generated files are indexed (agents still ask about them) but flagged.
    return { ...extracted, language: extracted.language };
  }
  if (isTestFile(filePath)) {
    return { ...extracted, language: extracted.language };
  }
  return extracted;
}

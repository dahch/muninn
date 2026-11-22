/**
 * Tier B extraction: tree-sitter WASM grammars.
 *
 * Optional by design. When `web-tree-sitter` and `@vscode/tree-sitter-wasm` are
 * installed, non-TypeScript languages are parsed into a real AST; when they are
 * missing (or `MUNINN_TREESITTER=0`), the indexer falls back to the heuristic
 * scanner and the graph is still built. Nothing here is required at runtime.
 */
import path from "node:path";
import { createRequire } from "node:module";
import {
  detectLanguage,
  normalizePath,
} from "./languages.js";
import type {
  CodeSymbolKind,
  ExtractedEdge,
  ExtractedFile,
  ExtractedSymbol,
} from "./types.js";

const MAX_SYMBOLS = 8_000;
const MAX_EDGES = 8_000;
const MAX_SIGNATURE = 240;

interface DefinitionSpec {
  kind: CodeSymbolKind;
  /** Field holding the name; falls back to "name". */
  nameField?: string;
  /** Parent symbol kind (methods attach to the enclosing class). */
  nested?: boolean;
}

interface LanguageConfig {
  wasm: string;
  definitions: Record<string, DefinitionSpec>;
  imports: string[];
  calls: string[];
}

const CONFIG: Record<string, LanguageConfig> = {
  python: {
    wasm: "tree-sitter-python.wasm",
    definitions: {
      function_definition: { kind: "function" },
      class_definition: { kind: "class" },
    },
    imports: ["import_statement", "import_from_statement"],
    calls: ["call"],
  },
  go: {
    wasm: "tree-sitter-go.wasm",
    definitions: {
      function_declaration: { kind: "function" },
      method_declaration: { kind: "method", nested: true },
      type_spec: { kind: "type" },
    },
    imports: ["import_declaration"],
    calls: ["call_expression"],
  },
  rust: {
    wasm: "tree-sitter-rust.wasm",
    definitions: {
      function_item: { kind: "function" },
      struct_item: { kind: "struct" },
      enum_item: { kind: "enum" },
      trait_item: { kind: "trait" },
      mod_item: { kind: "module" },
      type_item: { kind: "type" },
      impl_item: { kind: "class", nameField: "type" },
    },
    imports: ["use_declaration"],
    calls: ["call_expression"],
  },
  java: {
    wasm: "tree-sitter-java.wasm",
    definitions: {
      class_declaration: { kind: "class" },
      interface_declaration: { kind: "interface" },
      enum_declaration: { kind: "enum" },
      method_declaration: { kind: "method", nested: true },
      constructor_declaration: { kind: "method", nested: true },
    },
    imports: ["import_declaration"],
    calls: ["method_invocation"],
  },
  csharp: {
    wasm: "tree-sitter-c-sharp.wasm",
    definitions: {
      class_declaration: { kind: "class" },
      interface_declaration: { kind: "interface" },
      struct_declaration: { kind: "struct" },
      enum_declaration: { kind: "enum" },
      method_declaration: { kind: "method", nested: true },
    },
    imports: ["using_directive"],
    calls: ["invocation_expression"],
  },
  c: {
    wasm: "tree-sitter-cpp.wasm",
    definitions: {
      function_definition: { kind: "function" },
      struct_specifier: { kind: "struct" },
      enum_specifier: { kind: "enum" },
      type_definition: { kind: "type", nameField: "declarator" },
    },
    imports: ["preproc_include"],
    calls: ["call_expression"],
  },
  cpp: {
    wasm: "tree-sitter-cpp.wasm",
    definitions: {
      function_definition: { kind: "function" },
      class_specifier: { kind: "class" },
      struct_specifier: { kind: "struct" },
      enum_specifier: { kind: "enum" },
      namespace_definition: { kind: "module" },
    },
    imports: ["preproc_include"],
    calls: ["call_expression"],
  },
  ruby: {
    wasm: "tree-sitter-ruby.wasm",
    definitions: {
      method: { kind: "method", nested: true },
      class: { kind: "class" },
      module: { kind: "module" },
      singleton_method: { kind: "method", nested: true },
    },
    imports: [],
    calls: ["call"],
  },
  php: {
    wasm: "tree-sitter-php.wasm",
    definitions: {
      function_definition: { kind: "function" },
      class_declaration: { kind: "class" },
      interface_declaration: { kind: "interface" },
      method_declaration: { kind: "method", nested: true },
    },
    imports: ["namespace_use_declaration"],
    calls: ["function_call_expression", "member_call_expression"],
  },
  bash: {
    wasm: "tree-sitter-bash.wasm",
    definitions: { function_definition: { kind: "function" } },
    imports: [],
    calls: ["command"],
  },
};

let initPromise: Promise<boolean> | null = null;
let parserClass: any = null;
const languageCache = new Map<string, Promise<any>>();
let wasmDirCache: string | null | undefined;

function resolveWasmDir(): string | null {
  if (wasmDirCache !== undefined) return wasmDirCache;
  try {
    const require = createRequire(import.meta.url);
    // The package main is `wasm/tree-sitter.js`, so its directory holds the grammars.
    wasmDirCache = path.dirname(require.resolve("@vscode/tree-sitter-wasm"));
  } catch {
    wasmDirCache = null;
  }
  return wasmDirCache;
}

export function treeSitterEnabled(): boolean {
  return process.env.MUNINN_TREESITTER !== "0" && process.env.MUNINN_TREESITTER !== "false";
}

export async function treeSitterAvailable(): Promise<boolean> {
  if (!treeSitterEnabled()) return false;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (resolveWasmDir() === null) return false;
    try {
      const mod: any = await import("web-tree-sitter");
      await mod.Parser.init();
      parserClass = mod.Parser;
      return true;
    } catch {
      return false;
    }
  })();
  return initPromise;
}

async function getLanguage(wasm: string): Promise<any | null> {
  const cached = languageCache.get(wasm);
  if (cached) return cached;
  const dir = resolveWasmDir();
  if (!dir) return null;
  const promise = (async () => {
    try {
      const mod: any = await import("web-tree-sitter");
      return await mod.Language.load(path.join(dir, wasm));
    } catch {
      return null;
    }
  })();
  languageCache.set(wasm, promise);
  return promise;
}

function firstIdentifierText(node: any): string | null {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "field_identifier" || node.type === "type_identifier") {
    return node.text;
  }
  for (const child of node.namedChildren ?? []) {
    const found = firstIdentifierText(child);
    if (found) return found;
  }
  return null;
}

function symbolName(node: any, spec: DefinitionSpec): string | null {
  const field = node.childForFieldName?.(spec.nameField ?? "name");
  if (field?.text) return field.text;
  if (spec.nameField === "declarator" || node.type === "function_definition") {
    const declarator = node.childForFieldName?.("declarator");
    const fromDeclarator = firstIdentifierText(declarator);
    if (fromDeclarator) return fromDeclarator;
  }
  if (node.type === "type_spec" || node.type === "type_definition") {
    const declared = firstIdentifierText(node);
    if (declared) return declared;
  }
  const byNameField = node.childForFieldName?.("name");
  if (byNameField?.text) return byNameField.text;
  return null;
}

function docText(node: any): string | null {
  const parts: string[] = [];
  let previous = node.previousSibling;
  while (previous && previous.type.includes("comment") && parts.length < 8) {
    parts.unshift(previous.text.replace(/^\/\*+|\*+\/|^\/\/+|^#+|^%+/g, "").trim());
    previous = previous.previousSibling;
  }
  const doc = parts.filter(Boolean).join(" ").trim();
  return doc ? doc.slice(0, 500) : null;
}

function importTarget(node: any, language: string): { target: string; targetFile: string | null } | null {
  const text = node.text.trim();
  if (language === "python") {
    const from = text.match(/^from\s+([.\w]+)\s+import/);
    if (from) {
      const raw = from[1];
      const dots = raw.match(/^\.+/)?.[0].length ?? 0;
      const modulePart = raw.replace(/^\.+/, "");
      const baseDirs = dots > 0 ? dots - 1 : 0;
      let base = "";
      for (let i = 0; i < baseDirs; i++) base = base ? base + "/.." : "..";
      const targetFile = (base ? base + "/" : "") + modulePart.replace(/\./g, "/");
      return { target: raw, targetFile };
    }
    const plain = text.match(/^import\s+([\w.]+)/);
    if (plain) return { target: plain[1], targetFile: plain[1].replace(/\./g, "/") };
    return { target: text, targetFile: null };
  }
  if (language === "c" || language === "cpp") {
    const quoted = text.match(/#include\s+"([^"]+)"/);
    if (quoted) return { target: quoted[1], targetFile: quoted[1] };
    const angled = text.match(/#include\s+<([^>]+)>/);
    return angled ? { target: angled[1], targetFile: null } : { target: text, targetFile: null };
  }
  if (language === "go") {
    const quoted = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    if (quoted.length > 0) return { target: quoted[0], targetFile: null };
    return { target: text, targetFile: null };
  }
  const match = text.match(/^(?:use|import|using)\s+([^;\s]+)/);
  return { target: match ? match[1] : text, targetFile: null };
}

function calleeName(node: any, language: string): string | null {
  const field =
    node.childForFieldName?.("function") ??
    node.childForFieldName?.("name") ??
    node.childForFieldName?.("method") ??
    node.childForFieldName?.("command");
  const text = field?.text ?? node.text;
  const cleaned = String(text).split(/[\s(]/)[0];
  const segments = cleaned.split(/\.|::|->|\\/);
  const last = segments[segments.length - 1] ?? "";
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(last) ? last : null;
}

export async function extractWithTreeSitter(
  filePath: string,
  source: string
): Promise<ExtractedFile | null> {
  if (!(await treeSitterAvailable())) return null;
  const detected = detectLanguage(filePath);
  if (!detected) return null;
  const language: string = detected;
  const config = CONFIG[language];
  if (!config) return null;
  const grammar = await getLanguage(config.wasm);
  if (!grammar || !parserClass) return null;

  let tree: any;
  try {
    const parser = new parserClass();
    parser.setLanguage(grammar);
    tree = parser.parse(source);
  } catch {
    return null;
  }
  if (!tree) return null;

  const normalizedPath = normalizePath(filePath);
  const symbols: ExtractedSymbol[] = [];
  const edges: ExtractedEdge[] = [];
  const used = new Set<string>();

  function qualify(parent: string | null, name: string, line: number): string {
    const base = normalizedPath + "::" + (parent ? parent + "." : "") + name;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = base + "@" + line + "#" + suffix;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  }

  function visit(node: any, current: string | null, currentClass: string | null): void {
    if (symbols.length >= MAX_SYMBOLS || edges.length >= MAX_EDGES) return;
    const spec = config.definitions[node.type];
    let nextCurrent = current;
    let nextClass = currentClass;
    if (spec) {
      const name = symbolName(node, spec);
      if (name) {
        // Anything defined inside a class/struct/impl is a member of it, even
        // when the grammar reuses the top-level definition node (Python, C++).
        const parentName =
          currentClass &&
          spec.kind !== "class" &&
          spec.kind !== "struct" &&
          spec.kind !== "interface" &&
          spec.kind !== "module"
            ? currentClass
            : null;
        const startLine = node.startPosition.row + 1;
        const qualified = qualify(parentName, name, startLine);
        const isDefinition = node.parent?.type === "export_statement";
        const visibility = /\b(private|protected|internal)\b/.test(node.text.slice(0, 400))
          ? "private"
          : isDefinition || /\b(pub|public|export)\b/.test(node.text.slice(0, 200))
            ? "public"
            : "internal";
        const symbol: ExtractedSymbol = {
          name,
          qualified,
          kind: spec.kind,
          startLine,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          signature: node.text.split("\n")[0].slice(0, MAX_SIGNATURE).trim(),
          doc: docText(node),
          isExported: visibility === "public",
          parentName,
          visibility,
        };
        symbols.push(symbol);
        edges.push({
          src: normalizedPath,
          kind: "contains",
          target: qualified,
          targetFile: normalizedPath,
          line: startLine,
          confidence: "exact",
        });
        nextCurrent = qualified;
        if (spec.kind === "class" || spec.kind === "struct" || spec.kind === "interface") {
          nextClass = name;
        }
      }
    }

    if (config.imports.includes(node.type)) {
      const imported = importTarget(node, language);
      if (imported) {
        edges.push({
          src: normalizedPath,
          kind: "imports",
          target: imported.target,
          targetFile: imported.targetFile,
          line: node.startPosition.row + 1,
          confidence: imported.targetFile ? "exact" : "heuristic",
        });
      }
      return;
    }

    if (config.calls.includes(node.type)) {
      const name = calleeName(node, language);
      if (name) {
        edges.push({
          src: nextCurrent ?? normalizedPath,
          kind: "calls",
          target: name,
          line: node.startPosition.row + 1,
          confidence: "heuristic",
        });
      }
    }

    for (const child of node.namedChildren ?? []) {
      visit(child, nextCurrent, nextClass);
    }
  }

  visit(tree.rootNode, null, null);
  try {
    tree.delete?.();
  } catch {
    // The parser keeps its own memory; a failed cleanup is not fatal.
  }

  return {
    path: normalizedPath,
    language,
    symbols: symbols.slice(0, MAX_SYMBOLS),
    edges: edges.slice(0, MAX_EDGES),
  };
}

/**
 * Codex TOML MCP destination inspection and installation.
 *
 * Iteration 3 adds the Codex destination without a TOML runtime dependency. The
 * parser below validates the complete document before any merge, keeps the
 * parsed tables for classification, and edits only the Muninn table when a write
 * is required. Unrelated tables, keys, comments, and formatting stay intact; a
 * forced replacement may discard comments inside the replaced Muninn region. A
 * correct entry is a byte-for-byte no-op. Writes reuse the same path screen,
 * atomic temporary file, permission handling, and symlink refusal as the JSON
 * destinations.
 */
import fs from "node:fs";
import { checkDocPath, lstatOrUndefined } from "../util/path-safety.js";
import { canonicalAgentEntry } from "./json-target.js";
import { safeWriteAtomic } from "./portable.js";
import type { AgentTarget } from "./registry.js";

export type TomlMcpState = "absent" | "registered" | "legacy" | "conflict" | "malformed";
export type TomlMcpOutcome = "written" | "present" | "skipped" | "failed";

export interface TomlTargetOptions {
  target: AgentTarget;
  path: string;
  projectPath?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface TomlTargetStatus {
  target: AgentTarget;
  path: string;
  state: TomlMcpState;
  changed: false;
  error?: string;
  errors: string[];
}

export interface TomlTargetReport extends Omit<TomlTargetStatus, "changed"> {
  outcome: TomlMcpOutcome;
  changed: boolean;
  dryRun: boolean;
}

interface TomlDesired {
  command: string;
  args: string[];
}

class TomlTable {
  readonly kind = "table";
  entries = new Map<string, TomlValue>();
  explicitHeader = false;
  createdByDottedKey = false;
}

interface TomlArray {
  kind: "array";
  items: TomlValue[];
}

type TomlValue = string | number | boolean | TomlTable | TomlArray;

interface HeaderStatement {
  kind: "header";
  path: string[];
  array: boolean;
  start: number;
  end: number;
}

interface KeyValueStatement {
  kind: "keyValue";
  tablePath: string[];
  keyPath: string[];
  fullPath: string[];
  value: TomlValue;
  start: number;
  end: number;
}

type Statement = HeaderStatement | KeyValueStatement;

interface ParsedToml {
  root: TomlTable;
  statements: Statement[];
}

interface Inspection {
  target: AgentTarget;
  path: string;
  state: TomlMcpState;
  desired: TomlDesired;
  raw?: string;
  parsed?: ParsedToml;
  error?: string;
  errors: string[];
}

class TomlParseError extends Error {}

function isTomlTable(value: TomlValue | undefined): value is TomlTable {
  return value instanceof TomlTable;
}

function isTomlArray(value: TomlValue | undefined): value is TomlArray {
  return typeof value === "object" && value !== null && value.kind === "array";
}

function isStringArray(value: TomlValue | undefined): value is TomlArray {
  return isTomlArray(value) && value.items.every((item) => typeof item === "string");
}

function pathEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

function pathStartsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return (
    path.length >= prefix.length &&
    prefix.every((part, index) => path[index] === part)
  );
}

type ScanMode = "none" | "basic" | "literal" | "multi-basic" | "multi-literal";

interface ScanState {
  mode: ScanMode;
  arrayDepth: number;
  inlineDepth: number;
}

function neutralState(): ScanState {
  return { mode: "none", arrayDepth: 0, inlineDepth: 0 };
}

function isNeutral(state: ScanState): boolean {
  return state.mode === "none" && state.arrayDepth === 0 && state.inlineDepth === 0;
}

/**
 * Scan one physical line for TOML string / bracket state and return the part
 * before an unquoted comment marker. The line does not include its newline.
 */
function scanLine(line: string, state: ScanState): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;

    if (state.mode === "basic") {
      if (ch === "\\") {
        out += ch;
        if (i + 1 < line.length) {
          out += line[i + 1]!;
          i += 2;
        } else {
          i++;
        }
        continue;
      }
      out += ch;
      if (ch === '"') state.mode = "none";
      i++;
      continue;
    }

    if (state.mode === "literal") {
      out += ch;
      if (ch === "'") state.mode = "none";
      i++;
      continue;
    }

    if (state.mode === "multi-basic") {
      if (line.startsWith('"""', i)) {
        out += '"""';
        state.mode = "none";
        i += 3;
        continue;
      }
      out += ch;
      if (ch === "\\" && i + 1 < line.length) {
        out += line[i + 1]!;
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (state.mode === "multi-literal") {
      if (line.startsWith("'''", i)) {
        out += "'''";
        state.mode = "none";
        i += 3;
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    if (ch === "#") break;
    if (ch === '"') {
      if (line.startsWith('"""', i)) {
        out += '"""';
        state.mode = "multi-basic";
        i += 3;
      } else {
        out += ch;
        state.mode = "basic";
        i++;
      }
      continue;
    }
    if (ch === "'") {
      if (line.startsWith("'''", i)) {
        out += "'''";
        state.mode = "multi-literal";
        i += 3;
      } else {
        out += ch;
        state.mode = "literal";
        i++;
      }
      continue;
    }
    if (ch === "[") state.arrayDepth++;
    else if (ch === "]") state.arrayDepth--;
    else if (ch === "{") state.inlineDepth++;
    else if (ch === "}") state.inlineDepth--;
    out += ch;
    i++;
  }
  return out;
}

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && /[ \t\r\n]/.test(text[i]!)) i++;
  return i;
}

function decodeEscape(text: string, index: number): { value: string; next: number } {
  const marker = text[index];
  const next = text[index + 1];
  if (marker !== "\\") throw new TomlParseError("internal escape parser error");
  if (next === undefined) throw new TomlParseError("unterminated escape sequence");
  switch (next) {
    case "b":
      return { value: "\b", next: index + 2 };
    case "t":
      return { value: "\t", next: index + 2 };
    case "n":
      return { value: "\n", next: index + 2 };
    case "f":
      return { value: "\f", next: index + 2 };
    case "r":
      return { value: "\r", next: index + 2 };
    case '"':
      return { value: '"', next: index + 2 };
    case "\\":
      return { value: "\\", next: index + 2 };
    case "u":
    case "U": {
      const length = next === "u" ? 4 : 8;
      const hex = text.slice(index + 2, index + 2 + length);
      if (hex.length !== length || !/^[0-9A-Fa-f]+$/.test(hex)) {
        throw new TomlParseError(`invalid \\${next} escape`);
      }
      return { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: index + 2 + length };
    }
    default:
      throw new TomlParseError(`invalid escape sequence \\${next}`);
  }
}

function parseBasicStringAt(text: string, index: number): { value: string; next: number } {
  const multiline = text.startsWith('"""', index);
  let i = index + (multiline ? 3 : 1);
  let value = "";
  if (multiline && (text[i] === "\n" || text[i] === "\r")) {
    if (text[i] === "\r" && text[i + 1] === "\n") i += 2;
    else i++;
  }
  while (i < text.length) {
    if (multiline && text.startsWith('"""', i)) {
      return { value, next: i + 3 };
    }
    const ch = text[i]!;
    if (!multiline && ch === '"') return { value, next: i + 1 };
    if (!multiline && (ch === "\n" || ch === "\r")) {
      throw new TomlParseError("newline in a single-line string");
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (multiline && (next === "\n" || next === "\r" || next === " " || next === "\t")) {
        i += 1;
        while (i < text.length && /[ \t\r\n]/.test(text[i]!)) i++;
        continue;
      }
      const decoded = decodeEscape(text, i);
      value += decoded.value;
      i = decoded.next;
      continue;
    }
    value += ch;
    i++;
  }
  throw new TomlParseError("unterminated string");
}

function parseLiteralStringAt(text: string, index: number): { value: string; next: number } {
  const multiline = text.startsWith("'''", index);
  let i = index + (multiline ? 3 : 1);
  let value = "";
  if (multiline && (text[i] === "\n" || text[i] === "\r")) {
    if (text[i] === "\r" && text[i + 1] === "\n") i += 2;
    else i++;
  }
  while (i < text.length) {
    if (multiline && text.startsWith("'''", i)) {
      return { value, next: i + 3 };
    }
    const ch = text[i]!;
    if (!multiline && ch === "'") return { value, next: i + 1 };
    if (!multiline && (ch === "\n" || ch === "\r")) {
      throw new TomlParseError("newline in a single-line string");
    }
    value += ch;
    i++;
  }
  throw new TomlParseError("unterminated string");
}

function parseKeyPathAt(
  text: string,
  start: number,
): { path: string[]; next: number } {
  const path: string[] = [];
  let i = start;
  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) break;
    const ch = text[i]!;
    let part: string;
    if (ch === '"') {
      const parsed = parseBasicStringAt(text, i);
      part = parsed.value;
      i = parsed.next;
    } else if (ch === "'") {
      const parsed = parseLiteralStringAt(text, i);
      part = parsed.value;
      i = parsed.next;
    } else {
      const keyStart = i;
      while (i < text.length && /[A-Za-z0-9_-]/.test(text[i]!)) i++;
      if (i === keyStart) throw new TomlParseError("invalid key");
      part = text.slice(keyStart, i);
    }
    path.push(part);
    i = skipWhitespace(text, i);
    if (i >= text.length) break;
    if (text[i] !== ".") break;
    i++;
  }
  if (path.length === 0) throw new TomlParseError("empty key");
  return { path, next: i };
}

const INTEGER_PATTERN = /^[+-]?(?:0|[1-9](?:_?\d)*)$/;
const HEX_PATTERN = /^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/;
const OCTAL_PATTERN = /^0o[0-7](?:_?[0-7])*$/;
const BINARY_PATTERN = /^0b[01](?:_?[01])*$/;
const FLOAT_PATTERN =
  /^[+-]?(?:(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|\.\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?$/;

function parseBareValue(token: string): TomlValue {
  const value = token.trim();
  if (value.length === 0) throw new TomlParseError("missing value");
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?(?:inf|nan)$/i.test(value)) return Number(value.replaceAll("_", ""));
  if (INTEGER_PATTERN.test(value)) return Number(value.replaceAll("_", ""));
  if (HEX_PATTERN.test(value)) return Number.parseInt(value.slice(2).replaceAll("_", ""), 16);
  if (OCTAL_PATTERN.test(value)) return Number.parseInt(value.slice(2).replaceAll("_", ""), 8);
  if (BINARY_PATTERN.test(value)) return Number.parseInt(value.slice(2).replaceAll("_", ""), 2);
  if (FLOAT_PATTERN.test(value)) return Number(value.replaceAll("_", ""));
  if (DATE_PATTERN.test(value) || TIME_PATTERN.test(value) || DATETIME_PATTERN.test(value)) {
    return value;
  }
  throw new TomlParseError(`invalid value \`${value}\``);
}

function parseValueAt(text: string, start: number): { value: TomlValue; next: number } {
  let i = skipWhitespace(text, start);
  if (i >= text.length) throw new TomlParseError("missing value");
  const ch = text[i]!;
  if (ch === '"') {
    const parsed = parseBasicStringAt(text, i);
    return { value: parsed.value, next: parsed.next };
  }
  if (ch === "'") {
    const parsed = parseLiteralStringAt(text, i);
    return { value: parsed.value, next: parsed.next };
  }
  if (ch === "[") return parseArrayAt(text, i);
  if (ch === "{") return parseInlineTableAt(text, i);

  const valueStart = i;
  while (i < text.length && !/[,\]}\r\n]/.test(text[i]!)) i++;
  return { value: parseBareValue(text.slice(valueStart, i)), next: i };
}

function parseArrayAt(text: string, start: number): { value: TomlArray; next: number } {
  let i = start + 1;
  const items: TomlValue[] = [];
  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) throw new TomlParseError("unterminated array");
    if (text[i] === "]") return { value: { kind: "array", items }, next: i + 1 };
    const parsed = parseValueAt(text, i);
    items.push(parsed.value);
    i = skipWhitespace(text, parsed.next);
    if (i >= text.length) throw new TomlParseError("unterminated array");
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] === "]") return { value: { kind: "array", items }, next: i + 1 };
    throw new TomlParseError("expected `,` or `]` in array");
  }
}

function assignValue(table: TomlTable, path: string[], value: TomlValue): void {
  let current = table;
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index]!;
    const existing = current.entries.get(key);
    if (existing === undefined) {
      const next = new TomlTable();
      next.createdByDottedKey = true;
      current.entries.set(key, next);
      current = next;
    } else if (isTomlTable(existing)) {
      current = existing;
    } else if (isTomlArray(existing)) {
      const last = existing.items[existing.items.length - 1];
      if (!isTomlTable(last)) throw new TomlParseError(`\`${key}\` is not a table`);
      current = last;
    } else {
      throw new TomlParseError(`key \`${key}\` is already defined as a value`);
    }
  }
  const finalKey = path[path.length - 1]!;
  if (current.entries.has(finalKey)) {
    throw new TomlParseError(`duplicate key \`${path.join(".")}\``);
  }
  current.entries.set(finalKey, value);
}

function parseInlineTableAt(
  text: string,
  start: number,
): { value: TomlTable; next: number } {
  const table = new TomlTable();
  let i = start + 1;
  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) throw new TomlParseError("unterminated inline table");
    if (text[i] === "}") return { value: table, next: i + 1 };
    const key = parseKeyPathAt(text, i);
    i = skipWhitespace(text, key.next);
    if (text[i] !== "=") throw new TomlParseError("expected `=` in inline table");
    i = skipWhitespace(text, i + 1);
    const value = parseValueAt(text, i);
    assignValue(table, key.path, value.value);
    i = skipWhitespace(text, value.next);
    if (i >= text.length) throw new TomlParseError("unterminated inline table");
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] === "}") return { value: table, next: i + 1 };
    throw new TomlParseError("expected `,` or `}` in inline table");
  }
}

function parseHeaderContent(text: string): { path: string[]; array: boolean } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) throw new TomlParseError("invalid table header");
  const array = trimmed.startsWith("[[");
  const closing = array ? "]]" : "]";
  if (!trimmed.endsWith(closing)) throw new TomlParseError("unterminated table header");
  const inner = trimmed.slice(array ? 2 : 1, trimmed.length - closing.length);
  const parsed = parseKeyPathAt(inner, 0);
  if (skipWhitespace(inner, parsed.next) !== inner.length) {
    throw new TomlParseError("unexpected content after table header");
  }
  if (parsed.path.length === 0) throw new TomlParseError("empty table header");
  return { path: parsed.path, array };
}

function parseKeyValueContent(
  text: string,
): { keyPath: string[]; value: TomlValue } {
  const key = parseKeyPathAt(text, 0);
  let i = skipWhitespace(text, key.next);
  if (text[i] !== "=") throw new TomlParseError("expected `=` after key");
  i = skipWhitespace(text, i + 1);
  const value = parseValueAt(text, i);
  if (skipWhitespace(text, value.next) !== text.length) {
    throw new TomlParseError("unexpected content after value");
  }
  return { keyPath: key.path, value: value.value };
}

function descendHeader(root: TomlTable, path: string[], array: boolean): TomlTable {
  let current = root;
  for (let index = 0; index < path.length; index++) {
    const key = path[index]!;
    const last = index === path.length - 1;
    const existing = current.entries.get(key);

    if (last && array) {
      let values: TomlArray;
      if (existing === undefined) {
        values = { kind: "array", items: [] };
        current.entries.set(key, values);
      } else if (isTomlArray(existing)) {
        values = existing;
      } else {
        throw new TomlParseError(`table \`${path.join(".")}\` conflicts with an existing value`);
      }
      const table = new TomlTable();
      table.explicitHeader = true;
      values.items.push(table);
      return table;
    }

    let next: TomlTable;
    if (existing === undefined) {
      next = new TomlTable();
      current.entries.set(key, next);
    } else if (isTomlTable(existing)) {
      next = existing;
    } else if (isTomlArray(existing)) {
      const lastItem = existing.items[existing.items.length - 1];
      if (!isTomlTable(lastItem)) {
        throw new TomlParseError(`table \`${path.join(".")}\` conflicts with an existing value`);
      }
      next = lastItem;
    } else {
      throw new TomlParseError(`table \`${path.join(".")}\` conflicts with an existing value`);
    }
    if (last) {
      if (next.explicitHeader) {
        throw new TomlParseError(`duplicate table header \`${path.join(".")}\``);
      }
      if (next.createdByDottedKey) {
        throw new TomlParseError(
          `table \`${path.join(".")}\` is already defined by dotted keys`,
        );
      }
      next.explicitHeader = true;
    }
    current = next;
  }
  return current;
}

/** Validate a complete TOML document and retain the structural statement map. */
export function parseToml(raw: string): ParsedToml {
  const root = new TomlTable();
  const statements: Statement[] = [];
  let currentTable = root;
  let currentTablePath: string[] = [];
  let pending:
    | { start: number; content: string; state: ScanState }
    | undefined;

  let position = 0;
  while (position < raw.length) {
    const newline = raw.indexOf("\n", position);
    const lineEnd = newline === -1 ? raw.length : newline;
    const line = raw.slice(position, lineEnd);
    const nextPosition = newline === -1 ? raw.length : newline + 1;

    if (pending === undefined) {
      const trimmed = line.trimStart();
      if (trimmed.length > 0 && !trimmed.startsWith("#")) {
        if (trimmed.startsWith("[")) {
          const content = scanLine(line, neutralState());
          const header = parseHeaderContent(content);
          currentTable = descendHeader(root, header.path, header.array);
          currentTablePath = header.path;
          statements.push({
            kind: "header",
            path: header.path,
            array: header.array,
            start: position,
            end: nextPosition,
          });
        } else {
          const state = neutralState();
          const content = scanLine(line, state);
          pending = { start: position, content, state };
          if (!isNeutral(state)) {
            position = nextPosition;
            continue;
          }
          const parsed = parseKeyValueContent(pending.content);
          assignValue(currentTable, parsed.keyPath, parsed.value);
          statements.push({
            kind: "keyValue",
            tablePath: currentTablePath,
            keyPath: parsed.keyPath,
            fullPath: [...currentTablePath, ...parsed.keyPath],
            value: parsed.value,
            start: pending.start,
            end: nextPosition,
          });
          pending = undefined;
        }
      }
    } else {
      const content = scanLine(line, pending.state);
      pending.content += `\n${content}`;
      if (isNeutral(pending.state)) {
        const parsed = parseKeyValueContent(pending.content);
        assignValue(currentTable, parsed.keyPath, parsed.value);
        statements.push({
          kind: "keyValue",
          tablePath: currentTablePath,
          keyPath: parsed.keyPath,
          fullPath: [...currentTablePath, ...parsed.keyPath],
          value: parsed.value,
          start: pending.start,
          end: nextPosition,
        });
        pending = undefined;
      }
    }
    position = nextPosition;
  }

  if (pending !== undefined) throw new TomlParseError("unterminated value");
  return { root, statements };
}

function desiredEntry(options: TomlTargetOptions): TomlDesired {
  const entry = canonicalAgentEntry(options.target, options.path, options.projectPath);
  const command = entry.command;
  const args = entry.args;
  if (typeof command !== "string" || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error(`cannot build a TOML entry for ${options.target.id}`);
  }
  return { command, args };
}

function sameStringArray(value: TomlValue | undefined, expected: string[]): boolean {
  if (!isStringArray(value)) return false;
  return (
    value.items.length === expected.length &&
    value.items.every((item, index) => item === expected[index])
  );
}

function classify(
  root: TomlTable,
  desired: TomlDesired,
): { state: TomlMcpState; error?: string } {
  const servers = root.entries.get("mcp_servers");
  if (servers === undefined) return { state: "absent" };
  if (!isTomlTable(servers)) {
    return { state: "malformed", error: "`mcp_servers` must be a table" };
  }
  const entry = servers.entries.get("muninn");
  if (entry === undefined) return { state: "absent" };
  if (!isTomlTable(entry)) {
    return { state: "malformed", error: "`mcp_servers.muninn` must be a table" };
  }

  const command = entry.entries.get("command");
  const args = entry.entries.get("args");
  if (command !== undefined && typeof command !== "string") {
    return { state: "malformed", error: "`mcp_servers.muninn.command` must be a string" };
  }
  if (args !== undefined && !isStringArray(args)) {
    return {
      state: "malformed",
      error: "`mcp_servers.muninn.args` must be an array of strings",
    };
  }
  const canonical =
    entry.entries.size === 2 &&
    entry.entries.has("command") &&
    entry.entries.has("args") &&
    command === desired.command &&
    sameStringArray(args, desired.args);
  if (canonical) return { state: "registered" };
  if (command === "huginn") return { state: "legacy" };
  return { state: "conflict" };
}

function inspect(options: TomlTargetOptions): Inspection {
  const desired = desiredEntry(options);
  const label = `${options.target.id} MCP configuration`;
  const errors: string[] = [];
  const check = checkDocPath(options.path, {
    label,
    action: "read or write",
    projectPath: options.projectPath,
  });
  if (!check.ok) {
    return {
      target: options.target,
      path: options.path,
      state: "malformed",
      desired,
      error: check.reason,
      errors: [check.reason],
    };
  }

  const stat = lstatOrUndefined(check.path);
  if (stat === undefined) {
    return {
      target: options.target,
      path: check.path,
      state: "absent",
      desired,
      errors,
    };
  }
  if (!stat.isFile()) {
    const error = `${label} ${check.path} is not a regular file`;
    return {
      target: options.target,
      path: check.path,
      state: "malformed",
      desired,
      error,
      errors: [...errors, error],
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(check.path, "utf8");
  } catch (err) {
    const error = `Cannot read ${label} ${check.path}: ${(err as Error).message}`;
    return {
      target: options.target,
      path: check.path,
      state: "malformed",
      desired,
      error,
      errors: [...errors, error],
    };
  }

  let parsed: ParsedToml;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = `Malformed TOML in ${check.path}: ${message}`;
    return {
      target: options.target,
      path: check.path,
      state: "malformed",
      desired,
      raw,
      error,
      errors: [...errors, error],
    };
  }

  const classified = classify(parsed.root, desired);
  if (classified.state === "malformed") {
    const error = `Malformed ${label} ${check.path}: ${classified.error}`;
    return {
      target: options.target,
      path: check.path,
      state: "malformed",
      desired,
      raw,
      parsed,
      error,
      errors: [...errors, error],
    };
  }

  return {
    target: options.target,
    path: check.path,
    state: classified.state,
    desired,
    raw,
    parsed,
    errors,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderMuninnTable(desired: TomlDesired): string {
  return (
    `[mcp_servers.muninn]\n` +
    `command = ${tomlString(desired.command)}\n` +
    `args = [${desired.args.map(tomlString).join(", ")}]\n`
  );
}

function appendTable(raw: string, block: string): string {
  if (raw.length === 0) return block;
  let prefix = raw;
  if (!prefix.endsWith("\n")) prefix += "\n";
  if (!prefix.endsWith("\n\n")) prefix += "\n";
  return prefix + block;
}

function mergeToml(raw: string | undefined, parsed: ParsedToml, desired: TomlDesired): string {
  const block = renderMuninnTable(desired);
  if (raw === undefined) return block;

  const statements = parsed.statements;
  const explicitHeader = statements.find(
    (statement): statement is HeaderStatement =>
      statement.kind === "header" &&
      !statement.array &&
      pathEquals(statement.path, ["mcp_servers", "muninn"]),
  );
  if (explicitHeader !== undefined) {
    const headerIndex = statements.indexOf(explicitHeader);
    const earlierMuninn = statements.slice(0, headerIndex).find(
      (statement) =>
        statement.kind === "keyValue" &&
        pathStartsWith(statement.fullPath, ["mcp_servers", "muninn"]),
    );
    if (earlierMuninn !== undefined) {
      throw new TomlParseError(
        "cannot replace `mcp_servers.muninn` because it is also defined by earlier dotted keys",
      );
    }
    const nextHeader = statements
      .slice(headerIndex + 1)
      .find((statement): statement is HeaderStatement => statement.kind === "header");
    const end = nextHeader?.start ?? raw.length;
    const before = raw.slice(0, explicitHeader.start);
    const after = raw.slice(end);
    return before + block + (after.length > 0 ? "\n" + after : "");
  }

  const servers = parsed.root.entries.get("mcp_servers");
  if (isTomlArray(servers)) {
    throw new TomlParseError("cannot extend an array-of-tables `mcp_servers` entry");
  }
  if (isTomlTable(servers) && !servers.explicitHeader) {
    const inline = statements.find(
      (statement) =>
        statement.kind === "keyValue" &&
        pathEquals(statement.fullPath, ["mcp_servers"]),
    );
    if (inline !== undefined) {
      throw new TomlParseError("cannot extend an inline `mcp_servers` table");
    }
  }

  const arrayHeader = statements.find(
    (statement): statement is HeaderStatement =>
      statement.kind === "header" &&
      statement.array &&
      pathStartsWith(statement.path, ["mcp_servers", "muninn"]),
  );
  if (arrayHeader !== undefined) {
    throw new TomlParseError("cannot replace an array-of-tables `mcp_servers.muninn` entry");
  }

  const removals = statements.filter(
    (statement) =>
      statement.kind === "keyValue" &&
      pathStartsWith(statement.fullPath, ["mcp_servers", "muninn"]),
  );
  let base = raw;
  for (const statement of [...removals].sort((a, b) => b.start - a.start)) {
    base = base.slice(0, statement.start) + base.slice(statement.end);
  }
  return appendTable(base, block);
}

/** Read-only diagnostic used by `muninn setup --status`. */
export function getTomlTargetStatus(options: TomlTargetOptions): TomlTargetStatus {
  const inspected = inspect(options);
  return {
    target: options.target,
    path: inspected.path,
    state: inspected.state,
    changed: false,
    error: inspected.error,
    errors: inspected.errors,
  };
}

export function setupTomlTarget(options: TomlTargetOptions): TomlTargetReport {
  const inspected = inspect(options);
  const dryRun = options.dryRun === true;
  const base = {
    target: inspected.target,
    path: inspected.path,
    state: inspected.state,
    dryRun,
    errors: inspected.errors,
  };

  if (inspected.state === "malformed") {
    return { ...base, outcome: "failed", changed: false, error: inspected.error };
  }
  if (inspected.state === "registered") {
    return { ...base, outcome: "present", changed: false };
  }
  if ((inspected.state === "conflict" || inspected.state === "legacy") && options.force !== true) {
    return { ...base, outcome: "skipped", changed: false };
  }

  let content: string;
  try {
    content = mergeToml(inspected.raw, inspected.parsed as ParsedToml, inspected.desired);
  } catch (err) {
    const error = `Cannot merge ${inspected.target.id} MCP configuration ${inspected.path}: ${
      (err as Error).message
    }`;
    return { ...base, outcome: "failed", changed: false, error };
  }

  if (dryRun) {
    return { ...base, outcome: "written", changed: true };
  }

  const check = checkDocPath(inspected.path, {
    label: `${inspected.target.id} MCP configuration`,
    action: "write",
    projectPath: options.projectPath,
  });
  if (!check.ok) {
    return { ...base, outcome: "failed", changed: false, error: check.reason };
  }
  const existing = lstatOrUndefined(check.path);
  if (existing?.isSymbolicLink()) {
    const error = `${inspected.target.id} MCP configuration ${check.path} is a symlink; refusing to write through it`;
    return { ...base, outcome: "failed", changed: false, error };
  }
  if (existing !== undefined && !existing.isFile()) {
    const error = `${inspected.target.id} MCP configuration ${check.path} is not a regular file`;
    return { ...base, outcome: "failed", changed: false, error };
  }

  const mode = existing === undefined ? 0o600 : existing.mode & 0o777;
  try {
    safeWriteAtomic(check.path, content, mode);
  } catch (err) {
    const error = `Cannot write ${inspected.target.id} MCP configuration ${check.path}: ${
      (err as Error).message
    }`;
    return { ...base, outcome: "failed", changed: false, error };
  }

  return { ...base, outcome: "written", changed: true };
}

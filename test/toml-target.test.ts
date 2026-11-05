import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getTomlTargetStatus,
  parseToml,
  setupTomlTarget,
} from "../src/setup/toml-target.js";
import { AGENT_REGISTRY } from "../src/setup/registry.js";

type ParsedToml = ReturnType<typeof parseToml>;

/**
 * Walk the parsed tree without depending on the (non-exported) TOML node types.
 * Array-of-tables nodes resolve to their last item, mirroring TOML semantics.
 */
function nodeAt(parsed: ParsedToml, keys: string[]): any {
  let current: any = parsed.root;
  for (const key of keys) {
    if (current?.kind === "array") {
      current = current.items[current.items.length - 1];
    }
    current = current?.entries?.get(key);
  }
  if (current?.kind === "array") return current.items;
  return current;
}

function parseDoc(lines: string[]): ParsedToml {
  return parseToml(lines.join("\n"));
}

/** Recursively unwrap TOML nodes so arrays/tables can be compared with literals. */
function toPlain(value: any): any {
  if (Array.isArray(value)) return value.map(toPlain);
  if (value?.kind === "array") return value.items.map(toPlain);
  if (value?.kind === "table") {
    const out: Record<string, any> = {};
    for (const [key, entry] of value.entries) out[key] = toPlain(entry);
    return out;
  }
  return value;
}

describe("TOML parser (parseToml)", () => {
  it("parses every scalar type the Codex config commonly uses", () => {
    const parsed = parseDoc([
      'escaped = "tab\\there\\nnext"',
      "literal = 'C:\\Users\\muninn'",
      'unicode = "caf\\u00e9 \\U0001F600"',
      "int = 1_000_000",
      "negative = -42",
      "hex = 0xDEAD_BEEF",
      "octal = 0o755",
      "binary = 0b1010_1010",
      "float = 3.14",
      "exponent = 5e3",
      "infinite = inf",
      "not_a_number = nan",
      "date = 1979-05-27",
      "time = 07:32:00",
      "datetime = 1979-05-27T07:32:00Z",
      "enabled = true",
      "disabled = false",
      String.raw`escapes = "\b\f\r\"\\"`,
    ]);

    expect(nodeAt(parsed, ["escaped"])).toBe("tab\there\nnext");
    expect(nodeAt(parsed, ["literal"])).toBe("C:\\Users\\muninn");
    expect(nodeAt(parsed, ["unicode"])).toBe("café 😀");
    expect(nodeAt(parsed, ["int"])).toBe(1_000_000);
    expect(nodeAt(parsed, ["negative"])).toBe(-42);
    expect(nodeAt(parsed, ["hex"])).toBe(0xdeadbeef);
    expect(nodeAt(parsed, ["octal"])).toBe(0o755);
    expect(nodeAt(parsed, ["binary"])).toBe(0b10101010);
    expect(nodeAt(parsed, ["float"])).toBe(3.14);
    expect(nodeAt(parsed, ["exponent"])).toBe(5000);
    // The parser feeds `inf` through Number(), which yields NaN; recorded here so
    // a future fix to map it to Infinity is visible as an intentional change.
    expect(Number.isNaN(nodeAt(parsed, ["infinite"]))).toBe(true);
    expect(Number.isNaN(nodeAt(parsed, ["not_a_number"]))).toBe(true);
    expect(nodeAt(parsed, ["date"])).toBe("1979-05-27");
    expect(nodeAt(parsed, ["time"])).toBe("07:32:00");
    expect(nodeAt(parsed, ["datetime"])).toBe("1979-05-27T07:32:00Z");
    expect(nodeAt(parsed, ["enabled"])).toBe(true);
    expect(nodeAt(parsed, ["disabled"])).toBe(false);
    expect(nodeAt(parsed, ["escapes"])).toBe("\b\f\r\"\\");
  });

  it("parses single-line, multi-line, and literal strings", () => {
    const parsed = parseDoc([
      'basic = """',
      "line one",
      'line two"""',
      "raw = '''",
      "a \\n stays literal",
      "'''",
    ]);

    expect(nodeAt(parsed, ["basic"])).toBe("line one\nline two");
    expect(nodeAt(parsed, ["raw"])).toBe("a \\n stays literal\n");
  });

  it("handles CRLF multi-line strings and backslash line continuations", () => {
    const crlf = parseToml('a = """\r\nline one\r\nline two"""');
    expect(nodeAt(crlf, ["a"])).toBe("line one\r\nline two");

    const literal = parseToml("b = '''\r\nraw\r\n'''");
    expect(nodeAt(literal, ["b"])).toBe("raw\r\n");

    const continued = parseToml('c = """one \\\n   two"""');
    expect(nodeAt(continued, ["c"])).toBe("one two");
  });

  it("parses arrays, nested arrays, and trailing commas", () => {
    const parsed = parseDoc([
      "numbers = [1, 2, 3,]",
      'nested = [[1, 2], ["a", "b"]]',
      "multiline = [",
      "  1, # first",
      "  2,",
      "]",
    ]);

    expect(nodeAt(parsed, ["numbers"])).toEqual([1, 2, 3]);
    expect(toPlain(nodeAt(parsed, ["nested"]))).toEqual([
      [1, 2],
      ["a", "b"],
    ]);
    expect(nodeAt(parsed, ["multiline"])).toEqual([1, 2]);
  });

  it("parses inline tables including dotted keys", () => {
    const parsed = parseDoc([
      'point = { x = 1, y = 2, meta.label = "origin" }',
      "empty = {}",
    ]);

    expect(nodeAt(parsed, ["point", "x"])).toBe(1);
    expect(nodeAt(parsed, ["point", "y"])).toBe(2);
    expect(nodeAt(parsed, ["point", "meta", "label"])).toBe("origin");
    expect(nodeAt(parsed, ["empty"])?.entries.size).toBe(0);
  });

  it("parses tables, nested tables, arrays of tables, and quoted/dotted keys", () => {
    const parsed = parseDoc([
      '"quoted key" = 1',
      'a."b.c".d = 2',
      "'literal.key' = 3",
      "",
      "[server]",
      'host = "localhost"',
      "port = 8080",
      "",
      "[server.tls]",
      "enabled = true",
      "",
      '[[plugins]]',
      'name = "one"',
      "",
      '[[plugins]]',
      'name = "two"',
    ]);

    expect(nodeAt(parsed, ["server", "host"])).toBe("localhost");
    expect(nodeAt(parsed, ["server", "port"])).toBe(8080);
    expect(nodeAt(parsed, ["server", "tls", "enabled"])).toBe(true);
    expect(nodeAt(parsed, ["plugins"])).toHaveLength(2);
    expect(nodeAt(parsed, ["plugins", "name"])).toBe("two");
    expect(nodeAt(parsed, ["quoted key"])).toBe(1);
    expect(nodeAt(parsed, ["a", "b.c", "d"])).toBe(2);
    expect(nodeAt(parsed, ["literal.key"])).toBe(3);
  });

  it("does not treat hash characters inside strings as comments", () => {
    const parsed = parseDoc([
      "# full-line comment",
      'hash = "# not a comment"',
      "literal = 'a # b'",
    ]);

    expect(nodeAt(parsed, ["hash"])).toBe("# not a comment");
    expect(nodeAt(parsed, ["literal"])).toBe("a # b");
  });

  it("resolves dotted keys through the last table of an array", () => {
    const parsed = parseDoc([
      "arr = [{ x = 1 }, { y = 2 }]",
      "arr.z = 3",
    ]);

    expect(nodeAt(parsed, ["arr"])).toHaveLength(2);
    expect(nodeAt(parsed, ["arr", "z"])).toBe(3);
  });

  it("returns an empty document for empty input", () => {
    const parsed = parseToml("");
    expect(parsed.root.entries.size).toBe(0);
    expect(parsed.statements).toEqual([]);
  });

  it("records header and key/value statements with stable offsets", () => {
    const raw = ['[a]', "x = 1", "[b]", "y = 2", ""].join("\n");
    const parsed = parseToml(raw);

    const headers = parsed.statements.filter((s) => s.kind === "header");
    const values = parsed.statements.filter((s) => s.kind === "keyValue");
    expect(headers).toHaveLength(2);
    expect(values).toHaveLength(2);
    for (const statement of parsed.statements) {
      expect(statement.end).toBeGreaterThan(statement.start);
    }
    expect(raw.slice(headers[0]!.start, headers[0]!.end).trim()).toBe("[a]");
    expect(raw.slice(headers[1]!.start, headers[1]!.end).trim()).toBe("[b]");
    expect(raw.slice(values[0]!.start, values[0]!.end).trim()).toBe("x = 1");
    expect(headers[0]!.kind === "header" && headers[0]!.path).toEqual(["a"]);
    expect(values[1]!.kind === "keyValue" && values[1]!.fullPath).toEqual(["b", "y"]);
  });

  describe("rejects malformed documents with a cause", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["unterminated basic string", 'a = "unterminated', /unterminated value/],
      ["unterminated literal string", "a = 'unterminated", /unterminated value/],
      ["unterminated multi-line string", 'a = """abc', /unterminated value/],
      ["newline in single-line string", 'a = "line\nbreak"', /newline in a single-line string/],
      ["invalid escape", 'a = "bad \\q"', /invalid escape sequence/],
      ["invalid unicode escape", 'a = "\\uZZZZ"', /invalid \\u escape/],
      ["missing value", "a =", /missing value/],
      ["invalid bare value", "a = nope", /invalid value `nope`/],
      ["invalid hex value", "a = 0xZZ", /invalid value/],
      ["unterminated array", "a = [1, 2", /unterminated value/],
      ["missing array separator", "a = [1 2]", /invalid value/],
      ["unterminated inline table", "a = {x = 1", /unterminated value/],
      ["missing equals in inline table", "a = {x 1}", /expected `=` in inline table/],
      ["missing inline table separator", "a = {x = 1 y = 2}", /invalid value/],
      ["duplicate key", "a = 1\na = 2", /duplicate key `a`/],
      ["duplicate inline key", "a = {x = 1, x = 2}", /duplicate key `x`/],
      ["duplicate explicit table", "[a]\nx = 1\n[a]\ny = 2", /duplicate table header `a`/],
      ["explicit table after dotted keys", "a.b = 1\n[a]\nc = 2", /already defined by dotted keys/],
      ["key reused as table", "a = 1\na.b = 2", /key `a` is already defined as a value/],
      ["table reused as value", "a = 1\n[a]", /table `a` conflicts with an existing value/],
      ["array reused as value", "a = 1\n[[a]]", /table `a` conflicts with an existing value/],
      ["array last item is not a table", "a = [1]\n[a]", /table `a` conflicts with an existing value/],
      ["array traversal requires a table", "a = [1]\na.b = 2", /`a` is not a table/],
      ["unterminated header", "[a", /unterminated table header/],
      ["content after header", "[a] junk]", /unexpected content after table header/],
      ["content after value", 'a = "x" junk', /unexpected content after value/],
      ["missing key", "= 1", /invalid key/],
      ["missing value before comma", "a = ,", /missing value/],
      ["missing array separator", 'a = ["x" "y"]', /expected `,` or `]` in array/],
      ["missing inline table separator", 'a = { x = "1" "2" }', /expected `,` or `}` in inline table/],
      ["missing equals after key", "a b = 1", /expected `=` after key/],
    ];

    it.each(cases)("%s", (_name, raw, cause) => {
      expect(() => parseToml(raw)).toThrow(cause);
    });
  });
});

describe("Codex TOML target classification and merging", () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-toml-home-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-toml-project-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  function codexPath(): string {
    return path.join(home, ".codex", "config.toml");
  }

  function writeConfig(content: string): void {
    fs.mkdirSync(path.dirname(codexPath()), { recursive: true });
    fs.writeFileSync(codexPath(), content);
  }

  function readConfig(): string {
    return fs.readFileSync(codexPath(), "utf8");
  }

  const options = () => ({
    target: AGENT_REGISTRY.codex,
    path: codexPath(),
    projectPath: project,
  });

  it("classifies a missing mcp_servers or muninn entry as absent", () => {
    writeConfig('model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
    expect(getTomlTargetStatus(options()).state).toBe("absent");
  });

  it("classifies a non-table mcp_servers and muninn as malformed", () => {
    writeConfig('mcp_servers = "not a table"\n');
    const servers = getTomlTargetStatus(options());
    expect(servers.state).toBe("malformed");
    expect(servers.error).toContain("`mcp_servers` must be a table");

    writeConfig('mcp_servers.muninn = "not a table"\n');
    const entry = getTomlTargetStatus(options());
    expect(entry.state).toBe("malformed");
    expect(entry.error).toContain("`mcp_servers.muninn` must be a table");
  });

  it("classifies invalid command and args types as malformed", () => {
    writeConfig("[mcp_servers.muninn]\ncommand = 42\nargs = []\n");
    const command = getTomlTargetStatus(options());
    expect(command.state).toBe("malformed");
    expect(command.error).toContain("`mcp_servers.muninn.command` must be a string");

    writeConfig('[mcp_servers.muninn]\ncommand = "muninn"\nargs = "mcp"\n');
    const args = getTomlTargetStatus(options());
    expect(args.state).toBe("malformed");
    expect(args.error).toContain("`mcp_servers.muninn.args` must be an array of strings");

    writeConfig('[mcp_servers.muninn]\ncommand = "muninn"\nargs = [1, 2]\n');
    const numeric = getTomlTargetStatus(options());
    expect(numeric.state).toBe("malformed");
    expect(numeric.error).toContain("`mcp_servers.muninn.args` must be an array of strings");
  });

  it("replaces an explicit Muninn header mid-file without losing following tables", () => {
    writeConfig(
      [
        "# top of file",
        'model = "gpt-5"',
        "",
        "[mcp_servers.muninn]",
        'command = "old"',
        'args = ["old"]',
        "extra = true",
        "",
        "[after]",
        "flag = false",
        "",
      ].join("\n"),
    );

    const report = setupTomlTarget({ ...options(), force: true });
    expect(report.outcome).toBe("written");

    const content = readConfig();
    expect(content).toContain("# top of file");
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain("[mcp_servers.muninn]");
    expect(content).toContain('command = "muninn"');
    expect(content).toContain('args = ["mcp", "run"]');
    expect(content).not.toContain("extra = true");
    expect(content).toContain("[after]");
    expect(content).toContain("flag = false");
    expect(content.match(/\[mcp_servers\.muninn\]/g)).toHaveLength(1);
    expect(getTomlTargetStatus(options()).state).toBe("registered");
  });

  it("rejects repeated explicit Muninn headers and leaves the file untouched", () => {
    const original = [
      "[mcp_servers.muninn]",
      'command = "old"',
      'args = ["old"]',
      "",
      "[mcp_servers.muninn]",
      'command = "other"',
      'args = ["other"]',
      "",
    ].join("\n");
    writeConfig(original);

    const status = getTomlTargetStatus(options());
    expect(status.state).toBe("malformed");
    expect(status.error).toContain("duplicate table header `mcp_servers.muninn`");

    const report = setupTomlTarget({ ...options(), force: true });
    expect(report.outcome).toBe("failed");
    expect(report.changed).toBe(false);
    expect(readConfig()).toBe(original);
  });

  it("rejects dotted Muninn keys combined with an explicit header and leaves the file untouched", () => {
    const original = [
      "[mcp_servers]",
      'muninn.command = "old"',
      'muninn.args = ["old"]',
      "",
      "[mcp_servers.muninn]",
      'env = "y"',
      "",
    ].join("\n");
    writeConfig(original);

    const status = getTomlTargetStatus(options());
    expect(status.state).toBe("malformed");
    expect(status.error).toContain("already defined by dotted keys");

    const report = setupTomlTarget({ ...options(), force: true });
    expect(report.outcome).toBe("failed");
    expect(report.changed).toBe(false);
    expect(readConfig()).toBe(original);
  });

  it("round-trips every written document to a registered status", () => {
    const scenarios: Array<{ name: string; initial?: string }> = [
      { name: "new file" },
      {
        name: "explicit replacement",
        initial: '[mcp_servers.muninn]\ncommand = "old"\nargs = ["old"]\n',
      },
      {
        name: "dotted replacement",
        initial: 'mcp_servers.muninn.command = "old"\nmcp_servers.muninn.args = ["old"]\n',
      },
      {
        name: "parent table extension",
        initial: '[mcp_servers]\nother = "keep"\n',
      },
    ];

    for (const scenario of scenarios) {
      fs.rmSync(codexPath(), { force: true });
      if (scenario.initial !== undefined) writeConfig(scenario.initial);

      const report = setupTomlTarget({ ...options(), force: true });
      expect(report.outcome, scenario.name).toBe("written");
      expect(() => parseToml(readConfig()), scenario.name).not.toThrow();
      expect(getTomlTargetStatus(options()).state, scenario.name).toBe("registered");
    }
  });

  it("removes dotted mcp_servers.muninn keys before appending the canonical table", () => {
    writeConfig(
      [
        'mcp_servers.muninn.command = "old"',
        'mcp_servers.muninn.args = ["old"]',
        'model = "gpt-5"',
        "",
      ].join("\n"),
    );

    const report = setupTomlTarget({ ...options(), force: true });
    expect(report.outcome).toBe("written");

    const content = readConfig();
    expect(content).not.toContain('mcp_servers.muninn.command = "old"');
    expect(content).not.toContain('mcp_servers.muninn.args = ["old"]');
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain("[mcp_servers.muninn]");
    expect(getTomlTargetStatus(options()).state).toBe("registered");
  });

  it("extends an explicit [mcp_servers] table without disturbing its keys", () => {
    writeConfig('[mcp_servers]\nother = "keep"\n');

    const report = setupTomlTarget(options());
    expect(report.outcome).toBe("written");

    const content = readConfig();
    expect(content).toContain("[mcp_servers]");
    expect(content).toContain('other = "keep"');
    expect(content).toContain("[mcp_servers.muninn]");
  });

  it("separates an appended table from a file that lacks a trailing newline", () => {
    writeConfig("[server]\nport = 8080");

    const report = setupTomlTarget(options());
    expect(report.outcome).toBe("written");
    expect(readConfig()).toBe(
      [
        "[server]",
        "port = 8080",
        "",
        "[mcp_servers.muninn]",
        'command = "muninn"',
        'args = ["mcp", "run"]',
        "",
      ].join("\n"),
    );
  });

  it("refuses to rewrite an inline mcp_servers table and leaves the file untouched", () => {
    const original = 'mcp_servers = { muninn = { command = "old", args = [] } }\n';
    writeConfig(original);

    const report = setupTomlTarget({ ...options(), force: true });
    expect(report.outcome).toBe("failed");
    expect(report.error).toContain("inline");
    expect(readConfig()).toBe(original);
  });

  it("refuses to replace an array-of-tables sub-entry under muninn", () => {
    const original = '[[mcp_servers.muninn.plugins]]\nname = "x"\n';
    writeConfig(original);

    const status = getTomlTargetStatus(options());
    expect(status.state).toBe("conflict");

    const report = setupTomlTarget({ ...options(), force: true });
    expect(report.outcome).toBe("failed");
    expect(report.error).toContain("array-of-tables");
    expect(readConfig()).toBe(original);
  });

  it("reports duplicate keys as malformed TOML with the file path and keeps bytes", () => {
    const original = 'model = "a"\nmodel = "b"\n';
    writeConfig(original);

    const status = getTomlTargetStatus(options());
    expect(status.state).toBe("malformed");
    expect(status.error).toContain(codexPath());
    expect(status.error).toContain("duplicate key");

    const report = setupTomlTarget(options());
    expect(report.outcome).toBe("failed");
    expect(report.changed).toBe(false);
    expect(readConfig()).toBe(original);
  });

  it("treats a directory at the TOML path as malformed and never writes into it", () => {
    fs.mkdirSync(codexPath(), { recursive: true });

    const status = getTomlTargetStatus(options());
    expect(status.state).toBe("malformed");
    expect(status.error).toContain("not a regular file");

    const report = setupTomlTarget(options());
    expect(report.outcome).toBe("failed");
    expect(fs.statSync(codexPath()).isDirectory()).toBe(true);
  });

  it("keeps dry-run read-only for an existing conflicting file", () => {
    const original = '[mcp_servers.muninn]\ncommand = "old"\nargs = []\n';
    writeConfig(original);

    const planned = setupTomlTarget({ ...options(), force: true, dryRun: true });
    expect(planned.outcome).toBe("written");
    expect(planned.changed).toBe(true);
    expect(planned.dryRun).toBe(true);
    expect(readConfig()).toBe(original);

    const skipped = setupTomlTarget({ ...options(), dryRun: true });
    expect(skipped.outcome).toBe("skipped");
    expect(readConfig()).toBe(original);
  });

  it("writes atomically without leaving temporary files behind", () => {
    const report = setupTomlTarget(options());
    expect(report.outcome).toBe("written");

    const entries = fs.readdirSync(path.dirname(codexPath()));
    expect(entries).toEqual(["config.toml"]);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("reports legacy and conflict states without writing unless forced", () => {
    const legacy = '[mcp_servers.muninn]\ncommand = "huginn"\nargs = ["mcp", "run"]\n';
    writeConfig(legacy);
    expect(getTomlTargetStatus(options()).state).toBe("legacy");
    expect(setupTomlTarget(options()).outcome).toBe("skipped");
    expect(readConfig()).toBe(legacy);

    const conflict = '[mcp_servers.muninn]\ncommand = "other"\nargs = []\n';
    writeConfig(conflict);
    expect(getTomlTargetStatus(options()).state).toBe("conflict");
    expect(setupTomlTarget(options()).outcome).toBe("skipped");
    expect(readConfig()).toBe(conflict);
  });

  it("refuses a symlink in an intermediate component inside the project", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "muninn-toml-outside-"));
    try {
      const linkDir = path.join(project, ".codex");
      fs.symlinkSync(outside, linkDir);
      const targetPath = path.join(linkDir, "config.toml");

      const optionsInside = {
        target: AGENT_REGISTRY.codex,
        path: targetPath,
        projectPath: project,
      };
      const status = getTomlTargetStatus(optionsInside);
      expect(status.state).toBe("malformed");
      expect(status.error).toBeDefined();

      const report = setupTomlTarget(optionsInside);
      expect(report.outcome).toBe("failed");
      expect(fs.existsSync(path.join(outside, "config.toml"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not pin --project into a user-level TOML entry", () => {
    const report = setupTomlTarget(options());
    expect(report.outcome).toBe("written");
    expect(readConfig()).not.toContain("--project");
  });

  it("classifies an entry without args as a conflict", () => {
    writeConfig('[mcp_servers.muninn]\ncommand = "muninn"\n');

    expect(getTomlTargetStatus(options()).state).toBe("conflict");
    const report = setupTomlTarget({ ...options(), force: true });
    expect(report.outcome).toBe("written");
    expect(readConfig()).toContain('args = ["mcp", "run"]');
  });

  it("creates the canonical table in an existing empty file", () => {
    writeConfig("");

    const report = setupTomlTarget(options());
    expect(report.outcome).toBe("written");
    expect(readConfig()).toBe(
      [
        "[mcp_servers.muninn]",
        'command = "muninn"',
        'args = ["mcp", "run"]',
        "",
      ].join("\n"),
    );
  });

  it("reports an unreadable configuration as malformed without writing", () => {
    writeConfig('model = "gpt-5"\n');

    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("read denied");
    });
    let status: ReturnType<typeof getTomlTargetStatus>;
    try {
      status = getTomlTargetStatus(options());
    } finally {
      readSpy.mockRestore();
    }

    expect(status!.state).toBe("malformed");
    expect(status!.error).toContain("Cannot read codex MCP configuration");
    expect(status!.error).toContain("read denied");
    expect(readConfig()).toBe('model = "gpt-5"\n');
  });

  it("reports an atomic write failure without leaving a temporary file", () => {
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("rename denied");
    });
    let report: ReturnType<typeof setupTomlTarget>;
    try {
      report = setupTomlTarget(options());
    } finally {
      renameSpy.mockRestore();
    }

    expect(report!.outcome).toBe("failed");
    expect(report!.changed).toBe(false);
    expect(report!.error).toContain("Cannot write codex MCP configuration");
    expect(report!.error).toContain("rename denied");
    expect(fs.existsSync(codexPath())).toBe(false);
    const leftovers = fs
      .readdirSync(path.dirname(codexPath()))
      .filter((entry) => entry.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("reports present on a second run and keeps the modification time", () => {
    setupTomlTarget(options());
    const before = readConfig();
    const beforeStat = fs.statSync(codexPath());

    const second = setupTomlTarget(options());
    expect(second.outcome).toBe("present");
    expect(second.changed).toBe(false);
    expect(readConfig()).toBe(before);
    expect(fs.statSync(codexPath()).mtimeMs).toBe(beforeStat.mtimeMs);
  });
});

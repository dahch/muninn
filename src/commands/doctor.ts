/**
 * `muninn doctor` — one command that answers "why did my other agent not see
 * the memory?".
 *
 * It reports the resolved project, the portable storage, memory and graph
 * contents, and whether each known agent configuration actually contains a
 * working Muninn MCP entry (missing, legacy, project-pinned or malformed).
 * It is read-only: it never creates a database, config or directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import Database from "better-sqlite3";
import {
  memoryDbPath,
  muninnHome,
  projectStorageDir,
  resolveProjectContext,
} from "../project/identity.js";
import { checkIndexFreshness, getIndexStatus } from "../graph/index.js";
import { getHooksStatus } from "../setup/hooks-target.js";
import { getRulesTargetStatus } from "../setup/rules-target.js";
import {
  AGENT_IDS,
  AGENT_REGISTRY,
  resolveHooksPath,
  resolveMcpPaths,
  resolveRulesPath,
} from "../setup/registry.js";

export function printDoctorUsage(): void {
  console.log(`muninn doctor — diagnose Muninn across projects and agents

Usage:
  muninn doctor [--project <path>] [--json]

Reports the resolved project and portable storage, memory and code-graph counts,
and the state of every known agent MCP configuration. Read-only.
`);
}

type ConfigState =
  | "registered"
  | "missing"
  | "legacy"
  | "pinned"
  | "malformed"
  | "file-missing"
  | "unsupported";

interface AgentProbe {
  id: string;
  label: string;
  path: string;
  format: "json-mcpServers" | "json-opencode" | "toml";
}

function home(): string {
  return os.homedir();
}

/**
 * DSH Desktop is plugin-based: whether it can reach Muninn depends on an MCP
 * plugin being installed in its profile. There is no plain config file to edit,
 * so the doctor reports the truth instead of inventing a target.
 */
function probeDsh(): { state: ConfigState; detail?: string } {
  const file = path.join(home(), ".dsh", "profiles", "desktop", "package.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { state: "file-missing" };
  }
  try {
    const parsed = JSON.parse(raw) as {
      dsh?: { profile?: { bundles?: string[] } };
    };
    const bundles = parsed.dsh?.profile?.bundles ?? [];
    const mcpBundles = bundles.filter((bundle) => /mcp/i.test(bundle));
    if (mcpBundles.length > 0) {
      return {
        state: "registered",
        detail:
          "MCP plugin installed (" +
          mcpBundles.join(", ") +
          "); add Muninn from its MCP UI",
      };
    }
    const native = nativeDshServers();
    if (native.length > 0) {
      const names = native.flatMap((entry) => entry.servers);
      return {
        state: "registered",
        detail:
          "native declaration: " + names.join(", ") + " (" + native[0].file + ")",
      };
    }
    return {
      state: "unsupported",
      detail:
        "no MCP plugin or native @deepseek-ai/dsh-mcp-client declaration in the DSH profile",
    };
  } catch (err) {
    return { state: "malformed", detail: (err as Error).message };
  }
}

/**
 * Finds native MCP client declarations in DSH patch files (the shape documented
 * by @deepseek-ai/dsh-mcp-client): a `name: '@deepseek-ai/dsh-mcp-client'` line
 * followed by `serverName`. Read as text because patch files may contain
 * DSH-specific `!!js` tags that a plain YAML parser rejects.
 */
function nativeDshServers(): Array<{ file: string; servers: string[] }> {
  const candidates = [
    path.join(home(), ".dsh", "cordis.patch.yml"),
    path.join(home(), ".dsh", "profiles", "desktop", "cordis.patch.yml"),
  ];
  const found: Array<{ file: string; servers: string[] }> = [];
  for (const file of candidates) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/);
    const servers: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (!/name:\s*['"]?@deepseek-ai\/dsh-mcp-client['"]?\s*$/.test(lines[index])) {
        continue;
      }
      for (
        let lookahead = index + 1;
        lookahead < Math.min(index + 16, lines.length);
        lookahead++
      ) {
        const match = lines[lookahead].match(/^\s*serverName:\s*['"]?([A-Za-z0-9_-]+)/);
        if (match) {
          servers.push(match[1]);
          break;
        }
        if (/^\s*-\s*id:/.test(lines[lookahead])) break;
      }
    }
    if (servers.length > 0) found.push({ file, servers });
  }
  return found;
}

/**
 * Probe every home-scoped MCP destination in the catalog. Project-scoped paths
 * (`{project}/...`) belong to the project and are reported by setup/status, not
 * by a machine-wide doctor run.
 */
function agentProbes(): AgentProbe[] {
  const probes: AgentProbe[] = [];
  const seen = new Set<string>();
  for (const id of AGENT_IDS) {
    const spec = AGENT_REGISTRY[id];
    if (spec.format === "manual" || spec.mcpPaths.length === 0) continue;
    let resolved: string[];
    try {
      resolved = resolveMcpPaths(id, { homeDir: home() });
    } catch {
      continue;
    }
    let index = 0;
    for (const candidate of resolved) {
      if (candidate.includes("{project}")) continue;
      const key = path.resolve(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      index += 1;
      const format: AgentProbe["format"] =
        spec.format === "toml"
          ? "toml"
          : spec.format === "opencode"
            ? "json-opencode"
            : "json-mcpServers";
      probes.push({
        id: index === 1 ? id : `${id}#${index}`,
        label: index === 1 ? spec.label : `${spec.label} (${path.basename(path.dirname(candidate))})`,
        path: candidate,
        format,
      });
    }
  }
  return probes;
}

interface ProbeResult {
  id: string;
  label: string;
  path: string;
  state: ConfigState;
  detail?: string;
}

function classifyCommand(
  command: string,
  args: string[]
): { state: ConfigState; detail: string } {
  const full = [command, ...args].join(" ");
  if (/\bhuginn\b/.test(full)) {
    return { state: "legacy", detail: "invokes the legacy huginn binary" };
  }
  if (args.includes("--project")) {
    return {
      state: "pinned",
      detail: "pins --project, so other projects resolve to that one",
    };
  }
  if (!/\bmuninn\b/.test(full)) {
    return { state: "registered", detail: `unexpected command: ${full}` };
  }
  return { state: "registered", detail: full };
}

function probeJson(
  file: string,
  format: "json-mcpServers" | "json-opencode"
): { state: ConfigState; detail?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "file-missing" };
    }
    return { state: "malformed", detail: (err as Error).message };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return { state: "malformed", detail: (err as Error).message };
  }
  const container =
    format === "json-opencode"
      ? (parsed.mcp as Record<string, unknown> | undefined)
      : (parsed.mcpServers as Record<string, unknown> | undefined);
  const entry = container?.muninn as
    | { command?: string | string[]; args?: string[] }
    | undefined;
  if (!entry) return { state: "missing" };
  const command = Array.isArray(entry.command)
    ? entry.command[0] ?? ""
    : entry.command ?? "";
  const args = Array.isArray(entry.command)
    ? entry.command.slice(1)
    : (entry.args ?? []);
  return classifyCommand(command, args);
}

function probeToml(file: string): { state: ConfigState; detail?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "file-missing" };
    }
    return { state: "malformed", detail: (err as Error).message };
  }
  const section = raw.match(/\[mcp_servers\.muninn\]([\s\S]*?)(?:\n\[|$)/);
  if (!section) return { state: "missing" };
  const body = section[1];
  const command = body.match(/^\s*command\s*=\s*"([^"]*)"/m)?.[1] ?? "";
  const args = [...body.matchAll(/"([^"]*)"/g)]
    .map((match) => match[1])
    .filter((value) => value !== command);
  return classifyCommand(command, args);
}

function countMemory(dbPath: string): {
  exists: boolean;
  observations: number | null;
  entities: number | null;
  handoffs: number | null;
  projectId: string | null;
  projectName: string | null;
} {
  if (!fs.existsSync(dbPath)) {
    return { exists: false, observations: null, entities: null, handoffs: null, projectId: null, projectName: null };
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const count = (table: string): number | null => {
      try {
        return (
          db!
            .prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`)
            .get()?.n ?? 0
        );
      } catch {
        return null;
      }
    };
    const project = (() => {
      try {
        return db
          .prepare<[], { id: string; name: string }>(
            "SELECT id, name FROM projects ORDER BY created_at ASC LIMIT 1"
          )
          .get();
      } catch {
        return undefined;
      }
    })();
    return {
      exists: true,
      observations: count("observations"),
      entities: count("entities"),
      handoffs: count("handoffs"),
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
    };
  } catch {
    return { exists: true, observations: null, entities: null, handoffs: null, projectId: null, projectName: null };
  } finally {
    db?.close();
  }
}

export async function handleDoctorCommand(
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  if (args["--help"] || args["-h"]) {
    printDoctorUsage();
    return;
  }
  const explicit =
    typeof args["--project"] === "string" ? args["--project"] : undefined;
  const context = resolveProjectContext({
    explicitRoot: explicit ?? process.cwd(),
  });
  const dbPath = memoryDbPath(context.uid);
  const memory = countMemory(dbPath);

  let graph = null as ReturnType<typeof getIndexStatus> | null;
  let freshness = null as ReturnType<typeof checkIndexFreshness> | null;
  if (memory.exists && memory.projectId) {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const graphService = {
        db,
        currentProject: {
          id: memory.projectId,
          root_path: context.rootPath,
          name: context.name,
        },
      };
      graph = getIndexStatus(graphService);
      freshness = checkIndexFreshness(graphService);
    } catch {
      graph = null;
      freshness = null;
    } finally {
      db?.close();
    }
  }

  const probes: ProbeResult[] = [];
  const portablePath = path.join(muninnHome(), "mcp.json");
  const portable: { state: ConfigState; detail?: string } = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(portablePath, "utf8")) as {
        mcpServers?: Record<string, { command?: string; args?: string[] }>;
      };
      const entry = parsed.mcpServers?.muninn;
      if (!entry) return { state: "missing" as ConfigState };
      return classifyCommand(entry.command ?? "", entry.args ?? []);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { state: "file-missing" as ConfigState };
      }
      return { state: "malformed" as ConfigState, detail: (err as Error).message };
    }
  })();
  probes.push({
    id: "portable",
    label: "Portable (~/.muninn/mcp.json)",
    path: portablePath,
    state: portable.state,
    detail: portable.detail,
  });
  for (const probe of agentProbes()) {
    const result =
      probe.format === "toml"
        ? probeToml(probe.path)
        : probeJson(probe.path, probe.format === "json-opencode" ? "json-opencode" : "json-mcpServers");
    probes.push({ ...probe, state: result.state, detail: result.detail });
  }
  const dsh = probeDsh();
  probes.push({
    id: "dsh",
    label: "DSH Desktop",
    path: path.join(home(), ".dsh", "profiles", "desktop", "package.json"),
    state: dsh.state,
    detail: dsh.detail,
  });
  // Hooks are a per-agent descriptor, not a Claude special case.
  for (const id of AGENT_IDS) {
    const spec = AGENT_REGISTRY[id];
    if (!spec.hooks) continue;
    const hookPath = resolveHooksPath(id, {
      scope: "user",
      homeDir: home(),
    });
    if (!hookPath) continue;
    const hooks = getHooksStatus({ path: hookPath });
    const hookState: ConfigState =
      hooks.state === "present"
        ? "registered"
        : hooks.state === "absent" || hooks.state === "partial"
          ? "missing"
          : "malformed";
    probes.push({
      id: `${id}-hooks`,
      label: `${spec.label} hooks`,
      path: hooks.path,
      state: hookState,
      detail:
        hooks.state === "present"
          ? "session start/end and graph refresh installed"
          : hooks.state === "partial"
            ? `some hooks missing: run 'muninn hooks install --agent ${id}'`
            : `optional: run 'muninn hooks install --agent ${id}'`,
    });
  }

  // Rules-file ownership is also catalog data: dedicated, marked block or none.
  const rulesProbes = AGENT_IDS.filter((id) => {
    const spec = AGENT_REGISTRY[id];
    return spec.rulesStrategy !== "none" && spec.rulesFile.length > 0;
  }).map((id) => {
    const spec = AGENT_REGISTRY[id];
    const rulesPath = resolveRulesPath(id, { projectPath: context.rootPath });
    const status = getRulesTargetStatus({
      path: rulesPath,
      agents: [id],
      projectPath: context.rootPath,
      strategy: spec.rulesStrategy,
    });
    return {
      id,
      label: spec.label,
      path: status.path,
      strategy: spec.rulesStrategy,
      state: status.state,
      error: status.error,
    };
  });

  const warnings: string[] = [];
  for (const probe of probes) {
    if (
      probe.state === "legacy" ||
      probe.state === "pinned" ||
      probe.state === "malformed" ||
      probe.state === "unsupported"
    ) {
      warnings.push(`${probe.label}: ${probe.state}${probe.detail ? ` — ${probe.detail}` : ""}`);
    }
  }
  if (!memory.exists) {
    warnings.push("This project has no memory yet: run 'muninn setup --agent <id>' and 'muninn seed'.");
  } else if ((memory.observations ?? 0) === 0) {
    warnings.push("Memory exists but is empty: run 'muninn seed' or save the first decision.");
  }
  for (const rules of rulesProbes) {
    if (rules.state === "malformed" || rules.state === "stale") {
      warnings.push(
        `${rules.label} rules: ${rules.state}${rules.error ? ` — ${rules.error}` : ""} (run 'muninn setup --agent ${rules.id}')`
      );
    }
  }
  if (!graph || graph.files === 0) {
    warnings.push("The code graph is empty: run 'muninn index' (or muninn_project action=index).");
  } else if (freshness && !freshness.fresh) {
    warnings.push(
      `The code graph is stale (${freshness.reason}): run 'muninn index' (or muninn_project action=index).`
    );
  }

  if (args["--json"]) {
    console.log(
      JSON.stringify(
        {
          project: {
            name: context.name,
            rootPath: context.rootPath,
            uid: context.uid,
            kind: context.kind,
            source: context.source,
            markerPath: context.markerPath,
            gitRemote: context.gitRemote,
          },
          storage: { directory: projectStorageDir(context.uid), databasePath: dbPath },
          memory,
          graph,
          graphFreshness: freshness,
          agents: probes,
          rules: rulesProbes,
          warnings,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(chalk.bold("Muninn doctor"));
  console.log("\nProject");
  console.log(`  Name:    ${context.name}`);
  console.log(`  Root:    ${context.rootPath}`);
  console.log(`  UID:     ${context.uid} (${context.kind}, resolved via ${context.source})`);
  console.log(`  Marker:  ${context.markerPath ?? chalk.dim("none — run 'muninn project register'")}`);
  console.log(`  Storage: ${projectStorageDir(context.uid)}`);

  console.log("\nMemory");
  if (!memory.exists) {
    console.log(chalk.dim("  Not initialized for this project."));
  } else {
    console.log(`  Database:     ${dbPath}`);
    console.log(`  Observations: ${memory.observations ?? "unavailable"}`);
    console.log(`  Entities:     ${memory.entities ?? "unavailable"}`);
    console.log(`  Handoffs:     ${memory.handoffs ?? "unavailable"}`);
  }

  console.log("\nCode graph");
  if (!graph || graph.files === 0) {
    console.log(chalk.dim("  Not indexed."));
  } else {
    console.log(`  Files:    ${graph.files}`);
    console.log(`  Symbols:  ${graph.symbols}`);
    console.log(`  Edges:    ${graph.edges}`);
    console.log(`  Indexed:  ${graph.indexedAt ?? "unknown"}`);
    if (freshness) {
      console.log(
        `  Fresh:    ${
          freshness.fresh
            ? chalk.green("yes")
            : chalk.yellow(`no — ${freshness.reason}`)
        }`
      );
    }
    if (graph.languages.length > 0) {
      console.log(
        "  Languages: " + graph.languages.map((row) => `${row.language} (${row.files})`).join(", ")
      );
    }
  }

  console.log("\nAgents");
  const labels: Record<ConfigState, string> = {
    registered: chalk.green("registered"),
    missing: chalk.dim("no muninn entry"),
    "file-missing": chalk.dim("no config file"),
    legacy: chalk.red("legacy huginn"),
    pinned: chalk.yellow("pinned project"),
    malformed: chalk.red("malformed"),
    unsupported: chalk.yellow("no MCP support"),
  };
  for (const probe of probes) {
    console.log(`  ${probe.label.padEnd(28)} ${labels[probe.state]}`);
    console.log(chalk.dim(`    ${probe.path}`));
  }

  console.log("\nRules files");
  for (const rules of rulesProbes) {
    const label =
      rules.state === "present"
        ? chalk.green("present")
        : rules.state === "stale"
          ? chalk.yellow("stale")
          : rules.state === "malformed"
            ? chalk.red("malformed")
            : chalk.dim("not installed");
    const ownership =
      rules.strategy === "dedicated" ? "dedicated file" : "marked block";
    console.log(`  ${rules.label.padEnd(28)} ${label} ${chalk.dim(`(${ownership})`)}`);
    if (rules.error) console.log(chalk.red(`    ${rules.error}`));
  }

  if (warnings.length === 0) {
    console.log(chalk.green("\nNo problems found."));
  } else {
    console.log(chalk.yellow(`\n${warnings.length} warning(s):`));
    for (const warning of warnings) console.log(`- ${warning}`);
  }
}

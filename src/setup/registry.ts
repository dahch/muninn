/**
 * Catalog of supported agent destinations.
 *
 * The routes and formats are the Huginn integrator reference's definitions,
 * reproduced here without importing Huginn. Paths are templates so callers can
 * inject a home directory, project root, OpenCode config directory, or an
 * environment override.
 */
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

export type AgentFormat = "mcpServers" | "opencode" | "toml";

export type AgentId =
  | "cursor"
  | "claude"
  | "opencode"
  | "devin"
  | "qwen"
  | "codex"
  | "agy"
  | "kimi"
  | "pi"
  | "commandcode"
  | "omp"
  | "mcode"
  | "mimo";

export interface AgentTarget {
  id: AgentId;
  label: string;
  format: AgentFormat;
  /** Path templates; `{project}`, `{home}` and `{opencodeConfigDir}` expand. */
  mcpPaths: string[];
  /** Rules-file path relative to the project root. */
  rulesFile: string;
  /**
   * CLI binary used only for the nonfatal `not installed` diagnostic.
   * `null` means the target has no meaningful local executable (for example an
   * IDE or web-hosted agent), so the warning is not applicable.
   */
  executable: string | null;
}

export interface ResolveMcpPathsOptions {
  projectPath?: string;
  homeDir?: string;
  opencodeConfigDir?: string;
  env?: Record<string, string | undefined>;
}

export const AGENT_REGISTRY: Record<AgentId, AgentTarget> = {
  cursor: {
    id: "cursor",
    label: "Cursor",
    format: "mcpServers",
    mcpPaths: ["{project}/.cursor/mcp.json", "{home}/.cursor/mcp.json"],
    rulesFile: ".cursorrules",
    executable: null,
  },
  claude: {
    id: "claude",
    label: "Claude Code / Desktop",
    format: "mcpServers",
    mcpPaths: [
      "{project}/.mcp.json",
      "{home}/.claude.json",
      "{home}/.claude/claude_desktop_config.json",
    ],
    rulesFile: "CLAUDE.md",
    executable: "claude",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    format: "opencode",
    mcpPaths: ["{opencodeConfigDir}/opencode.json"],
    rulesFile: "AGENTS.md",
    executable: "opencode",
  },
  devin: {
    id: "devin",
    label: "Devin",
    format: "mcpServers",
    mcpPaths: ["{project}/.devin/mcp_config.json", "{home}/.config/devin/mcp_config.json"],
    rulesFile: ".windsurf/rules/muninn.md",
    executable: null,
  },
  qwen: {
    id: "qwen",
    label: "Qwen Code",
    format: "mcpServers",
    mcpPaths: ["{home}/.qwen/settings.json"],
    rulesFile: "QWEN.md",
    executable: "qwen",
  },
  codex: {
    id: "codex",
    label: "OpenAI Codex CLI",
    format: "toml",
    mcpPaths: ["{home}/.codex/config.toml"],
    rulesFile: "AGENTS.md",
    executable: "codex",
  },
  agy: {
    id: "agy",
    label: "Antigravity CLI (agy)",
    format: "mcpServers",
    mcpPaths: ["{home}/.gemini/config/mcp_config.json", "{project}/.agents/mcp_config.json"],
    rulesFile: "AGENTS.md",
    executable: "agy",
  },
  kimi: {
    id: "kimi",
    label: "Kimi Code CLI",
    format: "mcpServers",
    mcpPaths: ["{home}/.kimi-code/mcp.json", "{project}/.kimi/mcp.json"],
    rulesFile: "AGENTS.md",
    executable: "kimi",
  },
  pi: {
    id: "pi",
    label: "Pi coding agent",
    format: "mcpServers",
    mcpPaths: ["{home}/.pi/agent/mcp.json", "{project}/.pi/mcp.json"],
    rulesFile: "AGENTS.md",
    executable: "pi",
  },
  commandcode: {
    id: "commandcode",
    label: "Command Code",
    format: "mcpServers",
    mcpPaths: ["{home}/.commandcode/mcp.json", "{project}/.mcp.json"],
    rulesFile: "AGENTS.md",
    executable: "commandcode",
  },
  omp: {
    id: "omp",
    label: "Oh My Pi",
    format: "mcpServers",
    mcpPaths: ["{home}/.omp/mcp.json", "{project}/.omp/mcp.json"],
    rulesFile: "AGENTS.md",
    executable: "omp",
  },
  mcode: {
    id: "mcode",
    label: "MiniMax Code",
    format: "mcpServers",
    mcpPaths: ["{project}/.mcp.json"],
    rulesFile: "AGENTS.md",
    executable: "mcode",
  },
  mimo: {
    id: "mimo",
    label: "MiMo Code",
    format: "opencode",
    mcpPaths: ["{home}/.config/mimocode/mimocode.json"],
    rulesFile: "AGENTS.md",
    executable: "mimo",
  },
};

export const AGENT_IDS = Object.keys(AGENT_REGISTRY) as AgentId[];

/**
 * Explicit executable name used only for the nonfatal `not installed`
 * diagnostic. It is intentionally declared per catalog entry and never inferred
 * from the agent ID or from whether a config file exists. `null` means the
 * target has no applicable local executable and must not warn.
 */
export function agentExecutable(id: AgentId): string | null {
  return AGENT_REGISTRY[id].executable;
}

export function isAgentId(value: string): value is AgentId {
  return Object.prototype.hasOwnProperty.call(AGENT_REGISTRY, value);
}

function envFor(options: ResolveMcpPathsOptions): Record<string, string | undefined> {
  return options.env ?? process.env;
}

function opencodeConfigDirFor(options: ResolveMcpPathsOptions): string {
  if (options.opencodeConfigDir) return resolve(options.opencodeConfigDir);
  const env = envFor(options);
  const fromEnv =
    env.MUNINN_OPENCODE_CONFIG_DIR ?? env.HUGINN_OPENCODE_CONFIG_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv);
  return join(options.homeDir ?? homedir(), ".config", "opencode");
}

function expandTemplate(template: string, options: ResolveMcpPathsOptions): string {
  const homeDir = options.homeDir ?? homedir();
  const projectPath =
    options.projectPath === undefined ? undefined : resolve(options.projectPath);
  let expanded = template
    .replaceAll("{home}", homeDir)
    .replaceAll("{opencodeConfigDir}", opencodeConfigDirFor(options));
  if (projectPath !== undefined) expanded = expanded.replaceAll("{project}", projectPath);
  return normalize(expanded);
}

/**
 * Split a colon-separated override without breaking a Windows drive letter
 * (`C:\path:D:\path`). Empty segments are ignored.
 */
function splitOverride(value: string): string[] {
  const raw = value.split(":");
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]!;
    if (/^[A-Za-z]$/.test(entry) && i + 1 < raw.length) {
      const next = raw[i + 1]!;
      if (next.startsWith("\\") || next.startsWith("/")) {
        out.push(`${entry}:${next}`);
        i++;
        continue;
      }
    }
    out.push(entry);
  }
  return out.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * Resolve a target's MCP config paths. A nonempty
 * `MUNINN_AGENT_<ID>_MCP_PATH` replaces the catalog paths; empty segments are
 * ignored and an override that resolves to no paths is rejected.
 */
export function resolveMcpPaths(
  target: AgentId | AgentTarget,
  options: ResolveMcpPathsOptions = {},
): string[] {
  const spec = typeof target === "string" ? AGENT_REGISTRY[target] : target;
  const env = envFor(options);
  const override =
    env[`MUNINN_AGENT_${spec.id.toUpperCase()}_MCP_PATH`] ??
    env[`HUGINN_AGENT_${spec.id.toUpperCase()}_MCP_PATH`];
  const templates =
    override !== undefined && override.trim().length > 0
      ? splitOverride(override)
      : spec.mcpPaths;
  if (templates.length === 0) {
    throw new Error(
      `MUNINN_AGENT_${spec.id.toUpperCase()}_MCP_PATH contains no usable paths`,
    );
  }
  return templates.map((template) => expandTemplate(template, options));
}

/** Rules path under the selected project root (or the catalog path without one). */
export function resolveRulesPath(
  target: AgentId | AgentTarget,
  options: Pick<ResolveMcpPathsOptions, "projectPath"> = {},
): string {
  const spec = typeof target === "string" ? AGENT_REGISTRY[target] : target;
  return options.projectPath === undefined
    ? spec.rulesFile
    : normalize(join(resolve(options.projectPath), spec.rulesFile));
}

export type AgentSelection =
  | { ok: true; ids: AgentId[] }
  | { ok: false; unknown: string[]; valid: AgentId[] };

/** Parse one ID, `all`, or a comma-separated list; deduplicate in catalog order. */
export function parseAgentSelection(value: string): AgentSelection {
  const requested = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (requested.length === 0) {
    return { ok: false, unknown: [value.trim() || "<empty>"], valid: [...AGENT_IDS] };
  }
  const unknown = requested.filter((entry) => entry !== "all" && !isAgentId(entry));
  if (unknown.length > 0) {
    return { ok: false, unknown: [...new Set(unknown)], valid: [...AGENT_IDS] };
  }
  if (requested.includes("all")) {
    return { ok: true, ids: [...AGENT_IDS] };
  }
  return { ok: true, ids: AGENT_IDS.filter((id) => requested.includes(id)) };
}

/** True only when `child` is inside (or equal to) `root`, using path.relative. */
export function isProjectContained(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}

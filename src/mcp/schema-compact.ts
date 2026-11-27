/**
 * Compact JSON schemas for the advertised MCP tool list.
 *
 * Every session pays for the tool schemas before the first prompt. The generated
 * schemas carry per-tool `$schema` banners, `additionalProperties: false` on each
 * object, long prose on every argument, and a full description on each
 * snake_case alias whose only purpose is argument normalization. None of that
 * helps a model choose a tool, so the advertised copy drops the banner and the
 * alias prose and shortens argument descriptions to one clause.
 *
 * Validation is untouched: the server still validates the original Zod schema
 * after `normalizeArgs`, and snake_case aliases keep working because
 * normalization maps them before parsing.
 */
export const MAX_SCHEMA_DESCRIPTION = 35;

/**
 * snake_case aliases stay callable through `normalizeArgs`, but most do not need
 * to be advertised: the model reads the camelCase name. These four are part of
 * the documented compatibility surface and stay visible.
 */
const ADVERTISED_ALIASES = new Set([
  "project_id",
  "project_root",
  "supersedes_topic_key",
  "include_superseded",
]);

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_SCHEMA_DESCRIPTION) return flat;
  const cut = flat.slice(0, MAX_SCHEMA_DESCRIPTION);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > MAX_SCHEMA_DESCRIPTION * 0.5 ? cut.slice(0, lastSpace) : cut;
  return `${body.trim()}…`;
}

function walk(value: unknown, propertyName?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$schema" || key === "additionalProperties") continue;
    if (key === "description" && typeof child === "string") {
      if (propertyName && propertyName.includes("_")) continue;
      out[key] = shorten(child);
      continue;
    }
    out[key] = walk(child, propertyName ?? key);
  }
  return out;
}

/**
 * Fields the model actually needs to call each tool correctly. Everything else
 * stays accepted by the Zod validator and by `normalizeArgs`; it is simply not
 * advertised, which keeps the per-session tool budget small without removing a
 * capability.
 */
const ADVERTISED_FIELDS: Record<string, string[]> = {
  muninn_save: [
    "category",
    "title",
    "content",
    "topicKey",
    "projectId",
    "symbols",
    "supersedesTopicKey",
  ],
  muninn_handoff: [
    "action",
    "goal",
    "state",
    "nextSteps",
    "openQuestions",
    "blockers",
    "filesTouched",
  ],
  muninn_search: [
    "query",
    "category",
    "limit",
    "allProjects",
    "includeSuperseded",
    "detail",
  ],
  muninn_context: [
    "limit",
    "category",
    "topicKey",
    "allProjects",
    "includeSuperseded",
    "detail",
  ],
  muninn_bootstrap: ["paths", "budgetChars", "expandGraph", "detail"],
};

export function compactToolSchema(
  schema: Record<string, unknown>,
  toolName?: string
): Record<string, unknown> {
  const allowed = toolName ? ADVERTISED_FIELDS[toolName] : undefined;
  // Property names are only known one level down: `properties` maps a name to a
  // subschema, so the child name has to be threaded through explicitly.
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "additionalProperties") continue;
    if (key === "properties" && value && typeof value === "object") {
      const properties: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        if (name.includes("_")) {
          // Aliases are compatibility surface, not part of the curated list.
          if (!ADVERTISED_ALIASES.has(name)) continue;
        } else if (allowed && !allowed.includes(name)) {
          continue;
        }
        properties[name] = walk(sub, name);
      }
      result[key] = properties;
      continue;
    }
    result[key] = walk(value, key);
  }
  return result;
}

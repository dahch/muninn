/**
 * Strips ANSI escape sequences, non-printable control characters, and invisible
 * text-spoofing controls — bidi overrides and zero-width joiners/spaces (SEC-001,
 * SEC-307) — to prevent terminal injection, cursor hijacking, Trojan-Source
 * reordering and log poisoning. Legitimate non-ASCII (accents, emoji, CJK) is
 * left untouched.
 */
export function sanitizeTerminalText(input: string): string {
  if (typeof input !== "string") return "";
  return input
    .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "")
    // SEC-307: bidi embedding/override/isolate controls (U+202A–U+202E,
    // U+2066–U+2069) and zero-width/bidi-mark characters (U+200B–U+200F) can
    // reorder or hide text in a terminal/log without being visible themselves.
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "");
}

/**
 * Reduce a long observation body to a short, deterministic excerpt around the
 * first query term. Used by the compact MCP projection so a search result costs
 * a snippet instead of the whole record; `detail: "full"` returns the body.
 *
 * The excerpt never exceeds `maxChars` and is cut on whitespace when possible.
 * No ellipsis is added when the whole text already fits.
 */
export function makeSnippet(text: string, terms: string[], maxChars = 220): string {
  const limit = Math.max(40, Math.floor(maxChars));
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;

  let at = -1;
  for (const term of terms) {
    const needle = term.trim().toLocaleLowerCase();
    if (needle.length === 0) continue;
    const index = flat.toLocaleLowerCase().indexOf(needle);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  const anchor = at === -1 ? 0 : at;
  const lead = Math.floor(limit * 0.3);
  let start = Math.max(0, anchor - lead);
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space !== -1 && space - start < 20) start = space + 1;
  }
  let end = Math.min(flat.length, start + limit);
  if (end >= 0 && end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > start + limit / 2) end = space;
  }
  const body = flat.slice(start, end).trim();
  const prefix = start > 0 ? "… " : "";
  const suffix = end < flat.length ? " …" : "";
  return `${prefix}${body}${suffix}`;
}

/**
 * Build the subword token string indexed alongside a symbol.
 *
 * SQLite's tokenizers split on non-alphanumerics only, so a camelCase or
 * snake_case identifier becomes one opaque token. Splitting it here lets a search
 * for "contract" find `verifyTypeScriptContracts` and a search for "session"
 * find `read_session_brief`. Values are lowercased and deduplicated in order.
 */
export function symbolSearchTokens(
  ...values: Array<string | null | undefined>
): string {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const parts = String(value)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[^\p{L}\p{N}]+/u);
    for (const part of parts) {
      const token = part.toLocaleLowerCase();
      if (token.length > 1) seen.add(token);
      if (seen.size >= 64) break;
    }
    if (seen.size >= 64) break;
  }
  return [...seen].join(" ");
}

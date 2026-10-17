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

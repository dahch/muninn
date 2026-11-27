/**
 * Query planning for memory search.
 *
 * FTS5 is a lexical engine and its default `MATCH` semantics are a conjunction:
 * `"a" "b"` only matches documents that contain both terms. Agents ask in
 * natural language, so a strict conjunction silently returns nothing for most
 * real questions. The planner therefore produces two tiers over the same FTS
 * table:
 *
 * - `exact`: every term, as written (the historical behavior). Preserved so
 *   path, symbol and phrase queries keep their precision.
 * - `broad`: the same terms joined with OR and prefix-expanded, used only to
 *   fill a result set that the exact tier could not complete.
 *
 * Ranking stays deterministic: exact-tier rows keep their BM25 order and broad
 * rows are appended after them, so a caller never sees a weaker match ranked
 * above a complete one. Fuzzy (trigram) recovery is a separate tier owned by the
 * storage migration, not by this planner.
 */
export interface SearchPlan {
  /** Conjunction of every term, exactly as the historical sanitizer produced. */
  exact: string;
  /** Disjunction of the same terms with prefix expansion. */
  broad: string;
  /** Normalized terms, in query order, used for snippets and entity boosts. */
  terms: string[];
  /** True when the query has more than one term. */
  multiTerm: boolean;
}

const QUOTED_OR_WORD = /"([^"]*)"|(\S+)/g;

/**
 * Extract the words of a query without FTS syntax. Quoted phrases stay single
 * terms (their inner spaces are meaningful), wildcards are reduced to their
 * base, and pure-punctuation fragments are dropped.
 */
export function extractSearchTerms(query: string): string[] {
  if (typeof query !== "string") return [];
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!/[\p{L}\p{N}]/u.test(trimmed)) return;
    const base = trimmed.endsWith("*") ? trimmed.slice(0, -1) : trimmed;
    const clean = base.replace(/"/g, "").trim();
    if (!clean) return;
    const key = clean.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(clean);
  };

  let match: RegExpExecArray | null;
  QUOTED_OR_WORD.lastIndex = 0;
  while ((match = QUOTED_OR_WORD.exec(query)) !== null) {
    if (match[1] !== undefined) push(match[1]);
    else if (match[2] !== undefined) push(match[2]);
  }
  return terms;
}

function quote(term: string): string {
  return `"${term.replace(/"/g, "")}"`;
}

/**
 * Build the two-tier plan for a query, or `null` when nothing searchable
 * remains. `exact` is the historical `sanitizeFtsQuery` output, passed in by the
 * caller so the escaping rules stay in exactly one place.
 */
export function planSearchQuery(query: string, exact: string): SearchPlan | null {
  if (!exact) return null;
  const terms = extractSearchTerms(query);
  if (terms.length === 0) return null;
  const broad = terms.map((term) => `${quote(term)}*`).join(" OR ");
  return {
    exact,
    broad,
    terms,
    multiTerm: terms.length > 1,
  };
}

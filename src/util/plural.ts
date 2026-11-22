/**
 * Human-facing count labels: `1 file`, `2 files`, `1 edge`, `2 edges`.
 *
 * CLI summaries and brief sections print counts next to nouns, and `1 symbols`
 * reads like an unfinished sentence. English plurals here are regular on
 * purpose; pass `pluralForm` for irregular nouns.
 */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

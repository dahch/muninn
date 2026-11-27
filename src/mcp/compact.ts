/**
 * Compact MCP projections.
 *
 * Memory bodies are long (about 1.1k characters per observation in practice) and
 * a search returns up to ten of them. Sending every body to a model costs the
 * context budget for information the model rarely needs in full. The compact
 * projection keeps identity, ranking and a short excerpt, and callers that need
 * the whole record ask for `detail: "full"`.
 */
import type { ObservationWithEntities, SearchResult } from "../service/memory-service.js";
import { makeSnippet } from "../util/text.js";

export const COMPACT_SNIPPET_CHARS = 90;
/** A record can link dozens of files; the compact projection keeps the first few. */
export const MAX_COMPACT_ENTITIES = 5;

export interface CompactEntityRef {
  identifier: string;
}

/**
 * Compact record. Nullable fields are omitted when empty so a ten-result page
 * stays within a few hundred tokens; `detail: "full"` returns everything.
 */
export interface CompactObservation {
  id: string;
  category: string;
  title: string;
  status: string;
  updated_at: string;
  snippet: string;
  topic_key?: string;
  superseded_by?: string;
  entities?: CompactEntityRef[];
}

export interface CompactSearchResult extends CompactObservation {
  rank: number;
}

function entityRefs(observation: ObservationWithEntities): CompactEntityRef[] {
  return observation.entities
    .slice(0, MAX_COMPACT_ENTITIES)
    .map((entity) => ({ identifier: entity.identifier }));
}

export function compactObservation(
  observation: ObservationWithEntities,
  terms: string[],
  maxChars: number = COMPACT_SNIPPET_CHARS
): CompactObservation {
  const compact: CompactObservation = {
    id: observation.id,
    category: observation.category,
    title: observation.title,
    status: observation.status,
    updated_at: observation.updated_at,
    snippet: makeSnippet(observation.content, terms, maxChars),
  };
  if (observation.topic_key) compact.topic_key = observation.topic_key;
  if (observation.superseded_by) compact.superseded_by = observation.superseded_by;
  const entities = entityRefs(observation);
  if (entities.length > 0) compact.entities = entities;
  return compact;
}

export function compactSearchResults(
  results: SearchResult[],
  terms: string[],
  maxChars: number = COMPACT_SNIPPET_CHARS
): CompactSearchResult[] {
  return results.map((result) => ({
    ...compactObservation(result, terms, maxChars),
    rank: Math.round(result.rank * 100) / 100,
  }));
}

import type { MemorySearchHit } from "./types.js";

export const DEFAULT_RRF_K = 60;

export type RankedList = {
  backendId: string;
  hits: readonly MemorySearchHit[];
};

export type FusedHit = {
  hit: MemorySearchHit;
  backendId: string;
  fusedScore: number;
  /** Other backends that returned the same excerpt. */
  alsoFrom: string[];
};

function excerptKey(excerpt: string): string {
  return excerpt.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Reciprocal rank fusion across backends. Each backend's own order is trusted;
 * raw scores are never compared across backends because their scales differ.
 * Identical excerpts from several backends merge into one hit that keeps the
 * best-ranked copy and sums the fused contributions.
 */
export function fuseRankedLists(
  lists: readonly RankedList[],
  options: { k?: number; weights?: Record<string, number> } = {},
): FusedHit[] {
  const k = options.k !== undefined && options.k > 0 ? options.k : DEFAULT_RRF_K;
  const merged = new Map<string, FusedHit & { bestContribution: number; order: number }>();
  let order = 0;
  for (const list of lists) {
    const weight = options.weights?.[list.backendId] ?? 1;
    if (!(weight > 0)) {
      continue;
    }
    list.hits.forEach((hit, index) => {
      const contribution = weight / (k + index + 1);
      const key = excerptKey(hit.excerpt);
      const existing = key ? merged.get(key) : undefined;
      if (!existing) {
        merged.set(key || `\u0000${order}`, {
          hit,
          backendId: list.backendId,
          fusedScore: contribution,
          alsoFrom: [],
          bestContribution: contribution,
          order: order++,
        });
        return;
      }
      existing.fusedScore += contribution;
      if (existing.backendId !== list.backendId && !existing.alsoFrom.includes(list.backendId)) {
        existing.alsoFrom.push(list.backendId);
      }
      if (contribution > existing.bestContribution) {
        if (!existing.alsoFrom.includes(existing.backendId)) {
          existing.alsoFrom.push(existing.backendId);
        }
        existing.alsoFrom = existing.alsoFrom.filter((id) => id !== list.backendId);
        existing.hit = hit;
        existing.backendId = list.backendId;
        existing.bestContribution = contribution;
      }
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.fusedScore - a.fusedScore || a.order - b.order)
    .map(({ hit, backendId, fusedScore, alsoFrom }) => ({ hit, backendId, fusedScore, alsoFrom }));
}

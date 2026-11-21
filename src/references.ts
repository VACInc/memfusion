import type { MemoryCitation, MemoryReference } from "./types.js";

/**
 * The owner must hand out references under its own provider id, so a backend
 * reference is wrapped: `id` carries the backend provider id and the backend's
 * own id, and revision/fragment pass through unchanged.
 */
export function toOwnerReference(ownerId: string, backend: MemoryReference): MemoryReference {
  return {
    providerId: ownerId,
    id: JSON.stringify([backend.providerId, backend.id]),
    ...(backend.revision !== undefined ? { revision: backend.revision } : {}),
    ...(backend.fragment !== undefined ? { fragment: backend.fragment } : {}),
  };
}

/** Reverses toOwnerReference; returns null for references this owner never issued. */
export function fromOwnerReference(ownerId: string, owner: MemoryReference): MemoryReference | null {
  if (owner.providerId !== ownerId) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(owner.id);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    parsed[0].length === 0
  ) {
    return null;
  }
  return {
    providerId: parsed[0],
    id: parsed[1],
    ...(owner.revision !== undefined ? { revision: owner.revision } : {}),
    ...(owner.fragment !== undefined ? { fragment: owner.fragment } : {}),
  };
}

export function toOwnerCitations(
  ownerId: string,
  citations: MemoryCitation[] | undefined,
): MemoryCitation[] | undefined {
  if (!citations) {
    return undefined;
  }
  return citations.map((citation) =>
    citation.reference
      ? { ...citation, reference: toOwnerReference(ownerId, citation.reference) }
      : { ...citation },
  );
}

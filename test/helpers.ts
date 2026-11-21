import type {
  MemoryProviderCapabilities,
  MemoryProviderHandle,
  MemorySearchHit,
  MemorySearchRequest,
} from "../src/types.js";

export type FakeBackend = MemoryProviderHandle & {
  calls: { search: MemorySearchRequest[]; closed: number };
};

export function hit(providerId: string, id: string, excerpt: string, score?: number): MemorySearchHit {
  return { reference: { providerId, id }, excerpt, ...(score !== undefined ? { score } : {}) };
}

export function fakeBackend(
  providerId: string,
  hits: MemorySearchHit[],
  options: {
    capabilities?: Partial<MemoryProviderCapabilities>;
    search?: (request: MemorySearchRequest) => Promise<{ hits: MemorySearchHit[]; coverage?: "complete" | "partial"; warning?: string }>;
    health?: "ready" | "degraded" | "unavailable";
    texts?: Record<string, string>;
  } = {},
): FakeBackend {
  const calls = { search: [] as MemorySearchRequest[], closed: 0 };
  return {
    calls,
    capabilities: {
      sources: ["memory"],
      pagination: false,
      candidates: [],
      projectFilter: false,
      ...options.capabilities,
    },
    async search(request) {
      calls.search.push(request);
      return options.search ? options.search(request) : { hits };
    },
    async get({ reference }) {
      const text = options.texts?.[reference.id];
      return text === undefined ? { status: "not_found" } : { status: "ok", reference, text };
    },
    async health() {
      return { status: options.health ?? "ready" };
    },
    async close() {
      calls.closed += 1;
    },
  };
}

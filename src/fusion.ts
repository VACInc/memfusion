import { fuseRankedLists, type RankedList } from "./rank.js";
import { fromOwnerReference, toOwnerCitations, toOwnerReference } from "./references.js";
import type {
  MemfusionConfig,
  MemoryCandidateKind,
  MemoryCandidateRequest,
  MemoryGetRequest,
  MemoryGetResult,
  MemoryHealth,
  MemoryProviderCapabilities,
  MemoryProviderHandle,
  MemoryProviderOpenParams,
  MemoryProviderOpenResult,
  MemorySearchHit,
  MemorySearchPage,
  MemorySearchRequest,
  MemorySource,
  MemoryStoreRequest,
  MemoryStoreResult,
} from "./types.js";
import { WORKSPACE_TARGET } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 15_000;

/** One opened backend lease, keyed by the provider id its references carry. */
export type OpenBackend = {
  backendId: string;
  providerId: string;
  handle: MemoryProviderHandle;
};

type BackendFailure = { backendId: string; error: string };

class BackendTimeoutError extends Error {}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BackendTimeoutError(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type StoreTargets = { backends: OpenBackend[]; workspace: boolean };

const isWritable = ({ handle }: OpenBackend) =>
  handle.capabilities.store === true && typeof handle.store === "function";

/** Resolves the `store` setting against the backends that actually opened. */
export function resolveStoreTargets(
  setting: MemfusionConfig["store"],
  backends: readonly OpenBackend[],
): StoreTargets {
  const writable = backends.filter(isWritable);
  if (setting === "all") return { backends: writable, workspace: true };
  if (Array.isArray(setting)) {
    return {
      backends: writable.filter(({ backendId }) => setting.includes(backendId)),
      workspace: setting.includes(WORKSPACE_TARGET),
    };
  }
  return writable.length > 0 ? { backends: writable, workspace: false } : { backends: [], workspace: true };
}

/** Fused capabilities: a feature is claimed only where it can be honored. */
export function fuseCapabilities(backends: readonly OpenBackend[]): MemoryProviderCapabilities {
  const sources = new Set<MemorySource>();
  const candidates = new Set<MemoryCandidateKind>();
  for (const { handle } of backends) {
    handle.capabilities.sources.forEach((source) => sources.add(source));
    if (typeof handle.candidates === "function") {
      handle.capabilities.candidates.forEach((kind) => candidates.add(kind));
    }
  }
  return {
    sources: [...sources],
    // A fused cursor would have to carry one cursor per backend; fusion pages once.
    pagination: false,
    candidates: [...candidates],
    // Filtering is only guaranteed when every backend filters.
    projectFilter: backends.length > 0 && backends.every(({ handle }) => handle.capabilities.projectFilter),
  };
}

function summarizeFailures(failures: readonly BackendFailure[]): string | undefined {
  if (failures.length === 0) return undefined;
  return `Memory backends unavailable: ${failures.map((f) => `${f.backendId} (${f.error})`).join("; ")}`;
}

function joinWarnings(parts: (string | undefined)[]): string | undefined {
  const text = parts.filter((part): part is string => Boolean(part)).join(" ");
  return text || undefined;
}

/** The slot owner's handle: fans out to every open backend and merges by rank. */
export function createFusionHandle(params: {
  ownerId: string;
  backends: OpenBackend[];
  openFailures?: BackendFailure[];
  config?: MemfusionConfig;
}): MemoryProviderHandle {
  const { ownerId, backends } = params;
  const openFailures = params.openFailures ?? [];
  const config = params.config ?? {};
  const timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  const byProviderId = new Map(backends.map((backend) => [backend.providerId, backend]));
  const storeTargets = resolveStoreTargets(config.store, backends).backends;
  const capabilities: MemoryProviderCapabilities = {
    ...fuseCapabilities(backends),
    ...(storeTargets.length > 0 ? { store: true } : {}),
  };
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new Error("Memory Fusion lease is closed.");
  };

  const translateHit = (hit: MemorySearchHit): MemorySearchHit => ({
    ...hit,
    reference: toOwnerReference(ownerId, hit.reference),
    ...(hit.citations ? { citations: toOwnerCitations(ownerId, hit.citations) } : {}),
  });

  async function fanOut(
    targets: readonly OpenBackend[],
    call: (backend: OpenBackend) => Promise<MemorySearchPage>,
    maxResults: number | undefined,
    label: string,
  ): Promise<MemorySearchPage> {
    const settled = await Promise.allSettled(
      targets.map((backend) => withDeadline(call(backend), timeoutMs, `${backend.backendId} ${label}`)),
    );
    const lists: RankedList[] = [];
    const failures: BackendFailure[] = [...openFailures];
    const warnings: string[] = [];
    let partial = openFailures.length > 0;
    settled.forEach((outcome, index) => {
      const backend = targets[index]!;
      if (outcome.status === "rejected") {
        failures.push({ backendId: backend.backendId, error: describe(outcome.reason) });
        partial = true;
        return;
      }
      const page = outcome.value;
      if (page.coverage === "partial") partial = true;
      if (page.warning) warnings.push(`${backend.backendId}: ${page.warning}`);
      lists.push({
        backendId: backend.backendId,
        hits: page.hits.map(translateHit),
      });
    });
    const fused = fuseRankedLists(lists, { k: config.rrfK, weights: config.weights });
    const limited = maxResults !== undefined && maxResults > 0 ? fused.slice(0, maxResults) : fused;
    const warning = joinWarnings([summarizeFailures(failures), ...warnings]);
    return {
      hits: limited.map(({ hit }) => hit),
      coverage: partial ? "partial" : "complete",
      ...(warning ? { warning } : {}),
    };
  }

  return {
    capabilities,
    async search(request: MemorySearchRequest): Promise<MemorySearchPage> {
      assertOpen();
      const wanted = request.sources;
      const targets = backends.filter(
        ({ handle }) => !wanted || wanted.some((source) => handle.capabilities.sources.includes(source)),
      );
      // Pagination is not offered, so a cursor never reaches a backend.
      const { cursor: _cursor, ...forward } = request;
      return await fanOut(
        targets,
        ({ handle }) =>
          handle.search({
            ...forward,
            ...(wanted
              ? { sources: wanted.filter((source) => handle.capabilities.sources.includes(source)) }
              : {}),
          }),
        request.maxResults,
        "search",
      );
    },
    async get(request: MemoryGetRequest): Promise<MemoryGetResult> {
      assertOpen();
      const inner = fromOwnerReference(ownerId, request.reference);
      const backend = inner ? byProviderId.get(inner.providerId) : undefined;
      if (!inner || !backend) {
        return { status: "not_found" };
      }
      const result = await withDeadline(
        backend.handle.get({ ...request, reference: inner }),
        timeoutMs,
        `${backend.backendId} get`,
      );
      if (result.status !== "ok") return result;
      return {
        ...result,
        reference: toOwnerReference(ownerId, result.reference),
        ...(result.citations ? { citations: toOwnerCitations(ownerId, result.citations) } : {}),
      };
    },
    async health(): Promise<MemoryHealth> {
      const settled = await Promise.allSettled(
        backends.map(({ backendId, handle }) => withDeadline(handle.health(), timeoutMs, `${backendId} health`)),
      );
      const statuses: Record<string, string> = {};
      openFailures.forEach(({ backendId }) => (statuses[backendId] = "unavailable"));
      let ready = 0;
      settled.forEach((outcome, index) => {
        const status = outcome.status === "fulfilled" ? outcome.value.status : "unavailable";
        statuses[backends[index]!.backendId] = status;
        if (status === "ready") ready += 1;
      });
      const total = Object.keys(statuses).length;
      const usable = Object.values(statuses).filter((value) => value !== "unavailable").length;
      const status: MemoryHealth["status"] =
        total > 0 && ready === total ? "ready" : usable > 0 ? "degraded" : "unavailable";
      return {
        status,
        message:
          total === 0
            ? "No memory backends are loaded."
            : `${ready} of ${total} memory backends ready.`,
        details: { backends: statuses },
      };
    },
    ...(capabilities.candidates.length > 0
      ? {
          async candidates(request: MemoryCandidateRequest): Promise<MemorySearchPage> {
            assertOpen();
            const targets = backends.filter(
              ({ handle }) =>
                typeof handle.candidates === "function" && handle.capabilities.candidates.includes(request.kind),
            );
            return await fanOut(targets, ({ handle }) => handle.candidates!(request), request.limit, "candidates");
          },
        }
      : {}),
    ...(storeTargets.length > 0
      ? {
          async store(request: MemoryStoreRequest): Promise<MemoryStoreResult> {
            assertOpen();
            const settled = await Promise.allSettled(
              storeTargets.map(({ backendId, handle }) =>
                withDeadline(handle.store!(request), timeoutMs, `${backendId} store`),
              ),
            );
            const reasons: string[] = [];
            let stored: MemoryStoreResult | undefined;
            settled.forEach((outcome, index) => {
              const { backendId } = storeTargets[index]!;
              if (outcome.status === "rejected") {
                reasons.push(`${backendId}: ${describe(outcome.reason)}`);
              } else if (outcome.value.status === "rejected") {
                reasons.push(`${backendId}: ${outcome.value.reason}`);
              } else if (!stored) {
                stored = { status: "stored", reference: toOwnerReference(ownerId, outcome.value.reference) };
              }
            });
            return stored ?? { status: "rejected", reason: reasons.join("; ") || "no store targets" };
          },
        }
      : {}),
    async refresh(): Promise<void> {
      assertOpen();
      await Promise.allSettled(backends.map(({ handle }) => handle.refresh?.()));
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled(backends.map(({ handle }) => handle.close()));
    },
  };
}

/** Opens every backend the host offers and wraps them in one fused handle. */
export async function openFusion(
  ownerId: string,
  params: MemoryProviderOpenParams,
  config: MemfusionConfig = {},
  supplements: readonly OpenBackend[] = [],
): Promise<MemoryProviderOpenResult> {
  const access = params.backends;
  if (!access && supplements.length === 0) {
    return {
      provider: null,
      error:
        "Memory Fusion has no memory backends. Enable another memory plugin, and use an OpenClaw build with memory backend support.",
    };
  }
  const listed = access?.list() ?? [];
  const settled = access ? await Promise.allSettled(listed.map(({ id }) => access.open(id))) : [];
  const opened: OpenBackend[] = [...supplements];
  const failures: BackendFailure[] = [];
  settled.forEach((outcome, index) => {
    const backendId = listed[index]!.id;
    if (outcome.status === "rejected") {
      failures.push({ backendId, error: describe(outcome.reason) });
      return;
    }
    const { provider, error, providerId } = outcome.value;
    if (!provider) {
      failures.push({ backendId, error: error ?? "no provider" });
      return;
    }
    opened.push({ backendId, providerId: providerId ?? backendId, handle: provider });
  });
  if (opened.length === 0) {
    return {
      provider: null,
      error: summarizeFailures(failures) ?? "Memory Fusion has no memory backends.",
    };
  }
  return { provider: createFusionHandle({ ownerId, backends: opened, openFailures: failures, config }) };
}

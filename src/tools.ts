import type {
  ActiveMemoryProviderResult,
  MemfusionConfig,
  MemoryCallerContext,
  MemoryProviderOpenParams,
  MemoryReference,
} from "./types.js";
import { WORKSPACE_TARGET } from "./types.js";
import { appendWorkspaceMemory } from "./workspace.js";

export const OWNER_ID = "memfusion";
const MAX_RESULTS_LIMIT = 50;

/** Subset of the OpenClaw tool context this plugin reads. */
export type ToolContext = {
  config?: unknown;
  runtimeConfig?: unknown;
  getRuntimeConfig?: () => unknown;
  agentId?: string;
  workspaceDir?: string;
  sessionKey?: string;
  sessionId?: string;
  sandboxed?: boolean;
  conversationRecall?: unknown;
  memoryAudience?: unknown;
  assertInvocationCurrent?: () => void;
  assertMemoryAudienceCurrent?: () => void;
};

export type OpenProvider = (params: MemoryProviderOpenParams) => Promise<ActiveMemoryProviderResult>;

type ToolResult = { content: { type: "text"; text: string }[]; details?: unknown };

export type MemoryTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
};

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

/** Tool references are opaque to the model: base64url JSON of the owner reference. */
export function encodeToolRef(reference: MemoryReference): string {
  const { id, revision, fragment } = reference;
  return Buffer.from(JSON.stringify({ id, revision, fragment }), "utf8").toString("base64url");
}

export function decodeToolRef(ref: string): MemoryReference | null {
  try {
    const parsed = JSON.parse(Buffer.from(ref, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.id !== "string") return null;
    return {
      providerId: OWNER_ID,
      id: parsed.id,
      ...(typeof parsed.revision === "string" ? { revision: parsed.revision } : {}),
      ...(typeof parsed.fragment === "string" ? { fragment: parsed.fragment } : {}),
    };
  } catch {
    return null;
  }
}

function backendOf(reference: MemoryReference): string | undefined {
  try {
    const parsed = JSON.parse(reference.id) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : undefined;
  } catch {
    return undefined;
  }
}

function callerContext(ctx: ToolContext, signal: AbortSignal | undefined, done: () => boolean): MemoryCallerContext {
  return {
    // Tools only exist for session callers, so the host always applies session policy.
    authority: {
      kind: "session",
      sessionKey: ctx.sessionKey!,
      sandboxed: ctx.sandboxed === true,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.conversationRecall ? { conversationRecall: ctx.conversationRecall } : {}),
      ...(ctx.memoryAudience ? { audience: ctx.memoryAudience } : {}),
    },
    ...(signal ? { signal } : {}),
    assertCurrent() {
      if (done()) throw new Error("Memory Fusion tool call has completed.");
      ctx.assertInvocationCurrent?.();
      ctx.assertMemoryAudienceCurrent?.();
      signal?.throwIfAborted();
    },
  };
}

async function withProvider<T>(
  ctx: ToolContext,
  openProvider: OpenProvider,
  signal: AbortSignal | undefined,
  action: (provider: NonNullable<ActiveMemoryProviderResult["provider"]>) => Promise<T>,
): Promise<T | { error: string }> {
  let done = false;
  const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
  const context = callerContext(ctx, signal, () => done);
  const result = await openProvider({ cfg, agentId: ctx.agentId!, context });
  try {
    if (!result.provider) return { error: result.error ?? "Memory is unavailable." };
    if (result.providerId && result.providerId !== OWNER_ID) {
      return { error: `The memory slot is owned by ${result.providerId}, not Memory Fusion.` };
    }
    return await action(result.provider);
  } finally {
    done = true;
    await result.provider?.close();
  }
}

/** Whether the workspace memory files receive writes, given what the fused provider accepts. */
export function writesWorkspace(setting: MemfusionConfig["store"], providerStores: boolean): boolean {
  if (setting === "all") return true;
  if (Array.isArray(setting)) return setting.includes(WORKSPACE_TARGET);
  return !providerStores;
}

function readTimeZone(cfg: unknown): string | undefined {
  const zone = (cfg as { agents?: { defaults?: { userTimezone?: unknown } } } | undefined)?.agents?.defaults
    ?.userTimezone;
  return typeof zone === "string" && zone ? zone : undefined;
}

export function createMemoryTools(
  ctx: ToolContext,
  openProvider: OpenProvider,
  config: MemfusionConfig = {},
): MemoryTool[] | null {
  // Without a session the tool would have to borrow host authority; fail closed instead.
  if (!ctx.agentId || !ctx.sessionKey) return null;
  return [
    {
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search every connected memory store at once (Memory Fusion). Results are merged by rank; each result names its store and carries a ref for memory_get.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for." },
          maxResults: { type: "integer", minimum: 1, maximum: MAX_RESULTS_LIMIT },
          minScore: { type: "number", description: "Minimum score each store enforces on its own scale." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(_id, params, signal) {
        const query = typeof params.query === "string" ? params.query.trim() : "";
        if (!query) return jsonResult({ error: "query is required" });
        const maxResults =
          typeof params.maxResults === "number" ? Math.min(Math.max(1, Math.floor(params.maxResults)), MAX_RESULTS_LIMIT) : 10;
        const minScore = typeof params.minScore === "number" ? params.minScore : undefined;
        const value = await withProvider(ctx, openProvider, signal, async (provider) => {
          const page = await provider.search({ query, maxResults, ...(minScore !== undefined ? { minScore } : {}) });
          return {
            results: page.hits.map((hit) => ({
              ref: encodeToolRef(hit.reference),
              store: backendOf(hit.reference),
              excerpt: hit.excerpt,
              ...(hit.score !== undefined ? { score: hit.score } : {}),
              ...(hit.source ? { source: hit.source } : {}),
              ...(hit.citations?.length
                ? { citations: hit.citations.map(({ label, url, startLine, endLine }) => ({ label, url, startLine, endLine })) }
                : {}),
            })),
            coverage: page.coverage ?? "complete",
            ...(page.warning ? { warning: page.warning } : {}),
          };
        });
        return jsonResult(value);
      },
    },
    {
      name: "memory_get",
      label: "Memory Get",
      description: "Read one memory item found by memory_search, using its ref. Optional from/lines page long items.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "The ref from a memory_search result." },
          from: { type: "integer", minimum: 1 },
          lines: { type: "integer", minimum: 1 },
        },
        required: ["ref"],
        additionalProperties: false,
      },
      async execute(_id, params, signal) {
        const reference = typeof params.ref === "string" ? decodeToolRef(params.ref) : null;
        if (!reference) return jsonResult({ error: "ref is not a Memory Fusion ref; use one from memory_search." });
        const from = typeof params.from === "number" ? Math.max(1, Math.floor(params.from)) : undefined;
        const lines = typeof params.lines === "number" ? Math.max(1, Math.floor(params.lines)) : undefined;
        const value = await withProvider(ctx, openProvider, signal, async (provider) => {
          const result = await provider.get({
            reference,
            ...(from !== undefined ? { from } : {}),
            ...(lines !== undefined ? { lines } : {}),
          });
          if (result.status !== "ok") return { status: result.status };
          return {
            status: "ok",
            store: backendOf(result.reference),
            text: result.text,
            ...(result.truncated ? { truncated: true, nextFrom: result.nextFrom } : {}),
          };
        });
        return jsonResult(value);
      },
    },
    {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save a durable memory (Memory Fusion). Routed to the configured memory stores; use it for facts, decisions and preferences worth recalling later.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The memory to keep, self-contained." },
          title: { type: "string", description: "Optional short heading." },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(_id, params, signal) {
        const text = typeof params.text === "string" ? params.text.trim() : "";
        if (!text) return jsonResult({ error: "text is required" });
        const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : undefined;
        const tags = Array.isArray(params.tags) ? params.tags.filter((tag): tag is string => typeof tag === "string") : undefined;
        const value = await withProvider(ctx, openProvider, signal, async (provider) => {
          const stored: { store: string; ref?: string }[] = [];
          const errors: string[] = [];
          const providerStores = provider.capabilities.store === true && typeof provider.store === "function";
          if (providerStores) {
            const result = await provider.store!({ text, ...(title ? { title } : {}), ...(tags?.length ? { tags } : {}), origin: "tool" });
            if (result.status === "stored") {
              stored.push({ store: backendOf(result.reference) ?? "backend", ref: encodeToolRef(result.reference) });
            } else {
              errors.push(result.reason);
            }
          }
          if (writesWorkspace(config.store, providerStores)) {
            if (ctx.sandboxed) {
              errors.push("workspace memory files are not written from sandboxed sessions");
            } else if (!ctx.workspaceDir) {
              errors.push("no agent workspace is available for memory files");
            } else {
              const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
              const file = await appendWorkspaceMemory({
                workspaceDir: ctx.workspaceDir,
                text,
                ...(title ? { title } : {}),
                ...(tags?.length ? { tags } : {}),
                timeZone: readTimeZone(cfg),
              });
              stored.push({ store: WORKSPACE_TARGET, ref: file });
            }
          }
          return stored.length > 0
            ? { status: "stored", stored, ...(errors.length ? { warnings: errors } : {}) }
            : { status: "rejected", reason: errors.join("; ") || "no memory store accepts writes" };
        });
        return jsonResult(value);
      },
    },
  ];
}

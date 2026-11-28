import type { OpenBackend } from "./fusion.js";
import type { MemoryProviderOpenParams } from "./types.js";

export type WikiCorpus = {
  pluginId: string;
  supplement: {
    search(input: WikiCaller & { query: string; maxResults?: number }): Promise<{
      path: string;
      snippet: string;
      score: number;
      citation?: string;
      startLine?: number;
      endLine?: number;
    }[]>;
    get(input: WikiCaller & { lookup: string; fromLine?: number; lineCount?: number }): Promise<{
      content: string;
      fromLine: number;
      lineCount: number;
    } | null>;
  };
};

type WikiCaller = { agentId: string; agentSessionKey?: string; sandboxed: boolean };

export function wikiBackends(params: MemoryProviderOpenParams, corpora: WikiCorpus[]): OpenBackend[] {
  const { context } = params;
  const session = context.authority.kind === "session" ? context.authority : undefined;
  const caller = { agentId: params.agentId, agentSessionKey: session?.sessionKey, sandboxed: session?.sandboxed ?? false };
  return corpora.map(({ pluginId, supplement }) => {
    const providerId = pluginId;
    return {
      backendId: pluginId,
      providerId,
      handle: {
        capabilities: { sources: ["memory"], candidates: [], pagination: false, projectFilter: true },
        async search({ query, maxResults, minScore, activeProjectKeys }) {
          context.assertCurrent();
          // Wiki does not carry Memory Core project annotations.
          if (activeProjectKeys?.length) return { hits: [] };
          const results = await supplement.search({ ...caller, query, maxResults });
          context.assertCurrent();
          return {
            hits: results.filter((result) => minScore === undefined || result.score >= minScore).map((result) => {
              const reference = { providerId, id: result.path };
              return {
                reference,
                excerpt: result.snippet,
                score: result.score,
                source: "wiki",
                citations: [{
                  reference,
                  label: result.citation ?? result.path,
                  startLine: result.startLine,
                  endLine: result.endLine,
                }],
              };
            }),
          };
        },
        async get({ reference, from, lines }) {
          context.assertCurrent();
          const result = await supplement.get({ ...caller, lookup: reference.id, fromLine: from, lineCount: lines });
          context.assertCurrent();
          return result
            ? { status: "ok", reference, text: result.content, from: result.fromLine, lines: result.lineCount }
            : { status: "not_found" };
        },
        async health() { return { status: "ready" }; },
        async close() {},
      },
    };
  });
}

const loadCorpusRegistry = () => import("openclaw/plugin-sdk/memory-core-host-runtime-core");

export async function listWikiCorpora(
  loadRegistry: () => Promise<Partial<Awaited<ReturnType<typeof loadCorpusRegistry>>>> = loadCorpusRegistry,
): Promise<WikiCorpus[]> {
  // Older hosts do not expose the corpus registry on this SDK entry point.
  const sdk = await loadRegistry().catch((error: unknown) => {
    const code = (error as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED" || code === "MODULE_NOT_FOUND") {
      return undefined;
    }
    throw error;
  });
  return sdk?.listMemoryCorpusSupplements?.().filter(({ pluginId }) => pluginId === "memory-wiki") ?? [];
}

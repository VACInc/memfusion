// The host provides this subpath at runtime; declare only what the plugin uses.
declare module "openclaw/plugin-sdk/memory-host-search" {
  export function getActiveMemoryProvider(params: unknown): Promise<unknown>;
}

declare module "openclaw/plugin-sdk/memory-core-host-runtime-core" {
  export function listMemoryCorpusSupplements(): import("./wiki.js").WikiCorpus[];
}

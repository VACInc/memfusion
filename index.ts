import { openFusion } from "./src/fusion.js";
import { createMemoryTools, OWNER_ID, type OpenProvider, type ToolContext } from "./src/tools.js";
import type { MemfusionConfig, MemoryProviderOpenParams } from "./src/types.js";

export { createFusionHandle, fuseCapabilities, openFusion } from "./src/fusion.js";
export { fuseRankedLists } from "./src/rank.js";
export { fromOwnerReference, toOwnerReference } from "./src/references.js";

/** The parts of the OpenClaw plugin API this plugin uses. */
type MemfusionPluginApi = {
  pluginConfig?: unknown;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  registerMemoryCapability(capability: {
    providerRuntime: { open(params: MemoryProviderOpenParams): Promise<unknown> };
  }): void;
  registerTool(
    tool: { contextVersion: 2; create(ctx: ToolContext): unknown },
    options: { name: string },
  ): void;
};

const loadOpenProvider = async (): Promise<OpenProvider> => {
  const sdk = (await import("openclaw/plugin-sdk/memory-host-search")) as unknown as {
    getActiveMemoryProvider: OpenProvider;
  };
  return sdk.getActiveMemoryProvider;
};

export function registerMemfusion(api: MemfusionPluginApi, openProvider: () => Promise<OpenProvider> = loadOpenProvider) {
  const config = (api.pluginConfig ?? {}) as MemfusionConfig;
  api.registerMemoryCapability({
    providerRuntime: {
      open: (params) => openFusion(OWNER_ID, params, config),
    },
  });
  const opener: OpenProvider = async (params) => (await openProvider())(params);
  for (const [index, name] of ["memory_search", "memory_get"].entries()) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (ctx) => createMemoryTools(ctx, opener)?.[index] ?? null,
      },
      { name },
    );
  }
}

const plugin = {
  id: OWNER_ID,
  name: "Memory Fusion",
  description: "Searches every connected OpenClaw memory plugin at once and merges the results.",
  kind: "memory" as const,
  register(api: MemfusionPluginApi) {
    registerMemfusion(api);
  },
};

export default plugin;

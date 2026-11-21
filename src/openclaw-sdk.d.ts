// The host provides this subpath at runtime; declare only what the plugin uses.
declare module "openclaw/plugin-sdk/memory-host-search" {
  export function getActiveMemoryProvider(params: unknown): Promise<unknown>;
}

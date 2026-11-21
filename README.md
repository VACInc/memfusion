# Memory Fusion

<img src="assets/icon.png" alt="Memory Fusion icon" width="96" align="right">

Memory Fusion is an OpenClaw memory plugin that searches **every enabled memory plugin at once** and merges the results. It is the memory version of [Search Fusion](https://github.com/VACInc/openclaw-search-fusion): select it once and every other memory store joins automatically.

- Owns the memory slot (`plugins.slots.memory`) and asks OpenClaw for every other enabled memory plugin as a passive **backend**.
- Searches all backends in parallel and merges them with reciprocal rank fusion, so stores with different score scales mix fairly.
- Merges identical results from several stores into one.
- Keeps working when a store fails or is slow: the other stores still answer, and the result says which one was missing.
- Gives agents `memory_search` and `memory_get`; every result names the store it came from.
- Host features that use the memory provider (Active Memory recall, `memory.search`, status and doctor checks) see the fused view.

## Requirements

- OpenClaw **2026.11.7 or newer**, the first line with memory backend support ([openclaw/openclaw#201340](https://github.com/openclaw/openclaw/pull/201340)). Older hosts skip the plugin at discovery.
- At least one other memory plugin that serves the provider-neutral `providerRuntime` (bundled `memory-core` does). Plugins that only register legacy tools and hooks cannot be backends yet.

## Install

```bash
openclaw plugins install clawhub:@vacinc/memfusion
openclaw config set plugins.slots.memory memfusion
openclaw gateway restart
```

That is the whole setup. Because the plugin's manifest declares `memoryBackends: true`, every other enabled memory plugin loads as a backend while Memory Fusion owns the slot.

To keep one plugin out:

```json5
{
  plugins: {
    slots: { memory: "memfusion" },
    entries: {
      "memory-lancedb": { memoryBackend: false },
    },
  },
}
```

## What changes when a plugin becomes a backend

A backend registers only its search provider. OpenClaw ignores its tools, hooks, services, prompt sections and recall settings, so for example `memory-core` stops registering its own `memory_search` tool (Memory Fusion provides one instead), and its dreaming and auto-capture behavior does not run while it is a backend. Switch `plugins.slots.memory` back to restore the original owner.

Backend code still runs inside the Gateway like any enabled plugin. Only enable memory plugins you trust.

## Configuration

All optional, under `plugins.entries.memfusion.config`:

| Key | Default | Meaning |
| --- | --- | --- |
| `rrfK` | `60` | Reciprocal rank fusion constant. Larger values flatten the gap between ranks. |
| `weights` | `{}` | Rank weight per backend plugin id, default `1`. `0` drops a backend from results. |
| `timeoutMs` | `15000` | Deadline per backend for search, get and candidate calls. A slow backend is reported and skipped. |

## How results are merged

Each backend returns its own ranked list. Memory Fusion scores every hit as `weight / (rrfK + rank)` and sorts by the total. Raw scores are never compared across stores because each store uses its own scale; each hit keeps its original `score`, and `minScore` is passed to every store to enforce on its own scale. Hits whose text is the same (ignoring case and whitespace) are merged, keeping the best-ranked copy.

References handed to OpenClaw belong to `memfusion` and wrap the original store's reference, so `memory_get` and host lookups route back to the right store.

Search pages are not paginated: fusion returns one merged page of up to `maxResults` hits.

## Development

```bash
pnpm install
pnpm test     # node:test suite
pnpm check    # tsc --noEmit
pnpm build    # dist/
```

## Releasing

1. Bump `version` in `package.json` and `openclaw.plugin.json` (a test keeps them equal) and merge to `main`.
2. Tag it: `git tag v<version> && git push origin v<version>`.
3. Publish from the tag: `clawhub package publish VACInc/memfusion@v<version> --family code-plugin --wait`.

## License

MIT

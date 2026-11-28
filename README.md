# Memory Fusion

<img src="assets/icon.png" alt="Memory Fusion icon" width="96" align="right">

Memory Fusion is an OpenClaw memory plugin that searches **every enabled memory plugin at once** and merges the results. It is the memory version of [Search Fusion](https://github.com/VACInc/openclaw-search-fusion): select it once and every other memory store joins automatically.

- Owns the memory slot (`plugins.slots.memory`) and asks OpenClaw for every other enabled memory plugin as a passive **backend**.
- Includes the local Memory Wiki corpus in search and get when the host exposes its corpus registry and `memory-wiki` is enabled.
- Searches all backends in parallel and merges them with reciprocal rank fusion, so stores with different score scales mix fairly.
- Merges identical results from several stores into one.
- Keeps working when a store fails or is slow: the other stores still answer, and the result says which one was missing.
- Gives agents `memory_search`, `memory_get` and `memory_store`; every result names the store it came from.
- Saves new memories where you choose: every store that accepts writes, a list of stores, or the workspace memory files that `memory-core` indexes.
- Runs the pre-compaction memory flush itself, so long sessions still save what matters, routed by the same `store` setting.
- Host features that use the memory provider (Active Memory recall, `memory.search`, status and doctor checks) see the fused view.

## Requirements

- OpenClaw **2026.11.7 or newer**, the first line with memory backend support ([openclaw/openclaw#201340](https://github.com/openclaw/openclaw/pull/201340)). Older hosts skip the plugin at discovery.
- Saving to backends and using `memory-core` / `memory-lancedb` as backends need [openclaw/openclaw#202838](https://github.com/openclaw/openclaw/pull/202838) as well. Without it, only plugins with the provider-neutral `providerRuntime` (for example the bundled knowledge plugin) can be backends, and saves go to the workspace memory files.
- At least one other enabled memory plugin.

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

A passive backend registers its provider. The host suppresses the backend's tools, hooks, services, prompt sections, and recall settings. Fusion supplies the memory prompt section, recall tools, and pre-compaction flush.

OpenClaw builds with the Memory Core consolidation sidecar give enabled Dreaming precedence over the Memory Core backend. Set `plugins.entries.memory-core.config.dreaming.enabled: false` to include Memory Core search in Fusion on those builds. With Dreaming enabled, the sidecar keeps consolidation and its maintenance commands. `openclaw memory status` reports the Fusion provider. The Memory Core `openclaw memory search` command refuses when Fusion owns the slot. Use the agent's `memory_search` tool or the provider-neutral Gateway memory RPC.

LanceDB Pro can participate through the host's legacy search and read adapter. That adapter does not expose writes or automatic-recall candidate enumeration. A native backend needs to declare each of those capabilities.

Wiki hits identify `memory-wiki` as their store. They carry read references through the same fusion path as the other stores. Project-filtered searches omit Wiki hits.

Backend code still runs inside the Gateway like any enabled plugin. Only enable memory plugins you trust.

## Configuration

All optional, under `plugins.entries.memfusion.config`:

| Key | Default | Meaning |
| --- | --- | --- |
| `rrfK` | `60` | Reciprocal rank fusion constant. Larger values flatten the gap between ranks. |
| `weights` | `{}` | Rank weight per backend plugin id, default `1`. `0` drops a backend from results. |
| `timeoutMs` | `15000` | Deadline per backend for search, get, store and candidate calls. A slow backend is reported and skipped. |
| `store` | `"auto"` | Where new memories go. `"auto"`: every backend that accepts writes, or the workspace memory files when none does. `"all"`: every writable backend plus the workspace files. Or a list of backend plugin ids and/or `"workspace"`. |

## Saving memories

`memory_store` and the pre-compaction flush both write through the `store` setting:

- **Backends that accept writes** (they declare `store` in the provider contract) receive the entry with the caller's own permissions.
- **`"workspace"`** appends to `memory/YYYY-MM-DD.md` in the agent workspace, the same daily file `memory-core` writes and indexes, so it shows up in `memory-core` search after the workspace watcher indexes it. Entries are only ever appended. Sandboxed sessions never write workspace files; they report a warning instead.

Examples:

```json5
// Save to the daily memory files only (memory-core style)
{ plugins: { entries: { memfusion: { config: { store: ["workspace"] } } } } }

// Save to one vector store and the daily files
{ plugins: { entries: { memfusion: { config: { store: ["my-vector-store", "workspace"] } } } } }
```

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
pnpm mutation # Stryker mutation testing; CI fails below 90%
```

The test suite is mutation-tested with [Stryker](https://stryker-mutator.io): every source file is mutated and the suite must catch at least 90% of the mutants (currently about 95%). The survivors left are equivalent mutants such as defensive re-checks and labels.

### Gateway integration test

Build the plugin, then run the test with an existing built OpenClaw distribution. The test starts its own loopback Gateway in a private network namespace with temporary configuration and state. The optional last argument is an absolute path to a LanceDB Pro plugin checkout with its dependencies installed. The test seeds a scratch LanceDB table and replaces embeddings with a loopback fixture.

```bash
pnpm build
unshare --user --map-root-user --mount --net sh -c '
  mount --bind "$1" /etc/hosts
  ip link set lo up
  exec env -i PATH=/usr/bin:/bin node test/gateway/e2e.mjs "$2" "$3"
' sh /path/to/loopback-only-hosts /path/to/openclaw/dist/index.js /optional/path/to/lancedb-pro
```

The fixture hosts file should map `localhost` to loopback. Use a built OpenClaw version that supports the Memory Core consolidation sidecar for the CLI checks.

## Releasing

1. Bump `version` in `package.json` and `openclaw.plugin.json` (a test keeps them equal) and merge to `main`.
2. Tag it: `git tag v<version> && git push origin v<version>`.
3. Publish from the tag: `clawhub package publish VACInc/memfusion@v<version> --family code-plugin --wait`.

## License

MIT

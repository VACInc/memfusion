import assert from "node:assert/strict";
import { test } from "node:test";
import plugin, { registerMemfusion } from "../index.js";
import { createFusionHandle } from "../src/fusion.js";
import { createMemoryTools, decodeToolRef, encodeToolRef, type OpenProvider } from "../src/tools.js";
import type { MemoryProviderOpenParams } from "../src/types.js";
import { fakeBackend, hit } from "./helpers.js";

function fusedOpener(seen: MemoryProviderOpenParams[] = []): OpenProvider {
  return async (params) => {
    seen.push(params);
    const core = fakeBackend("memory-core", [hit("memory-core", "1", "core fact", 0.9)], { texts: { "1": "full text" } });
    return {
      providerId: "memfusion",
      provider: createFusionHandle({
        ownerId: "memfusion",
        backends: [{ backendId: "memory-core", providerId: "memory-core", handle: core }],
      }),
    };
  };
}

const parse = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text);

test("tool refs round-trip and reject garbage", () => {
  const reference = { providerId: "memfusion", id: '["memory-core","1"]', fragment: "L2" };
  assert.deepEqual(decodeToolRef(encodeToolRef(reference)), reference);
  assert.equal(decodeToolRef("!!!"), null);
});

test("memory_search uses session authority and memory_get reads the hit", async () => {
  const seen: MemoryProviderOpenParams[] = [];
  const tools = createMemoryTools(
    { agentId: "main", sessionKey: "agent:main:chat", sessionId: "s1", sandboxed: true, config: { a: 1 } },
    fusedOpener(seen),
  )!;
  const search = parse(await tools[0]!.execute("1", { query: "fact" }));
  assert.equal(search.results[0].store, "memory-core");
  assert.equal(search.results[0].excerpt, "core fact");
  assert.deepEqual(seen[0]!.context.authority, {
    kind: "session",
    sessionKey: "agent:main:chat",
    sandboxed: true,
    sessionId: "s1",
  });
  assert.equal(seen[0]!.agentId, "main");
  const got = parse(await tools[1]!.execute("2", { ref: search.results[0].ref }));
  assert.deepEqual(got, { status: "ok", store: "memory-core", text: "full text" });
});

test("caller context goes stale once the tool call finishes", async () => {
  const seen: MemoryProviderOpenParams[] = [];
  const tools = createMemoryTools({ agentId: "main", sessionKey: "agent:main:chat" }, fusedOpener(seen))!;
  await tools[0]!.execute("1", { query: "fact" });
  assert.throws(() => seen[0]!.context.assertCurrent(), /completed/);
});

test("tools refuse to run when another plugin owns the memory slot", async () => {
  const tools = createMemoryTools({ agentId: "main", sessionKey: "agent:main:chat" }, async () => ({
    providerId: "memory-core",
    provider: fakeBackend("memory-core", []),
  }))!;
  const out = parse(await tools[0]!.execute("1", { query: "x" }));
  assert.match(out.error, /owned by memory-core/);
});

test("no tools without an agent or a session, so host authority is never borrowed", () => {
  assert.equal(createMemoryTools({}, fusedOpener()), null);
  assert.equal(createMemoryTools({ agentId: "main" }, fusedOpener()), null);
});

test("register wires the provider runtime, recall, flush and all three tools", async () => {
  const registered: { capability?: unknown; tools: string[] } = { tools: [] };
  registerMemfusion(
    {
      pluginConfig: { rrfK: 10 },
      registerMemoryCapability(capability) {
        registered.capability = capability;
      },
      registerTool(_tool, { name }) {
        registered.tools.push(name);
      },
    },
    async () => fusedOpener(),
  );
  assert.deepEqual(registered.tools, ["memory_search", "memory_get", "memory_store"]);
  const capability = registered.capability as {
    recallToolNames: string[];
    deterministicRecallToolName: string;
    providerFlushPlanResolver: () => { persistenceToolNames: string[]; lookupToolNames: string[] };
    promptBuilder: (p: { availableTools: Set<string> }) => string[];
  };
  assert.deepEqual(capability.recallToolNames, ["memory_search", "memory_get"]);
  assert.equal(capability.deterministicRecallToolName, "memory_search");
  assert.deepEqual(capability.providerFlushPlanResolver().persistenceToolNames, ["memory_store"]);
  assert.deepEqual(capability.promptBuilder({ availableTools: new Set() }), []);
  assert.match(capability.promptBuilder({ availableTools: new Set(["memory_store"]) }).join("\n"), /memory_store/);
  const runtime = (registered.capability as { providerRuntime: { open: (p: unknown) => Promise<{ provider: unknown }> } }).providerRuntime;
  const result = await runtime.open({ cfg: {}, agentId: "main", context: { authority: { kind: "host", operation: "t" }, assertCurrent() {} } });
  assert.equal(result.provider, null, "no backends offered");
  assert.equal(plugin.id, "memfusion");
  assert.equal(plugin.kind, "memory");
});

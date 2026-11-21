import assert from "node:assert/strict";
import { test } from "node:test";
import { createFusionHandle, openFusion } from "../src/fusion.js";
import type { ActiveMemoryProviderResult, MemoryProviderOpenParams } from "../src/types.js";
import { fakeBackend, hit } from "./helpers.js";

const context = { authority: { kind: "host" as const, operation: "test" }, assertCurrent() {} };

function openParams(results: Record<string, ActiveMemoryProviderResult | Error>): MemoryProviderOpenParams {
  return {
    cfg: {},
    agentId: "main",
    context,
    backends: {
      list: () => Object.keys(results).map((id) => ({ id })),
      async open(id) {
        const result = results[id]!;
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

test("explains a missing backend capability instead of failing", async () => {
  const result = await openFusion("memfusion", { cfg: {}, agentId: "main", context });
  assert.equal(result.provider, null);
  assert.match(result.error!, /no memory backends/i);
});

test("searches every backend and returns owner references", async () => {
  const core = fakeBackend("memory-core", [hit("memory-core", "1", "core fact")]);
  const lance = fakeBackend("lancedb", [hit("lancedb", "a", "lance fact")]);
  const { provider } = await openFusion(
    "memfusion",
    openParams({
      "memory-core": { provider: core, providerId: "memory-core" },
      lancedb: { provider: lance, providerId: "lancedb" },
    }),
  );
  const page = await provider!.search({ query: "fact", maxResults: 5, cursor: "ignored" });
  assert.deepEqual(page.hits.map((h) => h.excerpt).sort(), ["core fact", "lance fact"]);
  assert.ok(page.hits.every((h) => h.reference.providerId === "memfusion"));
  assert.equal(page.coverage, "complete");
  assert.equal(core.calls.search[0]!.cursor, undefined, "cursor never reaches a backend");
  assert.equal(core.calls.search[0]!.maxResults, 5);
});

test("routes get to the backend that owns the reference", async () => {
  const core = fakeBackend("memory-core", [hit("memory-core", "1", "core fact")], { texts: { "1": "full text" } });
  const lance = fakeBackend("lancedb", [], { texts: { "1": "wrong store" } });
  const provider = createFusionHandle({
    ownerId: "memfusion",
    backends: [
      { backendId: "memory-core", providerId: "memory-core", handle: core },
      { backendId: "lancedb", providerId: "lancedb", handle: lance },
    ],
  });
  const [found] = (await provider.search({ query: "fact" })).hits;
  const got = await provider.get({ reference: found!.reference });
  assert.equal(got.status, "ok");
  assert.equal(got.status === "ok" && got.text, "full text");
  assert.equal(got.status === "ok" && got.reference.providerId, "memfusion");
  assert.deepEqual(await provider.get({ reference: { providerId: "lancedb", id: "1" } }), { status: "not_found" });
});

test("one failing backend degrades coverage but keeps the others", async () => {
  const core = fakeBackend("memory-core", [hit("memory-core", "1", "core fact")]);
  const broken = fakeBackend("broken", [], {
    search: async () => {
      throw new Error("index offline");
    },
  });
  const provider = createFusionHandle({
    ownerId: "memfusion",
    backends: [
      { backendId: "memory-core", providerId: "memory-core", handle: core },
      { backendId: "broken", providerId: "broken", handle: broken },
    ],
  });
  const page = await provider.search({ query: "fact" });
  assert.equal(page.hits.length, 1);
  assert.equal(page.coverage, "partial");
  assert.match(page.warning!, /broken \(index offline\)/);
});

test("a slow backend times out into partial coverage", async () => {
  const fast = fakeBackend("fast", [hit("fast", "1", "quick")]);
  const slow = fakeBackend("slow", [], { search: () => new Promise(() => {}) });
  const provider = createFusionHandle({
    ownerId: "memfusion",
    backends: [
      { backendId: "fast", providerId: "fast", handle: fast },
      { backendId: "slow", providerId: "slow", handle: slow },
    ],
    config: { timeoutMs: 20 },
  });
  const page = await provider.search({ query: "q" });
  assert.deepEqual(page.hits.map((h) => h.excerpt), ["quick"]);
  assert.match(page.warning!, /slow search timed out/);
});

test("backends that failed to open are reported, and none open means no provider", async () => {
  const core = fakeBackend("memory-core", [hit("memory-core", "1", "core fact")]);
  const { provider } = await openFusion(
    "memfusion",
    openParams({
      "memory-core": { provider: core, providerId: "memory-core" },
      denied: { provider: null, error: "caller denied" },
      crashed: new Error("boom"),
    }),
  );
  const page = await provider!.search({ query: "fact" });
  assert.equal(page.coverage, "partial");
  assert.match(page.warning!, /denied \(caller denied\)/);
  assert.match(page.warning!, /crashed \(boom\)/);
  const health = await provider!.health();
  assert.equal(health.status, "degraded");
  assert.deepEqual(health.details, { backends: { denied: "unavailable", crashed: "unavailable", "memory-core": "ready" } });

  const none = await openFusion("memfusion", openParams({ denied: { provider: null, error: "caller denied" } }));
  assert.equal(none.provider, null);
  assert.match(none.error!, /denied \(caller denied\)/);
});

test("capabilities claim only what fusion can honor", () => {
  const withCandidates = fakeBackend("a", [], {
    capabilities: { sources: ["memory"], candidates: ["trigger"], projectFilter: true, pagination: true },
  });
  withCandidates.candidates = async () => ({ hits: [] });
  const sessions = fakeBackend("b", [], { capabilities: { sources: ["sessions"] } });
  const provider = createFusionHandle({
    ownerId: "memfusion",
    backends: [
      { backendId: "a", providerId: "a", handle: withCandidates },
      { backendId: "b", providerId: "b", handle: sessions },
    ],
  });
  assert.deepEqual(provider.capabilities, {
    sources: ["memory", "sessions"],
    pagination: false,
    candidates: ["trigger"],
    projectFilter: false,
  });
  assert.equal(typeof provider.candidates, "function");
});

test("source filters reach only backends that hold that corpus", async () => {
  const memory = fakeBackend("m", [hit("m", "1", "memory hit")]);
  const sessions = fakeBackend("s", [hit("s", "1", "session hit")], { capabilities: { sources: ["memory", "sessions"] } });
  const provider = createFusionHandle({
    ownerId: "memfusion",
    backends: [
      { backendId: "m", providerId: "m", handle: memory },
      { backendId: "s", providerId: "s", handle: sessions },
    ],
  });
  await provider.search({ query: "q", sources: ["sessions"] });
  assert.equal(memory.calls.search.length, 0);
  assert.deepEqual(sessions.calls.search[0]!.sources, ["sessions"]);
});

test("close releases every backend once and blocks later calls", async () => {
  const a = fakeBackend("a", []);
  const b = fakeBackend("b", []);
  const provider = createFusionHandle({
    ownerId: "memfusion",
    backends: [
      { backendId: "a", providerId: "a", handle: a },
      { backendId: "b", providerId: "b", handle: b },
    ],
  });
  await provider.close();
  await provider.close();
  assert.equal(a.calls.closed, 1);
  assert.equal(b.calls.closed, 1);
  await assert.rejects(provider.search({ query: "q" }), /closed/);
});

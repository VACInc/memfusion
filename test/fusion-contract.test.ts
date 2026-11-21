import assert from "node:assert/strict";
import { test } from "node:test";
import { createFusionHandle, fuseCapabilities, openFusion, resolveStoreTargets, type OpenBackend } from "../src/fusion.js";
import type { MemoryProviderHandle, MemorySearchHit } from "../src/types.js";
import { fakeBackend, hit } from "./helpers.js";

const as = (id: string, handle: MemoryProviderHandle): OpenBackend => ({ backendId: id, providerId: id, handle });
const owner = (backends: OpenBackend[], extra: Partial<Parameters<typeof createFusionHandle>[0]> = {}) =>
  createFusionHandle({ ownerId: "memfusion", backends, ...extra });

test("a long deadline is cleared once a call settles (no hanging timer)", async () => {
  const provider = owner([as("a", fakeBackend("a", [hit("a", "1", "x")]))], { config: { timeoutMs: 120_000 } });
  await provider.search({ query: "q" });
  await provider.health();
});

test("zero and negative timeouts fall back to the default instead of failing instantly", async () => {
  for (const timeoutMs of [0, -1]) {
    const slowish = fakeBackend("a", [], {
      search: () => new Promise((resolve) => setTimeout(() => resolve({ hits: [hit("a", "1", "late")] }), 30)),
    });
    const page = await owner([as("a", slowish)], { config: { timeoutMs } }).search({ query: "q" });
    assert.deepEqual(page.hits.map((h) => h.excerpt), ["late"], `timeoutMs=${timeoutMs}`);
  }
});

test("capability fusion: candidates only from backends that implement them, project filter needs all", () => {
  const claimsOnly = fakeBackend("a", [], { capabilities: { candidates: ["project"], projectFilter: true } });
  const real = fakeBackend("b", [], { capabilities: { candidates: ["trigger"], projectFilter: true } });
  real.candidates = async () => ({ hits: [] });
  assert.deepEqual(fuseCapabilities([as("a", claimsOnly), as("b", real)]), {
    sources: ["memory"],
    pagination: false,
    candidates: ["trigger"],
    projectFilter: true,
  });
  const noFilter = fakeBackend("c", []);
  assert.equal(fuseCapabilities([as("b", real), as("c", noFilter)]).projectFilter, false);
  assert.equal(fuseCapabilities([]).projectFilter, false);
});

test("writable means both the capability and the method", () => {
  const flagOnly = fakeBackend("a", [], { capabilities: { store: true } });
  const methodOnly = fakeBackend("b", []);
  methodOnly.store = async () => ({ status: "rejected", reason: "x" });
  assert.deepEqual(resolveStoreTargets("auto", [as("a", flagOnly), as("b", methodOnly)]), { backends: [], workspace: true });
});

test("a clean search has complete coverage and no warning key", async () => {
  const page = await owner([as("a", fakeBackend("a", [hit("a", "1", "x")]))]).search({ query: "q" });
  assert.deepStrictEqual(page, {
    hits: [{ reference: { providerId: "memfusion", id: '["a","1"]' }, excerpt: "x" }],
    coverage: "complete",
  });
});

test("backend coverage and warnings propagate with the backend name", async () => {
  const partial = fakeBackend("a", [], {
    search: async () => ({ hits: [hit("a", "1", "x")], coverage: "partial", warning: "index stale" }),
  });
  const page = await owner([as("a", partial)]).search({ query: "q" });
  assert.equal(page.coverage, "partial");
  assert.equal(page.warning, "a: index stale");
});

test("weights and rrfK from config reach the merge", async () => {
  const a = fakeBackend("a", [hit("a", "1", "from a")]);
  const b = fakeBackend("b", [hit("b", "1", "from b")]);
  const page = await owner([as("a", a), as("b", b)], { config: { weights: { a: 0 } } }).search({ query: "q" });
  assert.deepEqual(page.hits.map((h) => h.excerpt), ["from b"]);
});

test("maxResults trims the merged list; zero or absent keeps all", async () => {
  const many = fakeBackend("a", [hit("a", "1", "one"), hit("a", "2", "two"), hit("a", "3", "three")]);
  const provider = owner([as("a", many)]);
  assert.equal((await provider.search({ query: "q", maxResults: 2 })).hits.length, 2);
  assert.equal((await provider.search({ query: "q", maxResults: 0 })).hits.length, 3);
  assert.equal((await provider.search({ query: "q" })).hits.length, 3);
});

test("source filters keep a backend that holds any requested corpus and narrow its request", async () => {
  const memoryOnly = fakeBackend("m", [hit("m", "1", "mem")]);
  const page = await owner([as("m", memoryOnly)]).search({ query: "q", sources: ["memory", "sessions"] });
  assert.equal(page.hits.length, 1);
  assert.deepEqual(memoryOnly.calls.search[0]!.sources, ["memory"]);
});

test("citations are rewritten in search hits and get results", async () => {
  const cited: MemorySearchHit = {
    reference: { providerId: "a", id: "1" },
    excerpt: "x",
    citations: [{ label: "c", reference: { providerId: "a", id: "1" } }],
  };
  const a = fakeBackend("a", [cited]);
  a.get = async ({ reference }) => ({ status: "ok", reference, text: "t", citations: [{ label: "c", reference }] });
  const provider = owner([as("a", a)]);
  const [found] = (await provider.search({ query: "q" })).hits;
  assert.equal(found!.citations![0]!.reference!.providerId, "memfusion");
  const got = await provider.get({ reference: found!.reference });
  assert.equal(got.status === "ok" && got.citations![0]!.reference!.providerId, "memfusion");
});

test("get: a wrapped reference for an unknown backend and a backend miss both return not_found", async () => {
  const a = fakeBackend("a", []);
  const provider = owner([as("a", a)]);
  assert.deepEqual(await provider.get({ reference: { providerId: "memfusion", id: '["gone","1"]' } }), {
    status: "not_found",
  });
  assert.deepEqual(await provider.get({ reference: { providerId: "memfusion", id: '["a","missing"]' } }), {
    status: "not_found",
  });
});

test("health counts ready, degraded and unavailable backends", async () => {
  const ready = fakeBackend("r", []);
  const degraded = fakeBackend("d", [], { health: "degraded" });
  const down = fakeBackend("u", [], { health: "unavailable" });
  const broken = fakeBackend("x", []);
  broken.health = async () => {
    throw new Error("boom");
  };
  assert.deepEqual(await owner([as("r", ready)]).health(), {
    status: "ready",
    message: "1 of 1 memory backends ready.",
    details: { backends: { r: "ready" } },
  });
  assert.deepEqual(await owner([as("r", ready), as("d", degraded)]).health(), {
    status: "degraded",
    message: "1 of 2 memory backends ready.",
    details: { backends: { r: "ready", d: "degraded" } },
  });
  assert.deepEqual(await owner([as("d", degraded)]).health(), {
    status: "degraded",
    message: "0 of 1 memory backends ready.",
    details: { backends: { d: "degraded" } },
  });
  assert.deepEqual(await owner([as("u", down), as("x", broken)]).health(), {
    status: "unavailable",
    message: "0 of 2 memory backends ready.",
    details: { backends: { u: "unavailable", x: "unavailable" } },
  });
  assert.deepEqual(await owner([]).health(), {
    status: "unavailable",
    message: "No memory backends are loaded.",
    details: { backends: {} },
  });
});

test("candidates fan out only to backends that serve that kind, and stop after close", async () => {
  const trigger = fakeBackend("t", [], { capabilities: { candidates: ["trigger"] } });
  trigger.candidates = async () => ({ hits: [hit("t", "1", "trigger hit")] });
  const project = fakeBackend("p", [], { capabilities: { candidates: ["project"] } });
  let projectCalls = 0;
  project.candidates = async () => {
    projectCalls += 1;
    return { hits: [hit("p", "1", "project hit")] };
  };
  const provider = owner([as("t", trigger), as("p", project), as("plain", fakeBackend("plain", []))]);
  const page = await provider.candidates!({ kind: "trigger", limit: 5 });
  assert.deepEqual(page.hits.map((h) => h.excerpt), ["trigger hit"]);
  assert.equal(page.hits[0]!.reference.providerId, "memfusion");
  assert.equal(projectCalls, 0);
  assert.equal((await provider.candidates!({ kind: "trigger", limit: 0 })).hits.length, 1);
  await provider.close();
  await assert.rejects(provider.candidates!({ kind: "trigger" }), /closed/);
  assert.equal(owner([as("plain", fakeBackend("plain", []))]).candidates, undefined);
});

test("refresh reaches every backend that has one and stops after close", async () => {
  let refreshed = 0;
  const a = fakeBackend("a", []);
  a.refresh = async () => {
    refreshed += 1;
  };
  const provider = owner([as("a", a), as("b", fakeBackend("b", []))]);
  await provider.refresh!();
  assert.equal(refreshed, 1);
  await provider.close();
  await assert.rejects(provider.refresh!(), /closed/);
  await assert.rejects(provider.get({ reference: { providerId: "memfusion", id: '["a","1"]' } }), /closed/);
});

test("store keeps the first success even after a rejection and collects every failure", async () => {
  const no = fakeBackend("no", [], { capabilities: { store: true } });
  no.store = async () => ({ status: "rejected", reason: "full" });
  const yes = fakeBackend("yes", [], { capabilities: { store: true } });
  yes.store = async () => ({ status: "stored", reference: { providerId: "yes", id: "1" } });
  const yes2 = fakeBackend("yes2", [], { capabilities: { store: true } });
  yes2.store = async () => ({ status: "stored", reference: { providerId: "yes2", id: "9" } });
  const result = await owner([as("no", no), as("yes", yes), as("yes2", yes2)]).store!({ text: "t" });
  assert.deepEqual(result, { status: "stored", reference: { providerId: "memfusion", id: '["yes","1"]' } });
  const boom = fakeBackend("boom", [], { capabilities: { store: true } });
  boom.store = async () => {
    throw new Error("disk");
  };
  assert.deepEqual(await owner([as("no", no), as("boom", boom)]).store!({ text: "t" }), {
    status: "rejected",
    reason: "no: full; boom: disk",
  });
  const closed = owner([as("yes", yes)]);
  await closed.close();
  await assert.rejects(closed.store!({ text: "t" }), /closed/);
});

test("openFusion falls back to the backend id when the host omits providerId", async () => {
  const a = fakeBackend("a", [hit("a", "1", "x")]);
  const { provider } = await openFusion("memfusion", {
    cfg: {},
    agentId: "main",
    context: { authority: { kind: "host", operation: "t" }, assertCurrent() {} },
    backends: { list: () => [{ id: "a" }], open: async () => ({ provider: a }) },
  });
  const [found] = (await provider!.search({ query: "q" })).hits;
  assert.equal(found!.reference.id, '["a","1"]');
});

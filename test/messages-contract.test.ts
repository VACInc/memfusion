import assert from "node:assert/strict";
import { test } from "node:test";
import { createFusionHandle, openFusion, type OpenBackend } from "../src/fusion.js";
import { createMemoryTools, encodeToolRef, type OpenProvider } from "../src/tools.js";
import { fakeBackend, hit } from "./helpers.js";

const as = (id: string, handle: ReturnType<typeof fakeBackend>): OpenBackend => ({ backendId: id, providerId: id, handle });
const never = () => new Promise<never>(() => {});
const context = { authority: { kind: "host" as const, operation: "t" }, assertCurrent() {} };

test("warnings join failures and backend notes with exact wording", async () => {
  const noisy = fakeBackend("noisy", [], { search: async () => ({ hits: [], warning: "stale" }) });
  const broken = fakeBackend("broken", [], {
    search: async () => {
      throw new Error("down");
    },
  });
  const page = await createFusionHandle({
    ownerId: "memfusion",
    backends: [as("noisy", noisy), as("broken", broken)],
    openFailures: [{ backendId: "gone", error: "denied" }],
  }).search({ query: "q" });
  assert.equal(page.warning, "Memory backends unavailable: gone (denied); broken (down) noisy: stale");
});

test("deadlines name the backend and the call", async () => {
  const slow = fakeBackend("slow", [], { capabilities: { store: true, candidates: ["trigger"] } });
  slow.get = never;
  slow.health = never;
  slow.store = never;
  slow.candidates = never;
  const provider = createFusionHandle({ ownerId: "memfusion", backends: [as("slow", slow)], config: { timeoutMs: 15 } });
  await assert.rejects(provider.get({ reference: { providerId: "memfusion", id: '["slow","1"]' } }), /^Error: slow get timed out after 15 ms$/);
  assert.deepEqual((await provider.health()).details, { backends: { slow: "unavailable" } });
  assert.deepEqual(await provider.store!({ text: "x" }), { status: "rejected", reason: "slow: slow store timed out after 15 ms" });
  assert.equal((await provider.candidates!({ kind: "trigger" })).warning, "Memory backends unavailable: slow (slow candidates timed out after 15 ms)");
});

test("open failures without a host error and empty backend lists have exact messages", async () => {
  const none = await openFusion("memfusion", { cfg: {}, agentId: "m", context, backends: { list: () => [], open: async () => ({ provider: null }) } });
  assert.deepEqual(none, { provider: null, error: "Memory Fusion has no memory backends." });
  const silent = await openFusion("memfusion", { cfg: {}, agentId: "m", context, backends: { list: () => [{ id: "x" }], open: async () => ({ provider: null }) } });
  assert.deepEqual(silent, { provider: null, error: "Memory backends unavailable: x (no provider)" });
  const withId = await openFusion("memfusion", {
    cfg: {},
    agentId: "m",
    context,
    backends: { list: () => [{ id: "plugin-id" }], open: async () => ({ provider: fakeBackend("p", [hit("provider-id", "1", "x")]), providerId: "provider-id" }) },
  });
  const [found] = (await withId.provider!.search({ query: "q" })).hits;
  assert.equal(found!.reference.id, '["provider-id","1"]', "the host provider id wins over the plugin id");
});

test("tool descriptions and output format are exact", () => {
  const tools = createMemoryTools({ agentId: "m", sessionKey: "s" }, async () => ({ provider: null }))!;
  assert.deepEqual(
    tools.map((t) => t.description),
    [
      "Search every connected memory store at once (Memory Fusion). Results are merged by rank; each result names its store and carries a ref for memory_get.",
      "Read one memory item found by memory_search, using its ref. Optional from/lines page long items.",
      "Save a durable memory (Memory Fusion). Routed to the configured memory stores; use it for facts, decisions and preferences worth recalling later.",
    ],
  );
});

test("tool results are pretty JSON text with matching details", async () => {
  const tools = createMemoryTools({ agentId: "m", sessionKey: "s" }, async () => ({ provider: null }))!;
  const result = await tools[0]!.execute("1", { query: "" });
  assert.deepEqual(result, { content: [{ type: "text", text: '{\n  "error": "query is required"\n}' }], details: { error: "query is required" } });
  assert.equal(encodeToolRef({ providerId: "memfusion", id: "a" }), Buffer.from('{"id":"a"}', "utf8").toString("base64url"));
});

test("store reports every reason, and an unwrapped stored reference is attributed generically", async () => {
  const handle = fakeBackend("memfusion", [], { capabilities: { store: true } });
  handle.store = async () => ({ status: "rejected", reason: "quota" });
  const open: OpenProvider = async () => ({ provider: handle, providerId: "memfusion" });
  const both = createMemoryTools({ agentId: "m", sessionKey: "s", sandboxed: true }, open, { store: "all" })!;
  assert.deepEqual(JSON.parse((await both[2]!.execute("1", { text: "x" })).content[0]!.text), {
    status: "rejected",
    reason: "quota; workspace memory files are not written from sandboxed sessions",
  });
  const plain = fakeBackend("memfusion", [], { capabilities: { store: true } });
  plain.store = async () => ({ status: "stored", reference: { providerId: "memfusion", id: "flat" } });
  const tools = createMemoryTools({ agentId: "m", sessionKey: "s" }, async () => ({ provider: plain, providerId: "memfusion" }), { store: ["x"] })!;
  const out = JSON.parse((await tools[2]!.execute("1", { text: "x" })).content[0]!.text);
  assert.equal(out.stored[0].store, "backend");
});

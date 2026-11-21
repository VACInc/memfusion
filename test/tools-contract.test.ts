import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createMemoryTools, decodeToolRef, encodeToolRef, type OpenProvider, type ToolContext } from "../src/tools.js";
import type { MemoryProviderHandle, MemoryProviderOpenParams } from "../src/types.js";
import { fakeBackend } from "./helpers.js";

const parse = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text);
const session: ToolContext = { agentId: "main", sessionKey: "agent:main:chat" };

function recording(provider: MemoryProviderHandle | null, extra: { error?: string; providerId?: string } = {}) {
  const calls: MemoryProviderOpenParams[] = [];
  let closed = 0;
  const wrapped = provider
    ? {
        ...provider,
        close: async () => {
          closed += 1;
        },
      }
    : null;
  const open: OpenProvider = async (params) => {
    calls.push(params);
    return { provider: wrapped, providerId: extra.providerId ?? "memfusion", ...(extra.error ? { error: extra.error } : {}) };
  };
  return { open, calls, closed: () => closed, provider: wrapped };
}

function tool(ctx: ToolContext, open: OpenProvider, name: string) {
  return createMemoryTools(ctx, open)!.find((t) => t.name === name)!;
}

test("tool parameter schemas are exact", () => {
  const tools = createMemoryTools(session, recording(null).open)!;
  assert.deepEqual(
    tools.map((t) => [t.name, t.label, t.parameters]),
    [
      [
        "memory_search",
        "Memory Search",
        {
          type: "object",
          properties: {
            query: { type: "string", description: "What to look for." },
            maxResults: { type: "integer", minimum: 1, maximum: 50 },
            minScore: { type: "number", description: "Minimum score each store enforces on its own scale." },
          },
          required: ["query"],
          additionalProperties: false,
        },
      ],
      [
        "memory_get",
        "Memory Get",
        {
          type: "object",
          properties: {
            ref: { type: "string", description: "The ref from a memory_search result." },
            from: { type: "integer", minimum: 1 },
            lines: { type: "integer", minimum: 1 },
          },
          required: ["ref"],
          additionalProperties: false,
        },
      ],
      [
        "memory_store",
        "Memory Store",
        {
          type: "object",
          properties: {
            text: { type: "string", description: "The memory to keep, self-contained." },
            title: { type: "string", description: "Optional short heading." },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["text"],
          additionalProperties: false,
        },
      ],
    ],
  );
});

test("tool refs: revision and fragment survive, missing ones stay absent, bad ids fail", () => {
  assert.deepStrictEqual(decodeToolRef(encodeToolRef({ providerId: "memfusion", id: "i", revision: "r" })), {
    providerId: "memfusion",
    id: "i",
    revision: "r",
  });
  assert.deepStrictEqual(decodeToolRef(encodeToolRef({ providerId: "memfusion", id: "i" })), { providerId: "memfusion", id: "i" });
  assert.equal(decodeToolRef(Buffer.from(JSON.stringify({ id: 5 })).toString("base64url")), null);
});

test("caller context carries session facts, defaults sandboxed to false and checks liveness", async () => {
  const controller = new AbortController();
  let invocationChecks = 0;
  let audienceChecks = 0;
  const rec = recording(fakeBackend("memfusion", []));
  const ctx: ToolContext = {
    ...session,
    sessionId: "s1",
    conversationRecall: { pass: 1 },
    memoryAudience: { kind: "owner-private", agentId: "main" },
    assertInvocationCurrent: () => void (invocationChecks += 1),
    assertMemoryAudienceCurrent: () => void (audienceChecks += 1),
  };
  await tool(ctx, rec.open, "memory_search").execute("1", { query: "q" }, controller.signal);
  const context = rec.calls[0]!.context;
  assert.deepEqual(context.authority, {
    kind: "session",
    sessionKey: "agent:main:chat",
    sandboxed: false,
    sessionId: "s1",
    conversationRecall: { pass: 1 },
    audience: { kind: "owner-private", agentId: "main" },
  });
  assert.equal(context.signal, controller.signal);
  assert.throws(() => context.assertCurrent(), /completed/);

  const live = recording(fakeBackend("memfusion", []));
  const liveTool = tool(ctx, async (params) => {
    params.context.assertCurrent();
    controller.abort();
    assert.throws(() => params.context.assertCurrent());
    return live.open(params);
  }, "memory_search");
  await liveTool.execute("1", { query: "q" }, controller.signal);
  assert.ok(invocationChecks >= 2 && audienceChecks >= 2);
  const plain = recording(fakeBackend("memfusion", []));
  await tool(session, plain.open, "memory_search").execute("1", { query: "q" });
  assert.equal("signal" in plain.calls[0]!.context, false);
  const keys = Object.keys(plain.calls[0]!.context.authority).sort();
  assert.deepEqual(keys, ["kind", "sandboxed", "sessionKey"]);
});

test("config comes from the live runtime first, then runtimeConfig, then config", async () => {
  const pick = async (ctx: ToolContext) => {
    const rec = recording(fakeBackend("memfusion", []));
    await tool({ ...session, ...ctx }, rec.open, "memory_search").execute("1", { query: "q" });
    return rec.calls[0]!.cfg;
  };
  assert.equal(await pick({ getRuntimeConfig: () => "live", runtimeConfig: "snap", config: "base" }), "live");
  assert.equal(await pick({ runtimeConfig: "snap", config: "base" }), "snap");
  assert.equal(await pick({ config: "base" }), "base");
});

test("unavailable memory reports the host error or a default, and always closes", async () => {
  assert.deepEqual(parse(await tool(session, recording(null, { error: "no slot" }).open, "memory_search").execute("1", { query: "q" })), {
    error: "no slot",
  });
  assert.deepEqual(parse(await tool(session, recording(null).open, "memory_search").execute("1", { query: "q" })), {
    error: "Memory is unavailable.",
  });
  const rec = recording(fakeBackend("memfusion", []), { providerId: "memory-core" });
  await tool(session, rec.open, "memory_search").execute("1", { query: "q" });
  assert.equal(rec.closed(), 1);
});

test("memory_search clamps input and maps hits", async () => {
  const handle = fakeBackend("memfusion", [], {
    search: async () => ({
      hits: [
        {
          reference: { providerId: "memfusion", id: '["core","p"]' },
          excerpt: "e",
          score: 0,
          source: "memory",
          citations: [{ label: "L", url: "u", startLine: 1, endLine: 2, reference: { providerId: "memfusion", id: "x" } }],
        },
        { reference: { providerId: "memfusion", id: "not-json" }, excerpt: "bare" },
      ],
      warning: "partial store",
    }),
  });
  const rec = recording(handle);
  const search = tool(session, rec.open, "memory_search");
  assert.deepEqual(parse(await search.execute("1", { query: "   " })), { error: "query is required" });
  assert.deepEqual(parse(await search.execute("1", { query: 7 })), { error: "query is required" });
  const out = parse(await search.execute("1", { query: "  q  ", maxResults: 0.5, minScore: 0.3 }));
  assert.deepEqual(handle.calls.search.at(-1), { query: "q", maxResults: 1, minScore: 0.3 });
  await search.execute("1", { query: "q", maxResults: 99.9 });
  assert.deepEqual(handle.calls.search.at(-1), { query: "q", maxResults: 50 });
  await search.execute("1", { query: "q", maxResults: 7.9, minScore: "high" });
  assert.deepEqual(handle.calls.search.at(-1), { query: "q", maxResults: 7 });
  await search.execute("1", { query: "q" });
  assert.deepEqual(handle.calls.search.at(-1), { query: "q", maxResults: 10 });
  assert.deepEqual(out, {
    results: [
      {
        ref: encodeToolRef({ providerId: "memfusion", id: '["core","p"]' }),
        store: "core",
        excerpt: "e",
        score: 0,
        source: "memory",
        citations: [{ label: "L", url: "u", startLine: 1, endLine: 2 }],
      },
      { ref: encodeToolRef({ providerId: "memfusion", id: "not-json" }), excerpt: "bare" },
    ],
    coverage: "complete",
    warning: "partial store",
  });
});

test("memory_get validates refs, clamps paging and maps results", async () => {
  const handle = fakeBackend("memfusion", []);
  const seen: unknown[] = [];
  handle.get = async (request) => {
    seen.push(request);
    return request.reference.id === "missing"
      ? { status: "not_found" }
      : { status: "ok", reference: request.reference, text: "body", truncated: true, nextFrom: 9 };
  };
  const get = tool(session, recording(handle).open, "memory_get");
  assert.deepEqual(parse(await get.execute("1", { ref: "%%%" })), { error: "ref is not a Memory Fusion ref; use one from memory_search." });
  assert.deepEqual(parse(await get.execute("1", { ref: 5 })), { error: "ref is not a Memory Fusion ref; use one from memory_search." });
  const ref = encodeToolRef({ providerId: "memfusion", id: '["core","p"]' });
  assert.deepEqual(parse(await get.execute("1", { ref, from: 0.2, lines: 3.8 })), {
    status: "ok",
    store: "core",
    text: "body",
    truncated: true,
    nextFrom: 9,
  });
  assert.deepEqual(seen.at(-1), { reference: { providerId: "memfusion", id: '["core","p"]' }, from: 1, lines: 3 });
  await get.execute("1", { ref, from: "x", lines: null });
  assert.deepEqual(seen.at(-1), { reference: { providerId: "memfusion", id: '["core","p"]' } });
  assert.deepEqual(parse(await get.execute("1", { ref: encodeToolRef({ providerId: "memfusion", id: "missing" }) })), {
    status: "not_found",
  });
  const short = fakeBackend("memfusion", []);
  short.get = async (request) => ({ status: "ok", reference: request.reference, text: "short" });
  const shortGet = tool(session, recording(short).open, "memory_get");
  assert.deepEqual(parse(await shortGet.execute("1", { ref })), { status: "ok", store: "core", text: "short" });
});

test("memory_store trims title, filters tags and reports provider rejections", async () => {
  const handle = fakeBackend("memfusion", [], { capabilities: { store: true } });
  const requests: unknown[] = [];
  handle.store = async (request) => {
    requests.push(request);
    return request.text === "no"
      ? { status: "rejected", reason: "quota" }
      : { status: "stored", reference: { providerId: "memfusion", id: '["vec","1"]' } };
  };
  const store = createMemoryTools(session, recording(handle).open, { store: ["vec"] })!.find((t) => t.name === "memory_store")!;
  const ok = parse(await store.execute("1", { text: " keep ", title: "  T  ", tags: ["a", 3, "b"] }));
  assert.deepEqual(requests.at(-1), { text: "keep", title: "T", tags: ["a", "b"], origin: "tool" });
  assert.deepEqual(ok, { status: "stored", stored: [{ store: "vec", ref: encodeToolRef({ providerId: "memfusion", id: '["vec","1"]' }) }] });
  await store.execute("1", { text: "plain", title: "   ", tags: "x" });
  assert.deepEqual(requests.at(-1), { text: "plain", origin: "tool" });
  assert.deepEqual(parse(await store.execute("1", { text: "no" })), { status: "rejected", reason: "quota" });
  assert.deepEqual(parse(await store.execute("1", { text: 4 })), { error: "text is required" });
});

test("memory_store needs both the capability and the method before calling the provider", async () => {
  const flagOnly = fakeBackend("memfusion", [], { capabilities: { store: true } });
  const out = parse(await createMemoryTools(session, recording(flagOnly).open, { store: ["vec"] })!.find((t) => t.name === "memory_store")!.execute("1", { text: "x" }));
  assert.deepEqual(out, { status: "rejected", reason: "no memory store accepts writes" });
});

test("memory_store workspace writes need a workspace and use the configured time zone", async () => {
  const handle = fakeBackend("memfusion", []);
  const noDir = createMemoryTools(session, recording(handle).open)!.find((t) => t.name === "memory_store")!;
  assert.deepEqual(parse(await noDir.execute("1", { text: "x" })), {
    status: "rejected",
    reason: "no agent workspace is available for memory files",
  });
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "memfusion-tz-"));
  try {
    const ctx: ToolContext = { ...session, workspaceDir, getRuntimeConfig: () => ({ agents: { defaults: { userTimezone: "Pacific/Kiritimati" } } }) };
    const out = parse(await createMemoryTools(ctx, recording(handle).open)!.find((t) => t.name === "memory_store")!.execute("1", { text: "x" }));
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Kiritimati", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    assert.deepEqual(out, { status: "stored", stored: [{ store: "workspace", ref: `memory/${day}.md` }] });
    assert.match(await readFile(path.join(workspaceDir, out.stored[0].ref), "utf8"), /\nx\n$/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

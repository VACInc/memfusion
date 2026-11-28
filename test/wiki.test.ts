import assert from "node:assert/strict";
import { test } from "node:test";
import { openFusion } from "../src/fusion.js";
import type { MemoryProviderOpenParams } from "../src/types.js";
import { listWikiCorpora, wikiBackends } from "../src/wiki.js";
import { fakeBackend, hit } from "./helpers.js";

test("Wiki search and get preserve caller scope and do not participate in project recall", async () => {
  const backend = fakeBackend("core", [hit("core", "file", "file text")], {
    capabilities: { projectFilter: true, sources: ["memory", "sessions"] },
  });
  const params: MemoryProviderOpenParams = {
    cfg: {},
    agentId: "reader",
    context: {
      authority: { kind: "session", sessionKey: "agent:reader:main", sandboxed: true },
      assertCurrent() {},
    },
    backends: {
      list: () => [{ id: "core" }],
      open: async () => ({ providerId: "core", provider: backend }),
    },
  };
  const caller = { agentId: "reader", agentSessionKey: "agent:reader:main", sandboxed: true };
  let searches = 0;
  const { provider } = await openFusion("memfusion", params, {}, wikiBackends(params, [{
    pluginId: "memory-wiki",
    supplement: {
      async search(request) {
        ++searches;
        assert.deepEqual(request, { ...caller, query: "topic", maxResults: 5 });
        return [
          { path: "sources/quartz.md", snippet: "wiki text", score: 0.7, startLine: 1, endLine: 2 },
          { path: "sources/weak.md", snippet: "weak text", score: 0.2, citation: "Weak" },
        ];
      },
      async get(request) {
        assert.equal(request.agentId, caller.agentId);
        assert.equal(request.agentSessionKey, caller.agentSessionKey);
        assert.equal(request.sandboxed, true);
        if (request.lookup !== "sources/quartz.md") return null;
        assert.equal(request.fromLine, 2);
        assert.equal(request.lineCount, 1);
        return { content: "full wiki text", fromLine: 2, lineCount: 1 };
      },
    },
  }]));
  assert.ok(provider);
  const page = await provider.search({ query: "topic", maxResults: 5, minScore: 0.7 });
  const wiki = page.hits.find((hit) => hit.source === "wiki");
  assert.equal(page.hits.length, 2);
  assert.equal(wiki?.excerpt, "wiki text");
  assert.deepEqual(wiki.citations, [{ label: "sources/quartz.md", reference: wiki.reference, startLine: 1, endLine: 2 }]);
  assert.deepEqual(await provider.get({ reference: wiki.reference, from: 2, lines: 1 }), {
    status: "ok", reference: wiki.reference, text: "full wiki text", from: 2, lines: 1,
  });

  const unfiltered = await provider.search({ query: "topic", maxResults: 5 });
  const weak = unfiltered.hits.find((hit) => hit.excerpt === "weak text");
  assert.equal(weak?.citations?.[0]?.label, "Weak");
  assert.deepEqual(await provider.get({ reference: weak.reference }), { status: "not_found" });

  assert.equal(provider.capabilities.projectFilter, true);
  assert.equal(provider.store, undefined);
  assert.equal((await provider.search({ query: "topic", sources: ["sessions"] })).hits.length, 1);
  assert.equal((await provider.search({ query: "topic", activeProjectKeys: ["project"] })).hits.length, 1);
  assert.equal(searches, 2);
  await provider.close();
});

test("the corpus registry selects Memory Wiki and tolerates older SDKs", async () => {
  const supplement = { search: async () => [], get: async () => null };
  const wiki = { pluginId: "memory-wiki", supplement };
  assert.deepEqual(await listWikiCorpora(async () => ({
    listMemoryCorpusSupplements: () => [wiki, { pluginId: "other", supplement }],
  })), [wiki]);
  assert.deepEqual(await listWikiCorpora(async () => ({})), []);
  for (const code of ["ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "MODULE_NOT_FOUND"]) {
    assert.deepEqual(await listWikiCorpora(async () => { throw Object.assign(new Error("unsupported"), { code }); }), []);
  }
  await assert.rejects(listWikiCorpora(async () => { throw new Error("registry failed"); }), /registry failed/);

  const params: MemoryProviderOpenParams = {
    cfg: {},
    agentId: "operator-agent",
    context: { authority: { kind: "operator", scopes: ["operator.read"] }, assertCurrent() {} },
  };
  const { provider } = await openFusion("memfusion", params, {}, wikiBackends(params, [{
    ...wiki,
    supplement: {
      ...supplement,
      async search(caller) {
        assert.equal(caller.agentId, "operator-agent");
        assert.equal(caller.agentSessionKey, undefined);
        assert.equal(caller.sandboxed, false);
        return [{ path: "wiki.md", score: 1, snippet: "wiki" }];
      },
    },
  }]));
  assert.equal((await provider?.search({ query: "topic" }))?.hits[0]?.excerpt, "wiki");
});

test("Wiki requires a current lease for every search and read, including after awaiting the corpus", async () => {
  let current = true;
  let searched = 0;
  let read = 0;
  const operator = { kind: "operator" as const, scopes: ["operator.read"], sessionKey: "unexpected", sandboxed: true };
  const [backend] = wikiBackends({
    cfg: {},
    agentId: "operator-agent",
    context: {
      authority: operator,
      assertCurrent() { assert.ok(current, "stale lease"); },
    },
  }, [{
    pluginId: "memory-wiki",
    supplement: {
      async search({ agentSessionKey, sandboxed }) {
        assert.equal(agentSessionKey, undefined);
        assert.equal(sandboxed, false);
        searched++;
        current = false;
        return [];
      },
      async get() {
        read++;
        current = false;
        return null;
      },
    },
  }]);
  const { handle } = backend!;
  assert.deepEqual(handle.capabilities, { sources: ["memory"], candidates: [], pagination: false, projectFilter: true });
  assert.deepEqual(await handle.health(), { status: "ready" });
  const request = { reference: { providerId: "memory-wiki", id: "wiki.md" } };
  await assert.rejects(handle.search({ query: "expired while searching" }), /stale lease/);
  assert.equal(searched, 1);
  await assert.rejects(handle.search({ query: "already expired" }), /stale lease/);
  assert.equal(searched, 1);
  await assert.rejects(handle.get(request), /stale lease/);
  assert.equal(read, 0);
  current = true;
  await assert.rejects(handle.get(request), /stale lease/);
  assert.equal(read, 1);
});

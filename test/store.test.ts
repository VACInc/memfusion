import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFusionHandle, resolveStoreTargets, type OpenBackend } from "../src/fusion.js";
import { createMemoryTools, writesWorkspace, type OpenProvider } from "../src/tools.js";
import type { MemfusionConfig, MemoryStoreRequest } from "../src/types.js";
import { memoryDayStamp } from "../src/workspace.js";
import { fakeBackend } from "./helpers.js";

function writableBackend(id: string, outcome: "stored" | "rejected" | "throw" = "stored") {
  const seen: MemoryStoreRequest[] = [];
  const handle = fakeBackend(id, [], { capabilities: { store: true } });
  handle.store = async (request) => {
    seen.push(request);
    if (outcome === "throw") throw new Error("disk full");
    return outcome === "stored"
      ? { status: "stored", reference: { providerId: id, id: `${id}-1` } }
      : { status: "rejected", reason: "read only today" };
  };
  return { backend: { backendId: id, providerId: id, handle } satisfies OpenBackend, seen };
}

const readOnly = (id: string): OpenBackend => ({ backendId: id, providerId: id, handle: fakeBackend(id, []) });

test("store targets: auto prefers writable backends, else the workspace", () => {
  const a = writableBackend("a").backend;
  assert.deepEqual(resolveStoreTargets(undefined, [a, readOnly("core")]), { backends: [a], workspace: false });
  assert.deepEqual(resolveStoreTargets("auto", [readOnly("core")]), { backends: [], workspace: true });
  assert.deepEqual(resolveStoreTargets("all", [a, readOnly("core")]), { backends: [a], workspace: true });
  assert.deepEqual(resolveStoreTargets(["workspace", "core"], [a, readOnly("core")]), { backends: [], workspace: true });
  assert.deepEqual(resolveStoreTargets(["a"], [a]), { backends: [a], workspace: false });
});

test("fused store writes to every target and returns an owner reference", async () => {
  const a = writableBackend("a");
  const b = writableBackend("b", "throw");
  const provider = createFusionHandle({ ownerId: "memfusion", backends: [a.backend, b.backend, readOnly("core")] });
  assert.equal(provider.capabilities.store, true);
  const result = await provider.store!({ text: "likes tea", origin: "tool" });
  assert.equal(result.status, "stored");
  assert.equal(result.status === "stored" && result.reference.providerId, "memfusion");
  assert.equal(a.seen.length, 1);
  assert.equal(b.seen.length, 1);
});

test("fused store reports every rejection when nothing stored", async () => {
  const a = writableBackend("a", "rejected");
  const provider = createFusionHandle({ ownerId: "memfusion", backends: [a.backend] });
  assert.deepEqual(await provider.store!({ text: "x" }), { status: "rejected", reason: "a: read only today" });
});

test("read-only fusion claims no store", () => {
  const provider = createFusionHandle({ ownerId: "memfusion", backends: [readOnly("core")] });
  assert.equal(provider.capabilities.store, undefined);
  assert.equal(provider.store, undefined);
});

test("writesWorkspace follows the setting and what the provider accepts", () => {
  assert.equal(writesWorkspace(undefined, false), true);
  assert.equal(writesWorkspace("auto", true), false);
  assert.equal(writesWorkspace("all", true), true);
  assert.equal(writesWorkspace(["a"], false), false);
  assert.equal(writesWorkspace(["workspace"], true), true);
});

function opener(backends: OpenBackend[], config: MemfusionConfig = {}): OpenProvider {
  return async () => ({ providerId: "memfusion", provider: createFusionHandle({ ownerId: "memfusion", backends, config }) });
}

const parse = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text);

test("memory_store appends to the workspace day file when no backend accepts writes", async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "memfusion-"));
  try {
    const ctx = { agentId: "main", sessionKey: "agent:main:chat", workspaceDir, config: { agents: { defaults: { userTimezone: "UTC" } } } };
    const tools = createMemoryTools(ctx, opener([readOnly("memory-core")]))!;
    const store = tools.find((tool) => tool.name === "memory_store")!;
    const first = parse(await store.execute("1", { text: "Gunner gets fed first", title: "Dogs", tags: ["pets"] }));
    await store.execute("2", { text: "Second entry" });
    const file = `memory/${memoryDayStamp(new Date(), "UTC")}.md`;
    assert.deepEqual(first, { status: "stored", stored: [{ store: "workspace", ref: file }] });
    const text = await readFile(path.join(workspaceDir, file), "utf8");
    assert.match(text, /## \d\d:\d\d Dogs\n\nGunner gets fed first\n\nTags: pets\n/);
    assert.match(text, /Second entry/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("memory_store routes to writable backends and never writes files from a sandbox", async () => {
  const a = writableBackend("lancedb");
  const tools = createMemoryTools(
    { agentId: "main", sessionKey: "agent:main:chat", sandboxed: true, workspaceDir: "/nonexistent" },
    opener([a.backend], { store: "all" }),
    { store: "all" },
  )!;
  const out = parse(await tools.find((tool) => tool.name === "memory_store")!.execute("1", { text: "x" }));
  assert.equal(out.status, "stored");
  assert.equal(out.stored[0].store, "lancedb");
  assert.match(out.warnings[0], /sandboxed/);
  assert.deepEqual(a.seen[0], { text: "x", origin: "tool" });
});

test("memory_store rejects empty text and reports when nothing can store", async () => {
  const tools = createMemoryTools({ agentId: "main", sessionKey: "s" }, opener([readOnly("core")]), { store: ["core"] })!;
  const store = tools.find((tool) => tool.name === "memory_store")!;
  assert.deepEqual(parse(await store.execute("1", { text: "  " })), { error: "text is required" });
  assert.deepEqual(parse(await store.execute("2", { text: "x" })), {
    status: "rejected",
    reason: "no memory store accepts writes",
  });
});

test("workspace writes refuse symlinked memory paths", async () => {
  const { appendWorkspaceMemory } = await import("../src/workspace.js");
  const { mkdir, symlink, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "memfusion-ws-"));
  const outside = await mkdtemp(path.join(tmpdir(), "memfusion-out-"));
  try {
    const a = path.join(root, "a");
    await mkdir(a);
    await symlink(outside, path.join(a, "memory"));
    await assert.rejects(appendWorkspaceMemory({ workspaceDir: a, text: "x" }), /not a plain directory/);

    const b = path.join(root, "b");
    await mkdir(path.join(b, "memory"), { recursive: true });
    const day = memoryDayStamp(new Date(), "UTC");
    await writeFile(path.join(outside, "victim"), "safe");
    await symlink(path.join(outside, "victim"), path.join(b, "memory", `${day}.md`));
    await assert.rejects(appendWorkspaceMemory({ workspaceDir: b, text: "x", timeZone: "UTC" }), /ELOOP|symbolic/i);
    assert.equal(await readFile(path.join(outside, "victim"), "utf8"), "safe");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPromptSection, resolveFlushPlan, TOOL_NAMES } from "../src/capability.js";

const SEARCH_LINE =
  "Before answering questions about past work, decisions, people, preferences or anything the user told you earlier, call memory_search; read a full item with memory_get using its ref.";
const STORE_LINE =
  "When you learn a durable fact, decision or preference worth recalling later, save it with memory_store as one self-contained entry. Do not store secrets.";
const HEADER = ["## Memory", "Memory Fusion joins several memory stores into one memory."];

test("prompt section lists only the tools that are available", () => {
  assert.deepEqual(buildPromptSection({ availableTools: new Set() }), []);
  assert.deepEqual(buildPromptSection({ availableTools: new Set(["memory_get"]) }), []);
  assert.deepEqual(buildPromptSection({ availableTools: new Set(["memory_search"]) }), [...HEADER, SEARCH_LINE]);
  assert.deepEqual(buildPromptSection({ availableTools: new Set(["memory_store"]) }), [...HEADER, STORE_LINE]);
  assert.deepEqual(buildPromptSection({ availableTools: new Set(["memory_search", "memory_store"]) }), [
    ...HEADER,
    SEARCH_LINE,
    STORE_LINE,
  ]);
});

test("flush plan persists through memory_store with exact prompts", () => {
  assert.deepEqual(resolveFlushPlan(), {
    prompt:
      "Pre-compaction memory flush. Save durable memories from this session with memory_store: one self-contained entry per fact, decision or preference. Use memory_search first to avoid storing something already remembered. If nothing is worth storing, reply with NO_REPLY.",
    systemPrompt:
      "Pre-compaction memory flush turn. The session is near auto-compaction; capture durable memories with memory_store. You may reply, but usually NO_REPLY is correct.",
    persistenceToolNames: ["memory_store"],
    lookupToolNames: ["memory_search", "memory_get"],
  });
  assert.deepEqual(TOOL_NAMES, ["memory_search", "memory_get", "memory_store"]);
});

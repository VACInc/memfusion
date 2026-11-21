import assert from "node:assert/strict";
import { test } from "node:test";
import { fromOwnerReference, toOwnerCitations, toOwnerReference } from "../src/references.js";

test("round-trips a backend reference through the owner id", () => {
  const inner = { providerId: "memory-core", id: "memory/notes.md#3", revision: "r1", fragment: "L3" };
  const owner = toOwnerReference("memfusion", inner);
  assert.equal(owner.providerId, "memfusion");
  assert.deepEqual(fromOwnerReference("memfusion", owner), inner);
});

test("rejects references this owner did not issue", () => {
  assert.equal(fromOwnerReference("memfusion", { providerId: "memory-core", id: "x" }), null);
  assert.equal(fromOwnerReference("memfusion", { providerId: "memfusion", id: "not json" }), null);
  assert.equal(fromOwnerReference("memfusion", { providerId: "memfusion", id: '["",""]' }), null);
  assert.equal(fromOwnerReference("memfusion", { providerId: "memfusion", id: "[1,2]" }), null);
});

test("rewrites citation references and leaves plain citations alone", () => {
  const citations = toOwnerCitations("memfusion", [
    { label: "a", reference: { providerId: "lancedb", id: "7" } },
    { label: "b", url: "https://example.com" },
  ]);
  assert.equal(citations![0]!.reference!.providerId, "memfusion");
  assert.deepEqual(citations![1], { label: "b", url: "https://example.com" });
});

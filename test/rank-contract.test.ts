import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RRF_K, fuseRankedLists } from "../src/rank.js";
import { hit } from "./helpers.js";

test("fused score is weight / (k + rank) with rank starting at 1", () => {
  const [first, second] = fuseRankedLists([{ backendId: "a", hits: [hit("a", "1", "one"), hit("a", "2", "two")] }], {
    k: 10,
  });
  assert.equal(first!.fusedScore, 1 / 11);
  assert.equal(second!.fusedScore, 1 / 12);
});

test("k defaults to 60 when absent, zero or negative", () => {
  for (const k of [undefined, 0, -5]) {
    const [only] = fuseRankedLists([{ backendId: "a", hits: [hit("a", "1", "one")] }], { k });
    assert.equal(only!.fusedScore, 1 / (DEFAULT_RRF_K + 1), `k=${k}`);
  }
  assert.equal(DEFAULT_RRF_K, 60);
});

test("weights scale contributions", () => {
  const [only] = fuseRankedLists([{ backendId: "a", hits: [hit("a", "1", "one")] }], { k: 9, weights: { a: 3 } });
  assert.equal(only!.fusedScore, 3 / 10);
});

test("excerpts match after whitespace collapse, trim and case folding", () => {
  const fused = fuseRankedLists([
    { backendId: "a", hits: [hit("a", "1", "  Shared\n\tFact ")] },
    { backendId: "b", hits: [hit("b", "1", "shared fact")] },
  ]);
  assert.equal(fused.length, 1);
  assert.equal(fused[0]!.fusedScore, 2 / 61);
});

test("duplicates inside one backend never credit that backend twice", () => {
  const fused = fuseRankedLists([{ backendId: "a", hits: [hit("a", "1", "same"), hit("a", "2", "same")] }]);
  assert.equal(fused.length, 1);
  assert.deepEqual(fused[0]!.alsoFrom, []);
  assert.equal(fused[0]!.hit.reference.id, "1", "the better rank stays");
});

test("alsoFrom lists every other backend once, across three backends", () => {
  const fused = fuseRankedLists([
    { backendId: "a", hits: [hit("a", "x", "other"), hit("a", "1", "shared")] },
    { backendId: "b", hits: [hit("b", "1", "shared")] },
    { backendId: "c", hits: [hit("c", "1", "shared")] },
  ]);
  const shared = fused.find(({ hit }) => hit.excerpt === "shared")!;
  assert.equal(shared.backendId, "b", "rank 1 in b beats rank 2 in a; c ties and does not replace it");
  assert.deepEqual([...shared.alsoFrom].sort(), ["a", "c"]);
});

test("equal scores keep input order", () => {
  const fused = fuseRankedLists([
    { backendId: "a", hits: [hit("a", "1", "first")] },
    { backendId: "b", hits: [hit("b", "1", "second")] },
    { backendId: "c", hits: [hit("c", "1", "third")] },
    { backendId: "d", hits: [hit("d", "1", "fourth")] },
  ]);
  assert.deepEqual(fused.map(({ hit }) => hit.excerpt), ["first", "second", "third", "fourth"]);
});

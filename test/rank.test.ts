import assert from "node:assert/strict";
import { test } from "node:test";
import { fuseRankedLists } from "../src/rank.js";
import { hit } from "./helpers.js";

test("interleaves backends by rank, not by raw score", () => {
  const fused = fuseRankedLists([
    { backendId: "a", hits: [hit("a", "1", "a first", 900), hit("a", "2", "a second", 800)] },
    { backendId: "b", hits: [hit("b", "1", "b first", 0.2), hit("b", "2", "b second", 0.1)] },
  ]);
  assert.deepEqual(
    fused.map(({ hit }) => hit.excerpt),
    ["a first", "b first", "a second", "b second"],
  );
});

test("merges identical excerpts and credits every backend", () => {
  const fused = fuseRankedLists([
    { backendId: "a", hits: [hit("a", "1", "only a"), hit("a", "2", "Shared  fact")] },
    { backendId: "b", hits: [hit("b", "9", "shared fact")] },
  ]);
  assert.equal(fused.length, 2);
  assert.equal(fused[0]!.hit.excerpt, "shared fact", "two votes outrank one first place");
  assert.equal(fused[0]!.backendId, "b", "keeps the best-ranked copy");
  assert.deepEqual(fused[0]!.alsoFrom, ["a"]);
});

test("weights bias backends and zero drops one", () => {
  const lists = [
    { backendId: "a", hits: [hit("a", "1", "from a")] },
    { backendId: "b", hits: [hit("b", "1", "from b")] },
  ];
  assert.equal(fuseRankedLists(lists, { weights: { b: 2 } })[0]!.hit.excerpt, "from b");
  assert.deepEqual(
    fuseRankedLists(lists, { weights: { a: 0 } }).map(({ backendId }) => backendId),
    ["b"],
  );
});

test("never merges empty excerpts together", () => {
  const fused = fuseRankedLists([
    { backendId: "a", hits: [hit("a", "1", "")] },
    { backendId: "b", hits: [hit("b", "1", "  ")] },
  ]);
  assert.equal(fused.length, 2);
});

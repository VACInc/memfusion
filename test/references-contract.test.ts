import assert from "node:assert/strict";
import { test } from "node:test";
import { fromOwnerReference, toOwnerCitations, toOwnerReference } from "../src/references.js";

test("optional fields are omitted, not set to undefined", () => {
  assert.deepStrictEqual(toOwnerReference("o", { providerId: "b", id: "1" }), { providerId: "o", id: '["b","1"]' });
  assert.deepStrictEqual(fromOwnerReference("o", { providerId: "o", id: '["b","1"]' }), { providerId: "b", id: "1" });
  assert.deepStrictEqual(toOwnerReference("o", { providerId: "b", id: "1", revision: "r" }), {
    providerId: "o",
    id: '["b","1"]',
    revision: "r",
  });
  assert.deepStrictEqual(fromOwnerReference("o", { providerId: "o", id: '["b","1"]', fragment: "f" }), {
    providerId: "b",
    id: "1",
    fragment: "f",
  });
});

test("each malformed wrapped id is rejected on its own", () => {
  for (const id of ['{"a":1}', '["only"]', '["a","b","c"]', '[1,"x"]', '["a",2]', '["","x"]', "nope"]) {
    assert.equal(fromOwnerReference("o", { providerId: "o", id }), null, id);
  }
  assert.equal(fromOwnerReference("o", { providerId: "other", id: '["b","1"]' }), null, "foreign owner");
});

test("citations: undefined passes through and entries are copies", () => {
  assert.equal(toOwnerCitations("o", undefined), undefined);
  const source = [{ label: "plain" }];
  const out = toOwnerCitations("o", source)!;
  assert.deepEqual(out, source);
  assert.notEqual(out[0], source[0]);
});

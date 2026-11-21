import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("manifest owns the memory slot and requests backends", () => {
  assert.equal(manifest.id, "memfusion");
  assert.equal(manifest.kind, "memory");
  assert.equal(manifest.memoryBackends, true);
  assert.deepEqual(manifest.contracts.tools, ["memory_search", "memory_get"]);
});

test("package and manifest versions match", () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(pkg.name, "@vacinc/memfusion");
  assert.ok(pkg.files.includes("assets/"));
});

test("ships a square PNG icon at assets/icon.png", () => {
  const icon = readFileSync(new URL("../assets/icon.png", import.meta.url));
  assert.ok(statSync(new URL("../assets/icon.png", import.meta.url)).size > 0);
  assert.equal(icon.subarray(1, 4).toString("latin1"), "PNG");
  const width = icon.readUInt32BE(16);
  const height = icon.readUInt32BE(20);
  assert.equal(width, height);
  assert.ok(width >= 256);
});

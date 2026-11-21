import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendWorkspaceMemory, memoryDayStamp } from "../src/workspace.js";

test("day stamp follows the time zone", () => {
  const instant = new Date("2026-01-02T03:30:00Z");
  assert.equal(memoryDayStamp(instant, "UTC"), "2026-01-02");
  assert.equal(memoryDayStamp(instant, "America/New_York"), "2026-01-01");
  assert.equal(memoryDayStamp(new Date("2026-12-31T23:59:00Z"), "Asia/Tokyo"), "2027-01-01");
});

test("entries append with an exact heading, trimmed text and tags", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "memfusion-fmt-"));
  try {
    const now = new Date("2026-03-04T15:06:00Z");
    const rel = await appendWorkspaceMemory({ workspaceDir: dir, text: "  body  ", title: " Two\n words ", tags: ["a", "b"], now, timeZone: "UTC" });
    assert.equal(rel, "memory/2026-03-04.md");
    await appendWorkspaceMemory({ workspaceDir: dir, text: "next", now, timeZone: "UTC" });
    assert.equal(
      await readFile(path.join(dir, rel), "utf8"),
      "\n## 15:06 Two words\n\nbody\n\nTags: a, b\n\n## 15:06\n\nnext\n",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an existing plain memory directory is reused and a file named memory is refused", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "memfusion-dir-"));
  try {
    await mkdir(path.join(dir, "memory"));
    await writeFile(path.join(dir, "memory", "keep.md"), "old");
    await appendWorkspaceMemory({ workspaceDir: dir, text: "x", now: new Date("2026-01-01T00:00:00Z"), timeZone: "UTC" });
    assert.equal(await readFile(path.join(dir, "memory", "keep.md"), "utf8"), "old");
    const fileDir = await mkdtemp(path.join(tmpdir(), "memfusion-file-"));
    await writeFile(path.join(fileDir, "memory"), "not a dir");
    await assert.rejects(appendWorkspaceMemory({ workspaceDir: fileDir, text: "x" }), /not a plain directory/);
    await rm(fileDir, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("defaults to the current time when none is given", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "memfusion-now-"));
  try {
    const rel = await appendWorkspaceMemory({ workspaceDir: dir, text: "x", timeZone: "UTC" });
    assert.equal(rel, `memory/${memoryDayStamp(new Date(), "UTC")}.md`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

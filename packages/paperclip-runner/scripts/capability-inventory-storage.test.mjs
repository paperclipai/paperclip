import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { inventoryOutputs, readInventory } from "./lib/capability-inventory-storage.mjs";

test("split inventory preserves row order and limits file sizes", async () => {
  const root = await mkdtemp(join(tmpdir(), "capability-storage-"));
  try {
    const inventory = { schemaVersion: 2, inventoryRole: "normative", rows: Array.from({ length: 80 }, (_, index) => ({ id: `row-${index}`, text: "x".repeat(800) })) };
    const outputs = inventoryOutputs(root, inventory);
    assert.ok(Object.keys(outputs).length > 2);
    for (const [file, content] of Object.entries(outputs)) {
      assert.ok(Buffer.byteLength(content) <= 16_000);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    assert.deepEqual(await readInventory(join(root, "spec/capability/capabilities.yaml")), inventory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing inventory part causes a read failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "capability-storage-"));
  try {
    const file = join(root, "index.yaml");
    await writeFile(file, JSON.stringify({ rowFiles: ["missing.yaml"] }));
    await assert.rejects(readInventory(file), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

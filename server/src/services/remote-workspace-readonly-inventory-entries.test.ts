import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readWorkspaceInventory } from "./remote-workspace-readonly-inventory.js";

// A full-disk save falls back to a read-only inventory of the sandbox
// workspace. Normal capture archived an 83,417-entry staging workspace whose
// fallback inventory had refused it as a budget overrun before any transfer.
// The fallback must accept a tree of that order, as normal capture does.
const DIRECTORIES = 101;
const LINKS_PER_DIRECTORY = 1_000;

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "readonly-inventory-entries-")));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// Relative links to a sibling file keep the fixture cheap to create and read.
async function writeWideTree() {
  for (let directory = 0; directory < DIRECTORIES; directory++) {
    const parent = path.join(root, `d${String(directory).padStart(3, "0")}`);
    await fs.mkdir(parent);
    await fs.writeFile(path.join(parent, "target"), "x");
    await Promise.all(Array.from({ length: LINKS_PER_DIRECTORY },
      (_, link) => fs.symlink("target", path.join(parent, `l${link}`))));
  }
}

it("inventories a workspace with more than 100,000 entries", async () => {
  await writeWideTree();
  const inventory = await readWorkspaceInventory(root);
  expect(inventory.entries).toBe(DIRECTORIES * (LINKS_PER_DIRECTORY + 2));
  expect(inventory.entries).toBeGreaterThan(100_000);
  expect(inventory.byteSize).toBe(DIRECTORIES);
  expect(inventory.exclude).toEqual([".paperclip-runtime"]);
  // The controller copy uses the same rule, so verification accepts it too.
  expect(await readWorkspaceInventory(root, true)).toEqual(inventory);
}, 240_000);

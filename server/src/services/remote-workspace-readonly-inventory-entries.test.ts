import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readWorkspaceInventory } from "./remote-workspace-readonly-inventory.js";

const DIRECTORIES = 101;
const LINKS_PER_DIRECTORY = 1_000;

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "readonly-inventory-entries-")));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeLinks(parent: string, count: number) {
  await fs.mkdir(parent);
  await fs.writeFile(path.join(parent, "target"), "x");
  await Promise.all(Array.from({ length: count }, (_, link) => fs.symlink("target", path.join(parent, `l${link}`))));
}

it("inventories a workspace with more than 100,000 entries", async () => {
  for (let directory = 0; directory < DIRECTORIES; directory++) {
    await writeLinks(path.join(root, `d${String(directory).padStart(3, "0")}`), LINKS_PER_DIRECTORY);
  }
  const inventory = await readWorkspaceInventory(root);
  expect(inventory.entries).toBe(DIRECTORIES * (LINKS_PER_DIRECTORY + 2));
  expect(inventory.entries).toBeGreaterThan(100_000);
  expect(inventory.byteSize).toBe(DIRECTORIES);
  expect(inventory.exclude).toEqual([".paperclip-runtime"]);
  expect(await readWorkspaceInventory(root, true)).toEqual(inventory);
}, 240_000);

it("inventories one directory with more than 100,000 names", async () => {
  await writeLinks(path.join(root, "wide"), 100_000);
  const inventory = await readWorkspaceInventory(root);
  expect(inventory.entries).toBe(100_002);
  expect(await readWorkspaceInventory(root, true)).toEqual(inventory);
}, 240_000);

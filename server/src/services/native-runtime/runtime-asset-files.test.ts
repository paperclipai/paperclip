import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectDirectoryFiles, writeAssetFiles } from "./runtime-asset-files.js";

const roots: string[] = [];
async function temporary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-asset-files-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it("bounds file reads across simultaneous skill bundles and keeps every byte", async () => {
  const root = await temporary();
  for (let i = 0; i < 40; i++) await fs.writeFile(path.join(root, `${i}.md`), `skill ${i}`);
  const originalRead = fs.readFile.bind(fs);
  let active = 0;
  let peak = 0;
  vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    peak = Math.max(peak, ++active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      return await originalRead(...args);
    } finally { active--; }
  });
  const results = await Promise.all([collectDirectoryFiles(root), collectDirectoryFiles(root)]);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
  for (const files of results) {
    expect(files).toHaveLength(40);
    for (const file of files) expect(file.content.toString()).toBe(`skill ${path.basename(file.path, ".md")}`);
  }
});

it("awaits in-flight writes before reporting an error so caller cleanup is safe", async () => {
  const root = await temporary();
  const originalWrite = fs.writeFile.bind(fs);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0;
  let attempted = 0;
  const fault = new Error("controlled write failure");
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    attempted++;
    if (String(args[0]).endsWith("0.md")) throw fault;
    active++;
    try { await gate; return await originalWrite(...args); }
    finally { active--; }
  });
  let settled = false;
  const pending = writeAssetFiles(root, Array.from({ length: 40 }, (_, i) => ({
    path: `${i}.md`, content: Buffer.from(`file ${i}`), mode: 0o644,
  }))).then(() => { settled = true; return null; }, error => { settled = true; return error; });
  try {
    await vi.waitFor(() => expect(active).toBeGreaterThan(0));
    expect(settled).toBe(false);
  } finally { release(); }
  expect(await pending).toBe(fault);
  expect(active).toBe(0);
  expect(attempted).toBeLessThanOrEqual(8);
});

it("rejects directory symlinks, including Windows junctions", async () => {
  const root = await temporary();
  const outside = await temporary();
  await fs.writeFile(path.join(outside, "outside.md"), "outside");
  await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await expect(collectDirectoryFiles(root)).rejects.toThrow("do not permit symlinks");
});

it("rejects an oversized file before loading it into a parallel batch", async () => {
  const root = await temporary();
  const target = path.join(root, "oversized.bin");
  await fs.writeFile(target, "");
  await fs.truncate(target, 64 * 1024 * 1024 + 1);
  const reads = vi.spyOn(fs, "readFile");
  await expect(collectDirectoryFiles(root)).rejects.toThrow("exceeds its bound");
  expect(reads).not.toHaveBeenCalled();
});

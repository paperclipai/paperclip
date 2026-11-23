import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { materializeAsset } from "./runtime-context.js";
import { removeRuntimeAssetTree, runtimeAssetRetention, RUNTIME_ASSET_RETENTION_MS, withRuntimeAssetUse } from "./runtime-asset-retention.js";

let home: string;
const originalHome = process.env.PAPERCLIP_HOME;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-asset-gc-")); process.env.PAPERCLIP_HOME = home; });
afterEach(async () => {
  await removeRuntimeAssetTree(home);
  if (originalHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = originalHome;
  vi.restoreAllMocks();
});
function database(rows: unknown[] = []) {
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }));
  return { db: { select } as unknown as Db, select };
}
async function age(digest: string) {
  const manifest = path.join(resolvePaperclipInstanceRoot(), "runtime-context-assets", "manifests", `${digest}.json`);
  const old = new Date(Date.now() - RUNTIME_ASSET_RETENTION_MS - 1_000);
  await fs.utimes(manifest, old, old);
}
describe("runtime asset retention", () => {
  it("has no database work when empty/fresh, removes expired copies and rebuilds the same digest", async () => {
    const { db, select } = database();
    const worker = runtimeAssetRetention(db);
    await worker.tick(new AbortController().signal);
    expect(worker.nextRunAt()).toBeNull();
    expect(select).not.toHaveBeenCalled();
    const files = [{ path: "SKILL.md", content: Buffer.from("immutable skill"), mode: 0o444 }];
    const asset = await materializeAsset(files);
    await worker.tick(new AbortController().signal);
    expect(worker.nextRunAt()).toBeGreaterThan(Date.now());
    expect(select).not.toHaveBeenCalled();
    await age(asset.digest);
    await worker.tick(new AbortController().signal);
    expect(select).toHaveBeenCalledOnce();
    expect(await fs.stat(asset.rootPath).catch(() => null)).toBeNull();
    expect(worker.nextRunAt()).toBeNull();
    await worker.tick(new AbortController().signal);
    expect(select).toHaveBeenCalledOnce();
    expect(await materializeAsset(files)).toEqual(asset);
  });
  it("keeps files when an unfinished run has no trustworthy input", async () => {
    const asset = await materializeAsset([{ path: "SKILL.md", content: Buffer.from("pinned skill"), mode: 0o444 }]);
    await age(asset.digest);
    const { db } = database([{ id: "run", companyId: "company", agentId: "agent", input: null }]);
    const worker = runtimeAssetRetention(db);
    await worker.tick(new AbortController().signal);
    expect((await fs.stat(asset.rootPath)).isDirectory()).toBe(true);
    expect(worker.nextRunAt()).toBeNull();
  });
  it("refreshes a cold lease once for concurrent turns instead of queueing each on the lock", async () => {
    const digest = "a".repeat(64);
    const manifests = path.join(resolvePaperclipInstanceRoot(), "runtime-context-assets", "manifests");
    await fs.mkdir(manifests, { recursive: true });
    await fs.writeFile(path.join(manifests, `${digest}.json`), "{}");
    const modes: boolean[] = [];
    const use = () => withRuntimeAssetUse(digest, async locked => {
      modes.push(locked);
      if (locked) await new Promise(resolve => setTimeout(resolve, 50));
      return locked;
    });
    const results = await Promise.all(Array.from({ length: 8 }, use));
    expect(modes.filter(Boolean)).toHaveLength(1);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await withRuntimeAssetUse(digest, async locked => locked, true)).toBe(true);
  });
  it("lets waiters take the lock themselves when the shared refresh records no lease", async () => {
    const digest = "b".repeat(64);
    const modes: boolean[] = [];
    let first = true;
    const use = () => withRuntimeAssetUse(digest, async locked => {
      modes.push(locked);
      if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 20)); throw new Error("refresh failed"); }
      return locked;
    });
    const [leader, ...waiters] = await Promise.allSettled(Array.from({ length: 4 }, use));
    expect(leader.status).toBe("rejected");
    expect(waiters).toEqual(Array.from({ length: 3 }, () => ({ status: "fulfilled", value: true })));
    expect(modes).toEqual([true, true, true, true]);
  });
});

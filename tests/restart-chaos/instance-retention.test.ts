import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEPT_INSTANCE_MARKER, KEPT_INSTANCE_MAX_AGE_MS, keepInstance, releaseInstance, sweepExpiredKeptInstances } from "./instance-retention.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function parent() {
  const root = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-retention-"));
  roots.push(root);
  return root;
}
async function instance(under: string, name: string) {
  const root = path.join(under, `paperclip-runner-e2e-${name}`);
  await mkdir(path.join(root, "home", "instances", "default", "db"), { recursive: true });
  return root;
}

describe("instance retention", () => {
  it("deletes a finished wave's instance unless --keep or a failed stop asks to keep it", async () => {
    const under = await parent();
    const finished = await instance(under, "done");
    expect(await releaseInstance(finished, { keep: false, stopFailed: false, waveId: "w1" })).toEqual({ kept: false });
    expect(existsSync(finished)).toBe(false);
    const kept = await instance(under, "kept");
    expect(await releaseInstance(kept, { keep: true, stopFailed: false, waveId: "w2" }, 1_000)).toEqual({ kept: true, reason: "keep" });
    expect(existsSync(path.join(kept, KEPT_INSTANCE_MARKER))).toBe(true);
    const stuck = await instance(under, "stuck");
    expect(await releaseInstance(stuck, { keep: false, stopFailed: true, waveId: "w3" }, 1_000)).toEqual({ kept: true, reason: "stop_failed" });
  });

  it("sweeps only marked kept instances past their expiry whose Postgres is not running", async () => {
    const under = await parent();
    const now = 10 * KEPT_INSTANCE_MAX_AGE_MS;
    const expired = await instance(under, "expired");
    await keepInstance(expired, { waveId: "w1", reason: "keep" }, now - KEPT_INSTANCE_MAX_AGE_MS - 1);
    const fresh = await instance(under, "fresh");
    await keepInstance(fresh, { waveId: "w2", reason: "keep" }, now - 1_000);
    const live = await instance(under, "live");
    await keepInstance(live, { waveId: "w3", reason: "keep" }, now - KEPT_INSTANCE_MAX_AGE_MS - 1);
    await writeFile(path.join(live, "home", "instances", "default", "db", "postmaster.pid"), `${process.pid}\n/data\n`);
    const unmarked = await instance(under, "unmarked");
    const unrelated = path.join(under, "something-else");
    await mkdir(unrelated);
    await writeFile(path.join(unrelated, KEPT_INSTANCE_MARKER), JSON.stringify({ keptAt: 0 }));

    expect(await sweepExpiredKeptInstances(under, now)).toEqual([expired]);
    expect(existsSync(expired)).toBe(false);
    for (const survivor of [fresh, live, unmarked, unrelated]) expect(existsSync(survivor)).toBe(true);
  });

  it("treats a stale postmaster.pid whose process is gone as not running", async () => {
    const under = await parent();
    const stale = await instance(under, "stale");
    await keepInstance(stale, { waveId: "w1", reason: "stop_failed" }, 0);
    await writeFile(path.join(stale, "home", "instances", "default", "db", "postmaster.pid"), "2147483646\n/data\n");
    expect(await sweepExpiredKeptInstances(under, KEPT_INSTANCE_MAX_AGE_MS + 1)).toEqual([stale]);
  });
});

import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEPT_INSTANCE_MARKER, KEPT_INSTANCE_MAX_AGE_MS, keepInstance, releaseInstance, sweepExpiredKeptInstances } from "./instance-retention.js";
import { createRunnerE2ETemporaryRoot } from "./server-config.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function parent() {
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-e2e-retention-"));
  roots.push(root);
  return root;
}
async function instance(under: string, name: string) {
  const root = path.join(under, `paperclip-runner-e2e-${name}`);
  await mkdir(path.join(root, "home", "instances", "default", "db"), { recursive: true });
  return root;
}

describe("instance retention", () => {
  it("deletes a finished instance unless --keep or a failed stop asks to keep it", async () => {
    const under = await parent();
    const finished = await instance(under, "done");
    expect(await releaseInstance(finished, { keep: false, stopFailed: false, owner: "w1" })).toEqual({ kept: false });
    expect(existsSync(finished)).toBe(false);
    const kept = await instance(under, "kept");
    expect(await releaseInstance(kept, { keep: true, stopFailed: false, owner: "w2" }, 1_000)).toEqual({ kept: true, reason: "keep" });
    expect(existsSync(path.join(kept, KEPT_INSTANCE_MARKER))).toBe(true);
    expect((await stat(kept)).mode & 0o777).toBe(0o700);
    const evidence = await instance(under, "evidence");
    await writeFile(path.join(evidence, "report.json"), "{}");
    expect(await releaseInstance(evidence, { keep: false, stopFailed: false, owner: "smoke", retain: entry => entry === "report.json" })).toEqual({ kept: false });
    expect(existsSync(path.join(evidence, "report.json"))).toBe(true);
    expect(existsSync(path.join(evidence, "home"))).toBe(false);
    const remote = await instance(under, "remote");
    expect(await releaseInstance(remote, { keep: false, stopFailed: false, remoteCleanupPending: true, owner: "w4" }))
      .toEqual({ kept: true, reason: "recovery_state" });
    const stuck = await instance(under, "stuck");
    expect(await releaseInstance(stuck, { keep: false, stopFailed: true, owner: "w3" }, 1_000)).toEqual({ kept: true, reason: "stop_failed" });
  });

  it("sweeps only marked kept instances past their expiry whose Postgres is not running", async () => {
    const under = await parent();
    const now = 10 * KEPT_INSTANCE_MAX_AGE_MS;
    const old = now - KEPT_INSTANCE_MAX_AGE_MS - 1;
    const expired = await instance(under, "expired");
    await keepInstance(expired, { owner: "w1", reason: "keep" }, old);
    const fresh = await instance(under, "fresh");
    await keepInstance(fresh, { owner: "w2", reason: "keep" }, now - 1_000);
    const live = await instance(under, "live");
    await keepInstance(live, { owner: "w3", reason: "keep" }, old);
    await mkdir(path.join(live, "a", "home"), { recursive: true });
    await writeFile(path.join(live, "a", "home", "postmaster.pid"), `${process.pid}\n/data\n`);
    const recovery = await instance(under, "recovery");
    await keepInstance(recovery, { owner: "launch", reason: "recovery_state" }, old);
    const unmarked = await instance(under, "unmarked");
    const unrelated = path.join(under, "something-else");
    await mkdir(unrelated);
    await writeFile(path.join(unrelated, KEPT_INSTANCE_MARKER), JSON.stringify({ keptAt: 0 }));

    const runner = await instance(under, "runner");
    await keepInstance(runner, { owner: "w4", reason: "stop_failed" }, old);

    expect(await sweepExpiredKeptInstances(under, now, KEPT_INSTANCE_MAX_AGE_MS, () => [`node ${runner}/provider-bin/runnerd`])).toEqual([expired]);
    expect(existsSync(expired)).toBe(false);
    for (const survivor of [fresh, live, recovery, unmarked, unrelated, runner]) expect(existsSync(survivor)).toBe(true);
  });

  it("releases a finished instance whose immutable runtime bundles are read-only", async () => {
    const under = await parent();
    const finished = await instance(under, "bundles");
    const bundle = path.join(finished, "home", "instances", "default", "runtime-context-assets", "bundles", "sha256-abc");
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(bundle, "AGENTS.md"), "x");
    await chmod(bundle, 0o555);
    await chmod(path.dirname(bundle), 0o555);
    expect(await releaseInstance(finished, { keep: false, stopFailed: false, owner: "w1" })).toEqual({ kept: false });
    expect(existsSync(finished)).toBe(false);
  });

  it("sweeps an expired instance that holds read-only directories", async () => {
    const under = await parent();
    const locked = await instance(under, "locked");
    await keepInstance(locked, { owner: "w1", reason: "keep" }, 0);
    const readOnly = path.join(locked, "home", "cache");
    await mkdir(readOnly, { recursive: true });
    await writeFile(path.join(readOnly, "entry"), "x");
    await chmod(readOnly, 0o500);
    expect(await sweepExpiredKeptInstances(under, KEPT_INSTANCE_MAX_AGE_MS + 1)).toEqual([locked]);
    expect(existsSync(locked)).toBe(false);
  });

  it("treats a stale postmaster.pid whose process is gone as not running", async () => {
    const under = await parent();
    const stale = await instance(under, "stale");
    await keepInstance(stale, { owner: "w1", reason: "stop_failed" }, 0);
    await writeFile(path.join(stale, "home", "instances", "default", "db", "postmaster.pid"), "2147483646\n/data\n");
    expect(await sweepExpiredKeptInstances(under, KEPT_INSTANCE_MAX_AGE_MS + 1)).toEqual([stale]);
  });

  it("sweeps expired kept instances whenever a caller creates a new temporary root", async () => {
    const under = await parent();
    const expired = await instance(under, "expired");
    await keepInstance(expired, { owner: "w1", reason: "keep" }, Date.now() - KEPT_INSTANCE_MAX_AGE_MS - 1);
    const created = await createRunnerE2ETemporaryRoot(under);
    expect(existsSync(expired)).toBe(false);
    expect(path.basename(created).startsWith("paperclip-runner-e2e-")).toBe(true);
  });
});

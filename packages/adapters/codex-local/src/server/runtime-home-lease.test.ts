import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRuntimeHomeLease } from "./runtime-home-lease.js";

const DIGEST = "d".repeat(64);
let parent: string;

beforeEach(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-lease-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(parent, { recursive: true, force: true });
});

const leaseFile = (slot: number) => path.join(parent, slot === 0 ? `${DIGEST}.lease` : `${DIGEST}-${slot}.lease`);

describe("acquireRuntimeHomeLease", () => {
  it("hands out the primary slot, then the next free slot while it is held, and reuses released slots", async () => {
    const first = await acquireRuntimeHomeLease(parent, DIGEST, "run-1");
    const second = await acquireRuntimeHomeLease(parent, DIGEST, "run-2");
    expect(first.home).toBe(path.join(parent, DIGEST));
    expect(second.home).toBe(path.join(parent, `${DIGEST}-1`));
    await first.release();
    const third = await acquireRuntimeHomeLease(parent, DIGEST, "run-3");
    expect(third.home).toBe(first.home);
    await second.release();
    await third.release();
    expect((await fs.readdir(parent)).filter((name) => name.endsWith(".lease") || name.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes concurrent acquisitions so each holder gets a distinct slot", async () => {
    const leases = await Promise.all(Array.from({ length: 8 }, (_, i) => acquireRuntimeHomeLease(parent, DIGEST, `run-${i}`)));
    expect(new Set(leases.map((lease) => lease.home)).size).toBe(8);
    await Promise.all(leases.map((lease) => lease.release()));
  });

  it("takes over a lease left by a process that no longer runs", async () => {
    await fs.writeFile(leaseFile(0), JSON.stringify({ pid: 2 ** 22 + 12345, nonce: "dead-process", token: "t" }));
    const lease = await acquireRuntimeHomeLease(parent, DIGEST);
    expect(lease.home).toBe(path.join(parent, DIGEST));
    await lease.release();
  });

  it("takes over a lease left by an earlier incarnation with this pid, and an unreadable lease", async () => {
    await fs.writeFile(leaseFile(0), JSON.stringify({ pid: process.pid, nonce: "earlier-incarnation", token: "t" }));
    await fs.writeFile(leaseFile(1), "not json");
    const a = await acquireRuntimeHomeLease(parent, DIGEST);
    const b = await acquireRuntimeHomeLease(parent, DIGEST);
    expect([a.home, b.home]).toEqual([path.join(parent, DIGEST), path.join(parent, `${DIGEST}-1`)]);
    await a.release();
    await b.release();
  });

  it("never takes a slot still in use by another live process", async () => {
    const foreign = JSON.stringify({ pid: process.ppid, nonce: "other-live-process", token: "t" });
    await fs.writeFile(leaseFile(0), foreign);
    const lease = await acquireRuntimeHomeLease(parent, DIGEST);
    expect(lease.home).toBe(path.join(parent, `${DIGEST}-1`));
    await lease.release();
    expect(await fs.readFile(leaseFile(0), "utf8")).toBe(foreign);
  });

  it("release is idempotent and never removes a lease another holder now owns", async () => {
    const lease = await acquireRuntimeHomeLease(parent, DIGEST);
    await fs.rm(leaseFile(0));
    const foreign = JSON.stringify({ pid: process.ppid, nonce: "other-live-process", token: "other" });
    await fs.writeFile(leaseFile(0), foreign);
    await lease.release();
    await lease.release();
    expect(await fs.readFile(leaseFile(0), "utf8")).toBe(foreign);
  });

  it("keeps a lease another acquisition took while a release was still removing its file", async () => {
    const realRm = fs.rm.bind(fs);
    let releaseRemoving = false;
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === leaseFile(0) && !releaseRemoving) {
        releaseRemoving = true;
        await blocked;
      }
      return realRm(target, options);
    });
    const first = await acquireRuntimeHomeLease(parent, DIGEST, "run-1");
    const releasing = first.release();
    for (let i = 0; i < 200 && !releaseRemoving; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(releaseRemoving).toBe(true);
    // The release has read its lease and is about to remove it; a new holder arrives now.
    const second = await acquireRuntimeHomeLease(parent, DIGEST, "run-2");
    unblock();
    await releasing;
    const raw = await fs.readFile(`${second.home}.lease`, "utf8");
    expect(JSON.parse(raw).runId).toBe("run-2");
    await second.release();
  });

  it("never removes a live lease that replaced the stale one it was recovering", async () => {
    const stale = JSON.stringify({ pid: 2 ** 22 + 12345, nonce: "dead-process", token: "stale" });
    const live = JSON.stringify({ pid: process.ppid, nonce: "other-live-process", token: "live" });
    const third = JSON.stringify({ pid: process.ppid, nonce: "third-live-process", token: "third" });
    await fs.writeFile(leaseFile(0), stale);
    const realReadFile = fs.readFile.bind(fs);
    const realRename = fs.rename.bind(fs);
    let replaced = false;
    // Another process recovers the same stale lease and takes the slot right
    // after this process has read it.
    vi.spyOn(fs, "readFile").mockImplementation((async (target: string, options: unknown) => {
      const raw = await (realReadFile as (t: string, o: unknown) => Promise<string>)(target, options);
      if (target === leaseFile(0) && raw === stale && !replaced) {
        replaced = true;
        await fs.unlink(leaseFile(0));
        await fs.writeFile(leaseFile(0), live);
      }
      return raw;
    }) as typeof fs.readFile);
    // A third process acquires the slot whenever its lease file is briefly absent.
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await realRename(from, to);
      if (from === leaseFile(0)) await fs.writeFile(leaseFile(0), third, { flag: "wx" }).catch(() => {});
    });
    const lease = await acquireRuntimeHomeLease(parent, DIGEST, "run-1");
    expect(replaced).toBe(true);
    expect(lease.home).toBe(path.join(parent, `${DIGEST}-1`));
    expect(await realReadFile(leaseFile(0), "utf8")).toBe(live);
    await lease.release();
  });

  it("recovers a stale lease whose earlier recoverer died before removing it", async () => {
    const stale = JSON.stringify({ pid: 2 ** 22 + 12345, nonce: "dead-process", token: "stale" });
    await fs.writeFile(leaseFile(0), stale);
    const generation = createHash("sha256").update(stale).digest("hex").slice(0, 32);
    const deadRecoverer = JSON.stringify({ pid: 2 ** 22 + 12346, nonce: "dead-recoverer", token: "r" });
    await fs.writeFile(`${leaseFile(0)}.recover-${generation}`, deadRecoverer);
    const lease = await acquireRuntimeHomeLease(parent, DIGEST, "run-1");
    expect(lease.home).toBe(path.join(parent, DIGEST));
    await lease.release();
    expect((await fs.readdir(parent)).filter((name) => name.includes(".recover-"))).toEqual([]);
  });

  it("skips a slot whose stale lease has a deeper chain of dead recoverers, without overlong names", async () => {
    const generationOf = (raw: string) => createHash("sha256").update(raw).digest("hex").slice(0, 32);
    const stale = JSON.stringify({ pid: 2 ** 22 + 12345, nonce: "dead-process", token: "stale" });
    await fs.writeFile(leaseFile(0), stale);
    const firstRecoverer = JSON.stringify({ pid: 2 ** 22 + 12346, nonce: "dead-recoverer-1", token: "r1" });
    const firstMarker = `${leaseFile(0)}.recover-${generationOf(stale)}`;
    await fs.writeFile(firstMarker, firstRecoverer);
    const secondRecoverer = JSON.stringify({ pid: 2 ** 22 + 12347, nonce: "dead-recoverer-2", token: "r2" });
    const secondMarker = `${firstMarker}.recover-${generationOf(firstRecoverer)}`;
    await fs.writeFile(secondMarker, secondRecoverer);
    for (let run = 0; run < 3; run += 1) {
      const lease = await acquireRuntimeHomeLease(parent, DIGEST, `run-${run}`);
      expect(lease.home).toBe(path.join(parent, `${DIGEST}-1`));
      await lease.release();
    }
    // The occupied slot is left as found: dead markers are never deleted blindly.
    expect(await fs.readFile(leaseFile(0), "utf8")).toBe(stale);
    expect(await fs.readFile(firstMarker, "utf8")).toBe(firstRecoverer);
    expect(await fs.readFile(secondMarker, "utf8")).toBe(secondRecoverer);
  });

  it("leaves a stale lease alone while a live recoverer holds its marker", async () => {
    const stale = JSON.stringify({ pid: 2 ** 22 + 12345, nonce: "dead-process", token: "stale" });
    await fs.writeFile(leaseFile(0), stale);
    const generation = createHash("sha256").update(stale).digest("hex").slice(0, 32);
    const liveRecoverer = JSON.stringify({ pid: process.ppid, nonce: "other-live-process", token: "r" });
    await fs.writeFile(`${leaseFile(0)}.recover-${generation}`, liveRecoverer);
    const lease = await acquireRuntimeHomeLease(parent, DIGEST, "run-1");
    expect(lease.home).toBe(path.join(parent, `${DIGEST}-1`));
    expect(await fs.readFile(leaseFile(0), "utf8")).toBe(stale);
    await lease.release();
  });

  it("prefers the requested slot of this digest and falls back to the first free slot", async () => {
    const preferred = await acquireRuntimeHomeLease(parent, DIGEST, "run-1", { preferredHome: `${DIGEST}-2` });
    expect(preferred.home).toBe(path.join(parent, `${DIGEST}-2`));
    const busy = await acquireRuntimeHomeLease(parent, DIGEST, "run-2", { preferredHome: `${DIGEST}-2` });
    expect(busy.home).toBe(path.join(parent, DIGEST));
    for (const preferredHome of ["../escape", `${"e".repeat(64)}-1`, `${DIGEST}-64`, `${DIGEST}-01`, path.join(parent, `${DIGEST}-3`)]) {
      const ignored = await acquireRuntimeHomeLease(parent, DIGEST, "run-x", { preferredHome });
      expect(ignored.home).toBe(path.join(parent, `${DIGEST}-1`));
      await ignored.release();
    }
    await preferred.release();
    await busy.release();
    expect((await fs.readdir(parent)).filter((name) => !/^d{64}(-\d+)?$/.test(name))).toEqual([]);
  });
});

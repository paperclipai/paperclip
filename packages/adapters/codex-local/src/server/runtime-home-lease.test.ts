import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireRuntimeHomeLease } from "./runtime-home-lease.js";

const DIGEST = "d".repeat(64);
let parent: string;

beforeEach(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-lease-"));
});

afterEach(async () => {
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
});

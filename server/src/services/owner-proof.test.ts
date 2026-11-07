import { afterEach, describe, expect, it, vi } from "vitest";
import { processExists } from "./controller-process-identity.js";
import {
  currentLocalOwnerStamp,
  currentProcessProbe,
  proveOwnerGone,
  type LocalOwnerStamp,
  type ProcessProbe,
  type RemoteOwnerStamp,
} from "./owner-proof.js";

const STARTED = "2026-11-07T10:00:00.000Z";
const at = (offsetMs: number) => new Date(Date.parse(STARTED) + offsetMs);

function stamp(overrides: Partial<LocalOwnerStamp> = {}): LocalOwnerStamp {
  return {
    kind: "local", scope: "test", generation: 1, host: "host-a", processSpace: "space-a",
    bootId: "previous-boot", pid: 4242, processStartedAt: STARTED, processGroupId: null, ...overrides,
  };
}

function probe(overrides: Partial<ProcessProbe> & {
  alive?: number[]; groups?: number[]; starts?: Record<number, Date | null>;
} = {}): ProcessProbe {
  const { alive = [], groups = [], starts = {}, ...rest } = overrides;
  return {
    bootId: "current-boot", host: "host-a", processSpace: "space-a",
    pidExists: pid => alive.includes(pid),
    processGroupExists: group => groups.includes(group),
    readStartedAt: async pid => starts[pid] ?? null,
    ...rest,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("proveOwnerGone: local owners", () => {
  it("treats this process's own boot as alive", async () => {
    expect(await proveOwnerGone(stamp({ bootId: "current-boot" }), probe())).toEqual({ verdict: "alive", reason: "current_process" });
  });

  it("proves a dead PID in the same PID space gone", async () => {
    expect(await proveOwnerGone(stamp(), probe())).toEqual({ verdict: "gone", reason: "pid_dead" });
  });

  it("never treats a different host as proof, even when the PID is dead here", async () => {
    expect(await proveOwnerGone(stamp({ host: "host-b" }), probe())).toEqual({ verdict: "unprovable", reason: "different_host" });
  });

  it("never treats a different PID namespace or kernel boot as proof", async () => {
    expect(await proveOwnerGone(stamp({ processSpace: "space-b" }), probe()))
      .toEqual({ verdict: "unprovable", reason: "different_process_space" });
    expect(await proveOwnerGone(stamp({ processSpace: "unknown" }), probe()))
      .toEqual({ verdict: "unprovable", reason: "unknown_process_space" });
    expect(await proveOwnerGone(stamp(), probe({ processSpace: "unknown" })))
      .toEqual({ verdict: "unprovable", reason: "unknown_process_space" });
  });

  it("treats a stamp without a PID or process space as unprovable", async () => {
    expect(await proveOwnerGone(stamp({ pid: null }), probe())).toEqual({ verdict: "unprovable", reason: "missing_identity" });
    expect(await proveOwnerGone(stamp({ processSpace: null }), probe())).toEqual({ verdict: "unprovable", reason: "missing_identity" });
  });

  it("keeps a live PID whose start time is within 1 s of the stamp alive (ps lstart precision)", async () => {
    for (const offset of [0, 1, 999, -999]) {
      expect(await proveOwnerGone(stamp(), probe({ alive: [4242], starts: { 4242: at(offset) } })))
        .toEqual({ verdict: "alive", reason: "pid_alive" });
    }
  });

  it("proves a reused PID gone only at a start-time gap of at least 1 s", async () => {
    expect(await proveOwnerGone(stamp(), probe({ alive: [4242], starts: { 4242: at(1_000) } })))
      .toEqual({ verdict: "gone", reason: "pid_reused" });
    expect(await proveOwnerGone(stamp(), probe({ alive: [4242], starts: { 4242: at(-60_000) } })))
      .toEqual({ verdict: "gone", reason: "pid_reused" });
  });

  it("treats a live PID with an unreadable or unrecorded start time as unprovable", async () => {
    expect(await proveOwnerGone(stamp(), probe({ alive: [4242] })))
      .toEqual({ verdict: "unprovable", reason: "pid_start_unreadable" });
    expect(await proveOwnerGone(stamp({ processStartedAt: null }), probe({ alive: [4242], starts: { 4242: at(5_000) } })))
      .toEqual({ verdict: "unprovable", reason: "pid_start_unreadable" });
  });

  it("treats EPERM from signal 0 as a live process", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    expect(processExists(4242)).toBe(true);
    const real = currentProcessProbe();
    const result = await proveOwnerGone(
      stamp({ host: real.host, processSpace: real.processSpace, processStartedAt: STARTED }),
      { ...real, readStartedAt: async () => at(0) },
    );
    expect(result).toEqual({ verdict: "alive", reason: "pid_alive" });
  });

  it("treats ESRCH from signal 0 as a dead process", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(processExists(4242)).toBe(false);
  });

  it("keeps the owner alive while its process group still has members", async () => {
    expect(await proveOwnerGone(stamp({ processGroupId: 4242 }), probe({ groups: [4242] })))
      .toEqual({ verdict: "alive", reason: "process_group_alive" });
    // The leader is a different process, but it started before the stamp: it
    // is the original group, so the work may still run.
    expect(await proveOwnerGone(stamp({ processGroupId: 5000 }), probe({ groups: [5000], alive: [5000], starts: { 5000: at(-10_000) } })))
      .toEqual({ verdict: "alive", reason: "process_group_alive" });
  });

  it("proves the owner gone when its process group is empty or led by a newer process", async () => {
    expect(await proveOwnerGone(stamp({ processGroupId: 4242 }), probe())).toEqual({ verdict: "gone", reason: "pid_dead" });
    expect(await proveOwnerGone(stamp({ processGroupId: 5000 }), probe({ groups: [5000], alive: [5000], starts: { 5000: at(30_000) } })))
      .toEqual({ verdict: "gone", reason: "pid_dead" });
  });

  it("treats a non-empty group with an unreadable leader as unprovable", async () => {
    expect(await proveOwnerGone(stamp({ processGroupId: 5000 }), probe({ groups: [5000], alive: [5000] })))
      .toEqual({ verdict: "unprovable", reason: "process_group_ambiguous" });
  });

  it("stamps this process from cached identity and proves it alive", async () => {
    const own = await currentLocalOwnerStamp("test", 3);
    expect(own).toMatchObject({ kind: "local", pid: process.pid, generation: 3 });
    expect(await proveOwnerGone(own)).toEqual({ verdict: "alive", reason: "current_process" });
  });
});

describe("proveOwnerGone: remote owners (fenced handoff)", () => {
  const remote = (overrides: Partial<RemoteOwnerStamp> = {}): RemoteOwnerStamp => ({
    kind: "remote", scope: "test", generation: 2, fenceToken: "boot:2:token", provider: "daytona", ...overrides,
  });
  const now = new Date("2026-11-07T12:00:00.000Z");
  const later = new Date(now.getTime() + 30_000);
  const earlier = new Date(now.getTime() - 30_000);

  it("keeps a held fence alive", async () => {
    expect(await proveOwnerGone(remote(), { currentFenceToken: "boot:2:token", currentGeneration: 2, leaseExpiresAt: later }, now))
      .toEqual({ verdict: "alive", reason: "fence_held" });
  });

  it("proves a superseded fence token or generation gone", async () => {
    expect(await proveOwnerGone(remote(), { currentFenceToken: "boot:3:other", currentGeneration: 2, leaseExpiresAt: later }, now))
      .toEqual({ verdict: "gone", reason: "fence_superseded" });
    expect(await proveOwnerGone(remote(), { currentFenceToken: null, currentGeneration: 2, leaseExpiresAt: null }, now))
      .toEqual({ verdict: "gone", reason: "fence_superseded" });
    expect(await proveOwnerGone(remote(), { currentFenceToken: "boot:2:token", currentGeneration: 3, leaseExpiresAt: later }, now))
      .toEqual({ verdict: "gone", reason: "generation_superseded" });
  });

  it("never proves an expired fence gone by age alone", async () => {
    expect(await proveOwnerGone(remote(), { currentFenceToken: "boot:2:token", currentGeneration: 2, leaseExpiresAt: earlier }, now))
      .toEqual({ verdict: "unprovable", reason: "fence_expired_without_provider_proof" });
  });

  it("uses the provider proof where one exists", async () => {
    expect(await proveOwnerGone(remote(), { currentFenceToken: "boot:2:token", currentGeneration: 2, leaseExpiresAt: earlier, provider: "stopped" }, now))
      .toEqual({ verdict: "gone", reason: "provider_stopped" });
    expect(await proveOwnerGone(remote(), { currentFenceToken: "boot:2:token", currentGeneration: 2, leaseExpiresAt: earlier, provider: "running" }, now))
      .toEqual({ verdict: "alive", reason: "provider_running" });
  });

  it("does not consult process liveness for a remote owner", async () => {
    const kill = vi.spyOn(process, "kill");
    await proveOwnerGone(remote(), { currentFenceToken: "boot:2:token", currentGeneration: 2, leaseExpiresAt: earlier }, now);
    expect(kill).not.toHaveBeenCalled();
  });

  it("treats a remote stamp without a fence token as unprovable", async () => {
    expect(await proveOwnerGone(remote({ fenceToken: null }), { currentFenceToken: null, currentGeneration: null, leaseExpiresAt: null }, now))
      .toEqual({ verdict: "unprovable", reason: "missing_identity" });
  });
});

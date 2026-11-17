import { describe, expect, it, vi } from "vitest";

const boot = vi.hoisted(() => ({ id: "boot-a" }));
vi.mock("./controller-process-identity.js", async importOriginal => ({
  ...await importOriginal<typeof import("./controller-process-identity.js")>(),
  currentControllerBootId: () => boot.id,
}));

import { leaseReleaseRetryDueAt, nextLeaseReleaseBootIds, nextLeaseReleaseRetryAt,
  type LeaseReleaseDeferral } from "./environment-lease-release-deferral.js";

describe("lease release retry across live server boots", () => {
  function fail(previous: LeaseReleaseDeferral | null, now: number): LeaseReleaseDeferral {
    const attempts = (previous?.attempts ?? 0) + 1;
    return { reason: "release_failed", attempts, retryAt: nextLeaseReleaseRetryAt(previous, attempts, now),
      failingSince: previous?.failingSince ?? new Date(now).toISOString(), attemptedByBootIds: nextLeaseReleaseBootIds(previous),
      providerResourceDisposition: null };
  }

  function simulate(boots: string[]) {
    const start = Date.parse("2026-11-15T12:00:00Z");
    boot.id = boots[0]!;
    let deferral = fail(null, start);
    let attempts = 1;
    let latestRetryAt = Date.parse(deferral.retryAt);
    for (let minute = 1; minute <= 60; minute++) {
      const now = start + minute * 60_000;
      for (const id of [...boots].reverse()) {
        boot.id = id;
        if (leaseReleaseRetryDueAt(deferral, now) > now) continue;
        deferral = fail(deferral, now);
        attempts += 1;
        const retryAt = Date.parse(deferral.retryAt);
        expect(retryAt).toBeGreaterThanOrEqual(latestRetryAt);
        latestRetryAt = retryAt;
      }
    }
    return { deferral, attempts };
  }

  it("keeps the saved retry time for every live boot after each has made its first attempt", () => {
    const single = simulate(["boot-a"]);
    const overlapping = simulate(["boot-a", "boot-b"]);
    expect(overlapping.deferral.attemptedByBootIds).toEqual(["boot-a", "boot-b"]);
    expect(overlapping.attempts).toBeLessThanOrEqual(single.attempts + 1);
  });

  it("gives a restarted server one immediate attempt and keeps the boot list bounded", () => {
    const now = Date.parse("2026-11-15T12:00:00Z");
    let deferral: LeaseReleaseDeferral | null = null;
    for (let index = 0; index < 15; index++) {
      boot.id = `boot-${index}`;
      deferral = fail(deferral, now);
    }
    expect(deferral!.attemptedByBootIds).toHaveLength(10);
    boot.id = "boot-restarted";
    expect(leaseReleaseRetryDueAt(deferral!, now)).toBe(now);
    boot.id = "boot-14";
    expect(leaseReleaseRetryDueAt(deferral!, now)).toBe(Date.parse(deferral!.retryAt));
  });
});

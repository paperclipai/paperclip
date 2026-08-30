import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentAdapterType } from "@paperclipai/shared";
import {
  createDeviceLoginReaper,
  type LoginLeaseRef,
  type LoginSessionCleanupRuntime,
  type TaggedLease,
} from "../services/device-login-reaper.ts";
import {
  ADAPTER_AUTH_ACTIVE_STATUSES,
  type AdapterAuthReaperStore,
  type AdapterAuthSessionRow,
  type SandboxDeleteResult,
} from "../services/device-login-service.ts";

const ADAPTER_TYPE: AgentAdapterType = "codex_local";
const NOW = new Date("2026-02-01T00:05:00.000Z");
const PAST = new Date("2026-02-01T00:00:00.000Z");
const FUTURE = new Date("2026-02-01T01:00:00.000Z");

// An in-memory reaper store. The test seeds rows directly, so no database runs.
function createMemoryReaperStore(): AdapterAuthReaperStore & {
  seed(row: Partial<AdapterAuthSessionRow> & Pick<AdapterAuthSessionRow, "id">): AdapterAuthSessionRow;
} {
  const rows = new Map<string, AdapterAuthSessionRow>();
  const isActive = (status: AdapterAuthSessionRow["status"]) =>
    ADAPTER_AUTH_ACTIVE_STATUSES.includes(status);
  return {
    seed(input) {
      const row: AdapterAuthSessionRow = {
        id: input.id,
        companyId: input.companyId ?? randomUUID(),
        environmentId: input.environmentId ?? randomUUID(),
        adapterType: input.adapterType ?? ADAPTER_TYPE,
        startedByUserId: input.startedByUserId ?? "user-a",
        providerLeaseId: input.providerLeaseId ?? null,
        status: input.status ?? "starting",
        expiresAt: input.expiresAt ?? null,
        promotionExpiresAt: input.promotionExpiresAt ?? null,
        finishedAt: input.finishedAt ?? null,
        failureReason: input.failureReason ?? null,
      };
      rows.set(row.id, row);
      return row;
    },
    async listExpiredActiveSessions(now) {
      // Mirror the database scan: skip a `promoting` row that still holds a live
      // promotion claim, so the reaper never terminates a live credential write.
      return [...rows.values()].filter(
        (row) =>
          isActive(row.status) &&
          row.expiresAt != null &&
          row.expiresAt <= now &&
          (row.status !== "promoting" ||
            row.promotionExpiresAt == null ||
            row.promotionExpiresAt <= now),
      );
    },
    async listCleanupPendingSessions() {
      return [...rows.values()].filter((row) => row.status === "cleanup_pending");
    },
    async listLeaseReferences() {
      return [...rows.values()]
        .map((row) => row.providerLeaseId)
        .filter((value): value is string => value != null);
    },
    async setStatus(input) {
      const row = rows.get(input.sessionId);
      if (!row) return;
      row.status = input.status;
      if (input.failureReason !== undefined) row.failureReason = input.failureReason;
      if (input.finishedAt !== undefined) row.finishedAt = input.finishedAt;
      if (input.promotionExpiresAt !== undefined) row.promotionExpiresAt = input.promotionExpiresAt;
    },
    async compareAndSetStatus(input) {
      const row = rows.get(input.sessionId);
      if (!row || !input.expectedStatuses.includes(row.status)) return false;
      row.status = input.status;
      if (input.failureReason !== undefined) row.failureReason = input.failureReason;
      if (input.finishedAt !== undefined) row.finishedAt = input.finishedAt;
      if (input.promotionExpiresAt !== undefined) row.promotionExpiresAt = input.promotionExpiresAt;
      return true;
    },
    async get(sessionId) {
      const row = rows.get(sessionId);
      return row ? { ...row } : null;
    },
    async withCompanyAdapterPromotionLock(_companyId, _startedByUserId, _adapterType, fn) {
      // The in-memory store runs on a single event loop, so it needs no real
      // lock. The pass-through keeps the reaper contract satisfied.
      return fn();
    },
  };
}

interface FakeRuntimeOptions {
  tagged?: TaggedLease[];
  deleteImpl?: (ref: LoginLeaseRef) => Promise<SandboxDeleteResult>;
}

function createFakeRuntime(opts: FakeRuntimeOptions = {}) {
  const deleteCalls: LoginLeaseRef[] = [];
  const runtime: LoginSessionCleanupRuntime = {
    async deleteSandbox(ref) {
      deleteCalls.push(ref);
      if (opts.deleteImpl) return await opts.deleteImpl(ref);
      return { outcome: "deleted" };
    },
    async listTaggedLeases() {
      return opts.tagged ?? [];
    },
  };
  return { runtime, deleteCalls };
}

describe("device login reaper", () => {
  it("deletes the sandbox and marks a persisted expired non-terminal session timed_out", async () => {
    const store = createMemoryReaperStore();
    const environmentId = randomUUID();
    const seeded = store.seed({
      id: randomUUID(),
      environmentId,
      status: "waiting_for_user",
      providerLeaseId: "lease-1",
      expiresAt: PAST,
    });
    const { runtime, deleteCalls } = createFakeRuntime();
    const reaper = createDeviceLoginReaper({ store, runtime, now: () => NOW });

    const result = await reaper.sweep();

    expect(deleteCalls).toEqual([{ environmentId, providerLeaseId: "lease-1" }]);
    expect(result.expiredTimedOut).toBe(1);
    const row = await store.get(seeded.id);
    expect(row?.status).toBe("timed_out");
    expect(row?.finishedAt).not.toBeNull();
  });

  it("holds an unexpired active session and never deletes its sandbox", async () => {
    const store = createMemoryReaperStore();
    const seeded = store.seed({
      id: randomUUID(),
      status: "waiting_for_user",
      providerLeaseId: "lease-1",
      expiresAt: FUTURE,
    });
    const { runtime, deleteCalls } = createFakeRuntime();
    const reaper = createDeviceLoginReaper({ store, runtime, now: () => NOW });

    const result = await reaper.sweep();

    expect(deleteCalls).toHaveLength(0);
    expect(result.expiredTimedOut).toBe(0);
    expect((await store.get(seeded.id))?.status).toBe("waiting_for_user");
  });

  it("never terminates an expired promoting row that still holds a live claim", async () => {
    const store = createMemoryReaperStore();
    const seeded = store.seed({
      id: randomUUID(),
      status: "promoting",
      providerLeaseId: "lease-1",
      // The login window expired, but the promotion claim is still live.
      expiresAt: PAST,
      promotionExpiresAt: FUTURE,
    });
    const { runtime, deleteCalls } = createFakeRuntime();
    const reaper = createDeviceLoginReaper({ store, runtime, now: () => NOW });

    const result = await reaper.sweep();

    // The reaper leaves the live claim alone: no delete, no slot release.
    expect(deleteCalls).toHaveLength(0);
    expect(result.expiredTimedOut).toBe(0);
    expect((await store.get(seeded.id))?.status).toBe("promoting");
  });

  it("reclaims an expired promoting row after its promotion claim goes stale", async () => {
    const store = createMemoryReaperStore();
    const environmentId = randomUUID();
    const seeded = store.seed({
      id: randomUUID(),
      environmentId,
      status: "promoting",
      providerLeaseId: "lease-1",
      expiresAt: PAST,
      // The promotion claim deadline passed, so the claim is stale.
      promotionExpiresAt: PAST,
    });
    const { runtime, deleteCalls } = createFakeRuntime();
    const reaper = createDeviceLoginReaper({ store, runtime, now: () => NOW });

    const result = await reaper.sweep();

    // The stale claim is reclaimed: the reaper deletes the sandbox and times out.
    expect(deleteCalls).toEqual([{ environmentId, providerLeaseId: "lease-1" }]);
    expect(result.expiredTimedOut).toBe(1);
    expect((await store.get(seeded.id))?.status).toBe("timed_out");
  });

  it("marks an expired session with no lease reference timed_out without a delete", async () => {
    const store = createMemoryReaperStore();
    const seeded = store.seed({
      id: randomUUID(),
      status: "starting",
      providerLeaseId: null,
      expiresAt: PAST,
    });
    const { runtime, deleteCalls } = createFakeRuntime();
    const reaper = createDeviceLoginReaper({ store, runtime, now: () => NOW });

    const result = await reaper.sweep();

    expect(deleteCalls).toHaveLength(0);
    expect(result.expiredTimedOut).toBe(1);
    expect((await store.get(seeded.id))?.status).toBe("timed_out");
  });

  it("retries a cleanup_pending terminal session and clears it only on a provider not_found confirmation", async () => {
    const store = createMemoryReaperStore();
    const seeded = store.seed({
      id: randomUUID(),
      status: "cleanup_pending",
      providerLeaseId: "lease-1",
      // The encoding keeps the resolved terminal and the failure code.
      failureReason: "failed|login_command_failed",
      finishedAt: PAST,
    });
    let attempt = 0;
    const { runtime, deleteCalls } = createFakeRuntime({
      deleteImpl: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("provider delete rejected");
        return { outcome: "not_found" };
      },
    });
    const reaper = createDeviceLoginReaper({ store, runtime, now: () => NOW });

    // First sweep: the delete rejects, so the row stays cleanup_pending.
    const first = await reaper.sweep();
    expect(first.cleanupRetried).toBe(1);
    expect(first.cleanupCleared).toBe(0);
    expect(first.cleanupPendingRemaining).toBe(1);
    expect((await store.get(seeded.id))?.status).toBe("cleanup_pending");

    // Second sweep: the provider confirms with not_found, so the row clears to
    // the retained terminal public status.
    const second = await reaper.sweep();
    expect(second.cleanupRetried).toBe(1);
    expect(second.cleanupCleared).toBe(1);
    expect(second.cleanupPendingRemaining).toBe(0);
    expect(deleteCalls).toHaveLength(2);
    const row = await store.get(seeded.id);
    expect(row?.status).toBe("failed");
    expect(row?.failureReason).toBe("login_command_failed");
  });

  it("deletes a tagged lease that no live session references", async () => {
    const store = createMemoryReaperStore();
    const environmentId = randomUUID();
    // A live session references its own lease. The reaper never deletes it.
    store.seed({
      id: randomUUID(),
      environmentId,
      status: "waiting_for_user",
      providerLeaseId: "linked-1",
      expiresAt: FUTURE,
    });
    const { runtime, deleteCalls } = createFakeRuntime({
      tagged: [
        { environmentId, providerLeaseId: "linked-1", sessionId: "linked-session" },
        { environmentId, providerLeaseId: "orphan-1", sessionId: "orphan-session" },
      ],
    });
    const reaper = createDeviceLoginReaper({ store, runtime, now: () => NOW });

    const result = await reaper.sweep();

    // Only the orphan lease is deleted; the referenced lease is untouched.
    expect(deleteCalls).toEqual([{ environmentId, providerLeaseId: "orphan-1" }]);
    expect(result.orphanLeasesDeleted).toBe(1);
  });

  it("keeps retrying an orphan tagged lease when its delete fails", async () => {
    const store = createMemoryReaperStore();
    const environmentId = randomUUID();
    let attempt = 0;
    const { runtime, deleteCalls } = createFakeRuntime({
      tagged: [{ environmentId, providerLeaseId: "orphan-1", sessionId: "orphan-session" }],
      deleteImpl: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("provider delete rejected");
        return { outcome: "deleted" };
      },
    });
    const reaper = createDeviceLoginReaper({ store, runtime, now: () => NOW });

    const first = await reaper.sweep();
    expect(first.orphanLeasesDeleted).toBe(0);

    const second = await reaper.sweep();
    expect(second.orphanLeasesDeleted).toBe(1);
    expect(deleteCalls).toHaveLength(2);
  });

  it("does not throw on a second sweep over an already-deleted sandbox", async () => {
    const store = createMemoryReaperStore();
    const environmentId = randomUUID();
    store.seed({
      id: randomUUID(),
      environmentId,
      status: "waiting_for_user",
      providerLeaseId: "lease-1",
      expiresAt: PAST,
    });
    // The delete is idempotent: an already-gone sandbox returns not_found.
    const { runtime } = createFakeRuntime({
      tagged: [{ environmentId, providerLeaseId: "orphan-1", sessionId: "orphan-session" }],
      deleteImpl: async () => ({ outcome: "not_found" }),
    });
    const reaper = createDeviceLoginReaper({ store, runtime, now: () => NOW });

    await expect(reaper.sweep()).resolves.toBeDefined();
    // The second sweep runs over the now-terminal session and the same orphan
    // lease. A repeated delete does not throw.
    await expect(reaper.sweep()).resolves.toBeDefined();
  });
});

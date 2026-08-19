import { describe, expect, it } from "vitest";
import { createSetupTokenReaper } from "./setup-token-reaper.js";
import {
  isTerminalSessionState,
  type SetupTokenCleanupIdentity,
  type SetupTokenCleanupRecord,
} from "./setup-token-session.js";

const NOW = 5_000;

// An in-memory reaper store. The test seeds records directly, so no database
// runs. The `listReapable` predicate mirrors the production store: a record is
// reapable when its session is terminal, its deadline is past, or its claim is
// already consumed.
function createMemoryStore() {
  const rows = new Map<string, SetupTokenCleanupRecord>();
  const matches = (row: SetupTokenCleanupRecord, identity: SetupTokenCleanupIdentity) =>
    row.companyId === identity.companyId &&
    row.ownerUserId === identity.ownerUserId &&
    row.adapterType === identity.adapterType;
  return {
    rows,
    seed(record: Partial<SetupTokenCleanupRecord> & Pick<SetupTokenCleanupRecord, "sessionId" | "leaseId">) {
      const row: SetupTokenCleanupRecord = {
        sessionId: record.sessionId,
        companyId: record.companyId ?? "company-1",
        ownerUserId: record.ownerUserId ?? "user-1",
        adapterType: record.adapterType ?? "claude_local",
        environmentId: record.environmentId ?? "env-1",
        leaseId: record.leaseId,
        deadline: record.deadline ?? 1_000,
        state: record.state ?? "failed",
        boundAt: record.boundAt ?? null,
      };
      rows.set(row.sessionId, row);
      return row;
    },
    async listReapable(now: number): Promise<SetupTokenCleanupRecord[]> {
      return [...rows.values()].filter(
        (row) => isTerminalSessionState(row.state) || row.deadline <= now || row.boundAt !== null,
      );
    },
    async remove(identity: SetupTokenCleanupIdentity): Promise<void> {
      const row = rows.get(identity.sessionId);
      if (row && matches(row, identity)) rows.delete(identity.sessionId);
    },
  };
}

interface FakeLeasesOptions {
  releaseImpl?: (leaseId: string) => Promise<void>;
}

function createFakeLeases(opts: FakeLeasesOptions = {}) {
  const releaseByIdCalls: string[] = [];
  return {
    releaseByIdCalls,
    async releaseById(leaseId: string): Promise<void> {
      releaseByIdCalls.push(leaseId);
      if (opts.releaseImpl) await opts.releaseImpl(leaseId);
    },
  };
}

describe("setup-token reaper", () => {
  it("releases the lease and removes the record for a reapable session", async () => {
    // A prior process crashed with a live record and a lease.
    const store = createMemoryStore();
    store.seed({ sessionId: "orphan-1", leaseId: "lease-orphan", state: "awaiting_code", deadline: 1_000 });
    const leases = createFakeLeases();
    const reaper = createSetupTokenReaper({ store, leases, now: () => NOW });

    const result = await reaper.sweep();

    expect(result.released).toBe(1);
    expect(result.failed).toBe(0);
    expect(leases.releaseByIdCalls).toEqual(["lease-orphan"]);
    expect(store.rows.size).toBe(0);
  });

  it("holds a live, unexpired, unconsumed record and never releases its lease", async () => {
    const store = createMemoryStore();
    store.seed({
      sessionId: "live-1",
      leaseId: "lease-live",
      state: "awaiting_code",
      // The deadline is in the future and the claim is not consumed.
      deadline: NOW + 60_000,
      boundAt: null,
    });
    const leases = createFakeLeases();
    const reaper = createSetupTokenReaper({ store, leases, now: () => NOW });

    const result = await reaper.sweep();

    expect(result.released).toBe(0);
    expect(leases.releaseByIdCalls).toHaveLength(0);
    expect(store.rows.has("live-1")).toBe(true);
  });

  it("keeps the record when the release fails, then clears it on the next sweep", async () => {
    const store = createMemoryStore();
    store.seed({ sessionId: "orphan-2", leaseId: "lease-orphan-2", state: "failed" });
    let attempt = 0;
    const leases = createFakeLeases({
      releaseImpl: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("provider down");
      },
    });
    const reaper = createSetupTokenReaper({ store, leases, now: () => NOW });

    // First sweep: the release rejects, so the record stays for a retry.
    const first = await reaper.sweep();
    expect(first.released).toBe(0);
    expect(first.failed).toBe(1);
    expect(store.rows.has("orphan-2")).toBe(true);

    // Second sweep: the release confirms, so the record clears.
    const second = await reaper.sweep();
    expect(second.released).toBe(1);
    expect(second.failed).toBe(0);
    expect(leases.releaseByIdCalls).toEqual(["lease-orphan-2", "lease-orphan-2"]);
    expect(store.rows.size).toBe(0);
  });

  it("reaps every reapable record in one sweep and stays idempotent on the next", async () => {
    const store = createMemoryStore();
    store.seed({ sessionId: "orphan-a", leaseId: "lease-a", state: "failed" });
    store.seed({ sessionId: "orphan-b", leaseId: "lease-b", state: "cancelled" });
    // A consumed stored claim is reapable through the bound marker.
    store.seed({ sessionId: "orphan-c", leaseId: "lease-c", state: "stored", deadline: NOW + 60_000, boundAt: 4_000 });
    const leases = createFakeLeases();
    const reaper = createSetupTokenReaper({ store, leases, now: () => NOW });

    const first = await reaper.sweep();
    expect(first.released).toBe(3);
    expect(store.rows.size).toBe(0);

    // The interval sweep runs over the now-empty store without an error.
    const second = await reaper.sweep();
    expect(second.released).toBe(0);
    expect(second.failed).toBe(0);
  });
});

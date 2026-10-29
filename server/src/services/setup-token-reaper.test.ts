import { describe, expect, it } from "vitest";
import { createSetupTokenReaper } from "./setup-token-reaper.js";
import {
  SETUP_TOKEN_REAP_MAX_ATTEMPTS,
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
    let clock = NOW;
    const reaper = createSetupTokenReaper({ store, leases, now: () => clock });

    // First sweep: the release rejects, so the record stays for a retry.
    const first = await reaper.sweep();
    expect(first.released).toBe(0);
    expect(first.failed).toBe(1);
    expect(store.rows.has("orphan-2")).toBe(true);

    // Second sweep, after the backoff: the release confirms, so the record clears.
    clock += 60_000;
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
  it("clears a record that has no lease without a release call", async () => {
    // A record with an empty lease id has nothing to release. The old sweep called
    // the release with an empty id, which always failed.
    const store = createMemoryStore();
    store.seed({ sessionId: "no-lease", leaseId: "", state: "cancelled" });
    const leases = createFakeLeases();
    const reaper = createSetupTokenReaper({ store, leases, now: () => NOW });

    const result = await reaper.sweep();

    expect(result).toEqual({ released: 1, failed: 0, deferred: 0 });
    expect(leases.releaseByIdCalls).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  it("logs the release error, backs off, and stops retrying a release that never succeeds", async () => {
    const store = createMemoryStore();
    store.seed({ sessionId: "stuck-1", leaseId: "lease-stuck", state: "failed" });
    const leases = createFakeLeases({
      releaseImpl: async () => {
        throw new Error("driver cannot reach the sandbox");
      },
    });
    const lines: string[] = [];
    let clock = NOW;
    const reaper = createSetupTokenReaper({ store, leases, now: () => clock, log: (line) => lines.push(line) });

    // The sweep inside the backoff window does not try the record again.
    expect(await reaper.sweep()).toEqual({ released: 0, failed: 1, deferred: 0 });
    expect(await reaper.sweep()).toEqual({ released: 0, failed: 0, deferred: 1 });
    expect(leases.releaseByIdCalls).toHaveLength(1);

    for (let attempt = 2; attempt <= SETUP_TOKEN_REAP_MAX_ATTEMPTS; attempt += 1) {
      clock += 60_000 * 2 ** (attempt - 2);
      expect(await reaper.sweep()).toEqual({ released: 0, failed: 1, deferred: 0 });
    }
    expect(leases.releaseByIdCalls).toHaveLength(SETUP_TOKEN_REAP_MAX_ATTEMPTS);

    // After the cap the record stays in the store but the reaper never tries it again.
    clock += 24 * 60 * 60_000;
    expect(await reaper.sweep()).toEqual({ released: 0, failed: 0, deferred: 1 });
    expect(leases.releaseByIdCalls).toHaveLength(SETUP_TOKEN_REAP_MAX_ATTEMPTS);
    expect(store.rows.has("stuck-1")).toBe(true);

    // One log line for each real attempt, with the real error and the ids.
    expect(lines).toHaveLength(SETUP_TOKEN_REAP_MAX_ATTEMPTS);
    expect(lines[0]).toContain("driver cannot reach the sandbox");
    expect(lines[0]).toContain("lease-stuck");
    expect(lines[0]).toContain("stuck-1");
    expect(lines[SETUP_TOKEN_REAP_MAX_ATTEMPTS - 1]).toContain("stops retrying");
  });

  it("forgets the retry state of a record that left the store", async () => {
    const store = createMemoryStore();
    store.seed({ sessionId: "gone-1", leaseId: "lease-gone", state: "failed" });
    let fail = true;
    const leases = createFakeLeases({
      releaseImpl: async () => {
        if (fail) throw new Error("provider down");
      },
    });
    let clock = NOW;
    const reaper = createSetupTokenReaper({ store, leases, now: () => clock });

    await reaper.sweep();
    store.rows.clear();
    await reaper.sweep();
    // A new record that reuses the id starts with a fresh attempt count.
    store.seed({ sessionId: "gone-1", leaseId: "lease-gone", state: "failed" });
    fail = false;
    expect(await reaper.sweep()).toEqual({ released: 1, failed: 0, deferred: 0 });
  });
});

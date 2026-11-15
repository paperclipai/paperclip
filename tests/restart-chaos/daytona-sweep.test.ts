import { describe, expect, it } from "vitest";
import {
  assertHarnessMayMutate, daytonaRestDelete, DaytonaWaveSweeper, isProtectedSandbox, leaksForTask, readOnlyDaytona, reconcileSandboxes, selectWaveSandboxes,
  PENDING_CLEANUP_RETRY_MS, R6_SETTLE_MS, SANDBOX_DELETE_MIN_TIMEOUT_MS, sweepHasLeaks, unattributedLeaks, type DaytonaSandboxRow, type DaytonaSweepResult,
} from "./daytona-sweep.js";
import { ENVIRONMENT_CLEANUP_RETRY_MS } from "../../server/src/services/environment-cleanup-state.js";
import { gradeWarmShutdown } from "./warm-shutdown.js";

describe("R6 settle window", () => {
  it("covers the product's pending-cleanup retry backoff plus a sweep, capped at 8 minutes", () => {
    expect(PENDING_CLEANUP_RETRY_MS).toBe(ENVIRONMENT_CLEANUP_RETRY_MS);
    expect(R6_SETTLE_MS).toBeGreaterThan(ENVIRONMENT_CLEANUP_RETRY_MS);
    expect(R6_SETTLE_MS).toBeLessThanOrEqual(8 * 60_000);
  });
});

describe("cleanup through Paperclip", () => {
  const COMPANY = "11111111-1111-4111-8111-111111111111";
  const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
  const OTHER_COMPANY = "33333333-3333-4333-8333-333333333333";
  const listing = { list: () => (async function* () {})() };

  it("treats a 409 pending-cleanup environment delete as blocked, not a harness error, and retries it", async () => {
    let calls = 0;
    const api = { delete: async () => { calls += 1; throw new Error(`DELETE /api/environments/${ENVIRONMENT} returned 409: {"error":"Cannot delete this environment while a sandbox cleanup is pending."}`); } };
    const sweeper = new DaytonaWaveSweeper({ apiKey: "unused", companyId: COMPANY, environmentId: ENVIRONMENT, api: api as never });
    (sweeper as unknown as { client: unknown }).client = readOnlyDaytona(listing);
    const result = await sweeper.cleanUp(0, 4_000);
    expect(result).toMatchObject({ environmentDeleted: false, errors: [], remainingSandboxes: [] });
    expect(result.environmentDeleteBlocked).toMatch(/409/);
    expect(calls).toBeGreaterThan(1);
  });

  const waveRows = (states: string[], extra: Partial<DaytonaSandboxRow> = {}): DaytonaSandboxRow[] => states.map(state =>
    ({ id: state, name: `paperclip-create-${state}`, state, labels: { "paperclip-company-id": COMPANY, "paperclip-environment-id": ENVIRONMENT }, ...extra }));
  const deletingDaytona = (rows: DaytonaSandboxRow[]) => {
    const removed: string[] = [];
    const client = readOnlyDaytona({ list: () => (async function* () { yield* rows.map(row => ({ ...row })); })() });
    const removeSandbox = async (id: string) => {
      removed.push(id);
      const row = rows.find(candidate => candidate.id === id);
      if (row) row.state = "destroyed";
    };
    return { client, removeSandbox, removed };
  };

  it("deletes the wave's archived setup sandboxes and every other sandbox carrying both wave labels, and leaves nothing behind", async () => {
    const rows = [...waveRows(["started", "archiving", "archived", "destroyed"]),
      { id: "fleet", name: "paperclip-create-fleet", state: "archived", labels: { "paperclip-company-id": OTHER_COMPANY, "paperclip-environment-id": ENVIRONMENT } },
      { id: "other-env", name: "paperclip-create-x", state: "archived", labels: { "paperclip-company-id": COMPANY, "paperclip-environment-id": OTHER_COMPANY } }];
    const { client, removeSandbox, removed } = deletingDaytona(rows);
    const sweeper = new DaytonaWaveSweeper({ apiKey: "unused", companyId: COMPANY, environmentId: ENVIRONMENT, api: { delete: async () => undefined } as never, removeSandbox });
    (sweeper as unknown as { client: unknown }).client = client;
    const result = await sweeper.cleanUp(0, 1_000);
    expect(result.remainingSandboxes).toEqual(["started:started"]);
    expect(result.archivedSandboxes).toEqual(["archiving:archiving", "archived:archived"]);
    expect(removed.sort()).toEqual(["archived", "archiving", "started"]);
    expect(result.deletedSandboxes.sort()).toEqual(["archived:archived", "archiving:archiving", "started:started"]);
    expect(result.undeletedSandboxes).toEqual([]);
    expect(rows.find(row => row.id === "fleet")!.state).toBe("archived");
    expect(rows.find(row => row.id === "other-env")!.state).toBe("archived");
  });

  it("fails cleanup when a wave sandbox survives deletion, and never deletes a fleet snapshot even with the wave's labels", async () => {
    const rows = [...waveRows(["archived"]), ...waveRows(["fleet"], { snapshot: "fleet-sbx-9", state: "archived" })];
    const { client, removeSandbox, removed } = deletingDaytona(rows);
    const sweeper = new DaytonaWaveSweeper({ apiKey: "unused", companyId: COMPANY, environmentId: ENVIRONMENT, api: { delete: async () => undefined } as never, removeSandbox });
    (sweeper as unknown as { client: unknown }).client = client;
    const result = await sweeper.cleanUp(0, 1_000);
    expect(removed).toEqual(["archived"]);
    expect(result.undeletedSandboxes).toEqual(["fleet:archived"]);
    expect(result.errors.join(" ")).toMatch(/sandbox delete fleet: Refusing to change protected/);
    expect(gradeWarmShutdown({ cleanup: result, serverLog: "" })).toMatchObject({ verdict: "fail", leakedSandboxes: ["fleet:archived"] });
  });

  it("sends the Daytona delete for one sandbox id with the wave's key", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const remove = daytonaRestDelete("key-1", "https://daytona.test/api", (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: url.endsWith("gone") ? 404 : url.endsWith("bad") ? 500 : 200 });
    }) as typeof fetch);
    const signal = new AbortController().signal;
    await remove("abc", signal);
    await remove("gone", signal);
    await expect(remove("bad", signal)).rejects.toThrow(/returned 500/);
    expect(calls[0]).toEqual({ url: "https://daytona.test/api/sandbox/abc", init: { method: "DELETE", headers: { Authorization: "Bearer key-1" }, signal } });
  });

  it("aborts a hung delete at the cleanup deadline and reports the sandbox as left", async () => {
    const rows = waveRows(["archived"]);
    const client = readOnlyDaytona({ list: () => (async function* () { yield* rows.map(row => ({ ...row })); })() });
    const removeSandbox = (_id: string, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("delete aborted")), { once: true });
    });
    const sweeper = new DaytonaWaveSweeper({ apiKey: "unused", companyId: COMPANY, environmentId: ENVIRONMENT, api: { delete: async () => undefined } as never, removeSandbox });
    (sweeper as unknown as { client: unknown }).client = client;
    const started = Date.now();
    const result = await sweeper.cleanUp(0, 1_000);
    expect(Date.now() - started).toBeLessThan(SANDBOX_DELETE_MIN_TIMEOUT_MS + 3_000);
    expect(result.undeletedSandboxes).toEqual(["archived:archived"]);
    expect(result.errors.join(" ")).toMatch(/sandbox delete archived: delete aborted/);
  });

  it("reports other environment delete failures as errors", async () => {
    const api = { delete: async () => { throw new Error("DELETE returned 500: boom"); } };
    const sweeper = new DaytonaWaveSweeper({ apiKey: "unused", companyId: COMPANY, environmentId: ENVIRONMENT, api: api as never });
    (sweeper as unknown as { client: unknown }).client = readOnlyDaytona(listing);
    const result = await sweeper.cleanUp(0, 1_000);
    expect(result.environmentDeleteBlocked).toBeNull();
    expect(result.errors.join(" ")).toMatch(/environment delete: .*500/);
  });
});

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const wave = { companyId: COMPANY, environmentId: ENVIRONMENT };
const labelled = (id: string, labels: Record<string, string> = {}, extra: Partial<DaytonaSandboxRow> = {}): DaytonaSandboxRow =>
  ({ id, state: "started", labels, ...extra });

describe("wave sandbox selection is read-only and exact", () => {
  const rows = [
    labelled("mine", { "paperclip-company-id": COMPANY, "paperclip-environment-id": ENVIRONMENT }),
    labelled("unlabelled"),
    labelled("other-environment", { "paperclip-company-id": COMPANY, "paperclip-environment-id": OTHER }),
    labelled("other-company", { "paperclip-company-id": OTHER, "paperclip-environment-id": ENVIRONMENT }),
    labelled("company-only", { "paperclip-company-id": COMPANY }),
    labelled("fleet", { "paperclip-company-id": OTHER }, { name: "paperclip-create-abc", snapshot: "fleet-sbx-1" }),
  ];

  it("selects only sandboxes carrying both of the wave's UUID labels", () => {
    expect(selectWaveSandboxes(rows, wave).map(row => row.id)).toEqual(["mine"]);
    expect(() => selectWaveSandboxes(rows, { companyId: "", environmentId: "" })).toThrow(/UUIDs/);
  });

  it("re-checks rows even when the provider ignores the label filter", async () => {
    const queries: unknown[] = [];
    const sweeper = new DaytonaWaveSweeper({ apiKey: "unused", ...wave, api: {} as never });
    (sweeper as unknown as { client: unknown }).client = readOnlyDaytona({ list: query => {
      queries.push(query);
      return (async function* () { yield* rows; })();
    } });
    expect((await sweeper.listWaveSandboxes()).map(row => row.id)).toEqual(["mine"]);
    expect(queries).toEqual([{ labels: { "paperclip-company-id": COMPANY, "paperclip-environment-id": ENVIRONMENT } }]);
  });

  it("exposes no mutating Daytona operation", () => {
    const client = readOnlyDaytona({ list: () => (async function* () {})(), delete: () => undefined, stop: () => undefined } as never);
    expect(Object.keys(client)).toEqual(["list"]);
    expect(Object.isFrozen(client)).toBe(true);
    expect(() => readOnlyDaytona({} as never)).toThrow(/no list\(\)/);
  });

  it("hard-refuses fleet snapshots and anything not labelled for the wave; a plugin-created name with the wave's labels is the wave's own", () => {
    const waveLabels = { "paperclip-company-id": COMPANY, "paperclip-environment-id": ENVIRONMENT };
    expect(isProtectedSandbox({ name: "x", snapshot: "fleet-sbx-2" })).toBe(true);
    expect(() => assertHarnessMayMutate(labelled("b", waveLabels, { name: "probe", snapshot: "fleet-sbx-2" }), wave)).toThrow(/protected/);
    expect(() => assertHarnessMayMutate(labelled("c", {}, { name: "probe" }), wave)).toThrow(/not labelled for this wave/);
    expect(() => assertHarnessMayMutate(labelled("e", { "paperclip-company-id": OTHER }, { name: "paperclip-create-1" }), wave)).toThrow(/not labelled for this wave/);
    expect(() => assertHarnessMayMutate(labelled("a", waveLabels, { name: "paperclip-create-1" }), wave)).not.toThrow();
    expect(() => assertHarnessMayMutate(labelled("d", waveLabels, { name: "probe" }), wave)).not.toThrow();
  });
});

describe("Daytona R6 reconciliation", () => {
  const base = { companyId: "c", environmentId: "e", checkedAt: "now", error: null };

  it("accepts live sandboxes backed by held leases and ignores destroyed ones", () => {
    const result = reconcileSandboxes(
      [{ id: "s1", state: "started" }, { id: "s2", state: "destroyed" }, { id: "s3", state: "stopped" }],
      [{ id: "l1", status: "retained", providerLeaseId: "s1", heartbeatRunId: "r1" },
        { id: "l3", status: "released", providerLeaseId: "s3", heartbeatRunId: "r3" }],
    );
    expect(result.liveSandboxes).toEqual(["s1", "s3"]);
    expect(result.orphanSandboxes).toEqual([expect.objectContaining({ sandboxId: "s3", leaseStatus: "released" })]);
    expect(result.heldLeases).toEqual([]);
    expect(result.retainedLeases.map(lease => lease.leaseId)).toEqual(["l1"]);
  });

  it("treats an archive behind a released lease as expected, but not a running one or one without a lease", () => {
    const result = reconcileSandboxes(
      [{ id: "a1", state: "archived" }, { id: "a2", state: "started" }, { id: "a3", state: "archived" }],
      [{ id: "l1", status: "released", providerLeaseId: "a1" }, { id: "l2", status: "released", providerLeaseId: "a2" }],
    );
    expect(result.archivedSandboxes).toEqual(["a1"]);
    expect(result.orphanSandboxes.map(leak => leak.sandboxId)).toEqual(["a2", "a3"]);
  });


  it("keeps a stopped sandbox behind a released reusable lease for reuse, but not a running one or an ephemeral one", () => {
    const result = reconcileSandboxes(
      [{ id: "r1", state: "stopped" }, { id: "r2", state: "started" }, { id: "e1", state: "stopped" }],
      [{ id: "l1", status: "released", leasePolicy: "reuse_by_environment", providerLeaseId: "r1" },
        { id: "l2", status: "released", leasePolicy: "reuse_by_environment", providerLeaseId: "r2" },
        { id: "l3", status: "released", leasePolicy: "ephemeral", providerLeaseId: "e1" }],
    );
    expect(result.retainedLeases.map(lease => lease.leaseId)).toEqual(["l1"]);
    expect(result.orphanSandboxes.map(leak => leak.sandboxId)).toEqual(["r2", "e1"]);
  });

  it("keeps a stopped restore source (retain_on_failure) as retained, but not a running one or one with no lease", () => {
    const result = reconcileSandboxes(
      [{ id: "s1", state: "stopped" }, { id: "s2", state: "started" }, { id: "s3", state: "stopped" }],
      [{ id: "f1", status: "released", leasePolicy: "retain_on_failure", providerLeaseId: "s1" },
        { id: "f2", status: "released", leasePolicy: "retain_on_failure", providerLeaseId: "s2" }],
    );
    expect(result.retainedLeases.map(lease => lease.leaseId)).toEqual(["f1"]);
    // Running, or left behind by a deleted environment (no lease): still leaks.
    expect(result.orphanSandboxes.map(leak => leak.sandboxId)).toEqual(["s2", "s3"]);
  });

  it("judges a reused sandbox by its current lease row, whatever the listing order", () => {
    const rows = [{ id: "old", status: "expired", leasePolicy: "reuse_by_environment", providerLeaseId: "r1" },
      { id: "new", status: "released", leasePolicy: "reuse_by_environment", providerLeaseId: "r1" }];
    for (const leases of [rows, [...rows].reverse()]) {
      const result = reconcileSandboxes([{ id: "r1", state: "stopped" }], leases);
      expect(result.orphanSandboxes).toEqual([]);
      expect(result.retainedLeases.map(lease => lease.leaseId)).toEqual(["new"]);
    }
  });

  it("reports sandboxes with no lease and leases still active at rest", () => {
    const result = reconcileSandboxes(
      [{ id: "s9", state: "started", labels: { "paperclip-run-id": "r9" } }, { id: "s1", state: "started" }],
      [{ id: "l1", status: "active", providerLeaseId: "s1", heartbeatRunId: "r1", issueId: "i1" }],
    );
    expect(result.orphanSandboxes).toEqual([expect.objectContaining({ sandboxId: "s9", runId: "r9", reason: "no lease references this sandbox" })]);
    expect(result.heldLeases).toEqual([expect.objectContaining({ leaseId: "l1", status: "active" })]);
  });

  it("attributes leaks to the task that owns the run or issue; the rest stay wave-level", () => {
    const sweep: DaytonaSweepResult = { ...base, liveSandboxes: ["s9", "s1", "s5"], retainedLeases: [], archivedSandboxes: [],
      orphanSandboxes: [{ sandboxId: "s9", state: "started", runId: "r9", leaseId: null, leaseStatus: null, reason: "x" },
        { sandboxId: "s5", state: "started", runId: null, leaseId: null, leaseStatus: null, reason: "x" }],
      heldLeases: [{ leaseId: "l1", status: "active", providerLeaseId: "s1", runId: null, issueId: "i1" }] };
    const task = leaksForTask(sweep, new Set(["r9"]), "i1");
    expect(task).toEqual(["orphan_sandbox=s9", "active_lease=l1"]);
    expect(unattributedLeaks(sweep, new Set(task))).toEqual(["orphan_sandbox=s5"]);
    expect(sweepHasLeaks(sweep)).toBe(true);
    expect(sweepHasLeaks({ ...sweep, orphanSandboxes: [], heldLeases: [] })).toBe(false);
  });
});

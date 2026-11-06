import { describe, expect, it } from "vitest";
import {
  assertHarnessMayMutate, DaytonaWaveSweeper, isProtectedSandbox, leaksForTask, readOnlyDaytona, reconcileSandboxes, selectWaveSandboxes,
  sweepHasLeaks, unattributedLeaks, type DaytonaSandboxRow, type DaytonaSweepResult,
} from "./daytona-sweep.js";

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

  it("hard-refuses fleet sandboxes and anything not labelled for the wave, even with matching labels", () => {
    const waveLabels = { "paperclip-company-id": COMPANY, "paperclip-environment-id": ENVIRONMENT };
    expect(isProtectedSandbox({ name: "paperclip-create-1" })).toBe(true);
    expect(isProtectedSandbox({ name: "x", snapshot: "fleet-sbx-2" })).toBe(true);
    expect(() => assertHarnessMayMutate(labelled("a", waveLabels, { name: "paperclip-create-1" }), wave)).toThrow(/protected/);
    expect(() => assertHarnessMayMutate(labelled("b", waveLabels, { name: "probe", snapshot: "fleet-sbx-2" }), wave)).toThrow(/protected/);
    expect(() => assertHarnessMayMutate(labelled("c", {}, { name: "probe" }), wave)).toThrow(/not labelled for this wave/);
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { legacyControllerBootId, legacyControllerClaim } from "../legacy-controller-lease.js";
import { legacySourceProcessSettled, recordLegacyProcessSettlement, type LegacyProcessSettlementSource } from "./legacy-process-settlement.js";
const { pendingCleanup } = vi.hoisted(() => ({ pendingCleanup: vi.fn() }));
vi.mock("../execution-blocker.js", () => ({ hasPendingRunCleanup: pendingCleanup }));
const startedAt = new Date("2099-01-01T00:00:00Z"), finishedAt = new Date("2099-01-01T00:00:01Z");
function source() {
  return { id: "run", companyId: "company", agentId: "agent", runtimeMode: "legacy", status: "failed",
    controllerBootId: legacyControllerBootId, controllerLeaseExpiresAt: null, processPid: 42, processGroupId: 42,
    processStartedAt: startedAt, finishedAt, legacyProcessSettlement: { schema: "paperclip.legacy-process-settlement.v1",
      runId: "run", companyId: "company", agentId: "agent", runtimeMode: "legacy", targetKind: "local",
      controllerBootId: legacyControllerBootId, processPid: 42, processGroupId: 42,
      processStartedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), status: "failed" } } satisfies LegacyProcessSettlementSource;
}
function database(row: LegacyProcessSettlementSource | null, failure?: Error) {
  const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: async () => {
    if (failure) throw failure; return [{ id: row!.id }];
  } })) })) }));
  const query = { from: () => query, where: () => query, for: async () => row ? [row] : [] };
  const tx = { select: () => query, update };
  const db = { transaction: async (run: (tx: unknown) => unknown) => run(tx) } as unknown as Db;
  return { db, update };
}
describe("host-owned legacy process settlement", () => {
  beforeEach(() => { pendingCleanup.mockReset(); pendingCleanup.mockResolvedValue(false); });
  it("binds every receipt field to the exact retained local process identity", () => {
    const run = source(); expect(legacySourceProcessSettled(run)).toBe(true);
    for (const [key, value] of Object.entries(run.legacyProcessSettlement!)) {
      expect(legacySourceProcessSettled({ ...run, legacyProcessSettlement: { ...run.legacyProcessSettlement, [key]: typeof value === "number" ? value + 1 : "foreign" } })).toBe(false);
    }
    for (const value of [null, [], {}, true, "closed", { ...run.legacyProcessSettlement, processPid: "42" },
      { ...run.legacyProcessSettlement, extra: true }, { ...run.legacyProcessSettlement, processPid: {} }])
      expect(legacySourceProcessSettled({ ...run, legacyProcessSettlement: value })).toBe(false);
    for (const patch of [{ controllerLeaseExpiresAt: new Date(0) }, { controllerLeaseExpiresAt: new Date("2199-01-01") },
      { controllerBootId: "new-claim" }, { processPid: 43 }, { processGroupId: 43 }, { processStartedAt: new Date(0) },
      { finishedAt: new Date(0) }, { processPid: null }, { processGroupId: null }, { processStartedAt: null },
      { runtimeMode: "native" }, { status: "cancelled" }, { status: "running" }])
      expect(legacySourceProcessSettled({ ...run, ...patch })).toBe(false);
  });
  it("keeps the never-launched branch closed and rejects stale or partial evidence", () => {
    const run = { ...source(), processPid: null, processGroupId: null, processStartedAt: null,
      controllerBootId: null, legacyProcessSettlement: null };
    expect(legacySourceProcessSettled(run)).toBe(true);
    expect(legacySourceProcessSettled({ ...run, controllerBootId: legacyControllerBootId })).toBe(false);
    expect(legacySourceProcessSettled({ ...run, legacyProcessSettlement: source().legacyProcessSettlement })).toBe(false);
  });
  it("persists only after the current owner fence and cleanup obligations settle", async () => {
    const run = source(), saved = database(run);
    expect(await recordLegacyProcessSettlement(saved.db, run, () => true)).toBe(true);
    expect(saved.update).toHaveBeenCalledTimes(1);
    pendingCleanup.mockResolvedValue(true); const pending = database(run);
    expect(await recordLegacyProcessSettlement(pending.db, run, () => true)).toBe(false);
    expect(pending.update).not.toHaveBeenCalled();
    pendingCleanup.mockResolvedValue(false);
    const held = database(run); let checks = 0;
    expect(await recordLegacyProcessSettlement(held.db, run, () => ++checks === 1)).toBe(false);
    expect(held.update).not.toHaveBeenCalled();
    expect(await recordLegacyProcessSettlement(database(null).db, run, () => true)).toBe(false);
  });
  it("clears a prior receipt on the normal legacy claim", () => {
    expect(legacyControllerClaim("legacy")).toMatchObject({ legacyProcessSettlement: null });
  });
  it("does not turn failed optional proof persistence into a certificate", async () => {
    const run = { ...source(), legacyProcessSettlement: null }, failed = database(run, new Error("receipt write failed"));
    await expect(recordLegacyProcessSettlement(failed.db, run, () => true)).rejects.toThrow("receipt write failed");
    expect(legacySourceProcessSettled(run)).toBe(false);
    expect(await recordLegacyProcessSettlement(failed.db, run, () => false)).toBe(false);
  });
});

describe("claimed preparation host settlement", () => {
  function preparing() {
    return { ...source(), processPid: null, processGroupId: null, processStartedAt: null,
      startedAt, executionStage: "preparing", legacyProcessSettlement: null as unknown };
  }
  function proof() {
    const run = preparing();
    return { schema: "paperclip.legacy-preparation-settlement.v1", runId: run.id, companyId: run.companyId, agentId: run.agentId,
      runtimeMode: "legacy", targetKind: "not-dispatched", adapterDispatched: false, controllerBootId: run.controllerBootId,
      processPid: null, processGroupId: null, processStartedAt: null, executionStage: "preparing",
      startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), status: "failed" };
  }
  it("requires exact positive host proof for a claimed source with no process metadata", () => {
    const run = preparing(); expect(legacySourceProcessSettled(run)).toBe(false);
    expect(legacySourceProcessSettled({ ...run, legacyProcessSettlement: proof() })).toBe(true);
    for (const value of [null, {}, [], "bootstrap", source().legacyProcessSettlement, { ...proof(), extra: true }])
      expect(legacySourceProcessSettled({ ...run, legacyProcessSettlement: value })).toBe(false);
  });
  it("binds no-dispatch proof to every claimed generation and refuses current dispatch or process ownership", () => {
    const run = { ...preparing(), legacyProcessSettlement: proof() };
    for (const [key, value] of Object.entries(proof()))
      expect(legacySourceProcessSettled({ ...run, legacyProcessSettlement: { ...proof(), [key]: typeof value === "boolean" ? true : "foreign" } })).toBe(false);
    for (const patch of [{ controllerBootId: "new-claim" }, { controllerLeaseExpiresAt: new Date(0) },
      { startedAt: new Date(0) }, { finishedAt: new Date(0) }, { executionStage: "dispatching" },
      { processPid: 42 }, { processGroupId: 42 }, { processStartedAt: startedAt }, { runtimeMode: "native" },
      { status: "running" }, { status: "cancelled" }, { status: "interrupted" }])
      expect(legacySourceProcessSettled({ ...run, ...patch })).toBe(false);
  });
});

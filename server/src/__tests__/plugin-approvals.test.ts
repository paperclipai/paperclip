import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Minimal DB stub factory
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function makeDb(rows: Row[] = [], updateRow: Row | null = null) {
  const offsetStub = vi.fn(async () => rows);
  const limitStub = vi.fn(() => ({ offset: offsetStub }));
  const whereStub = vi.fn(() => ({ limit: limitStub, offset: vi.fn(async () => rows), then: (fn: (r: Row[]) => unknown) => Promise.resolve(fn(rows)) }));
  const fromStub = vi.fn(() => ({ where: whereStub }));
  const selectStub = vi.fn(() => ({ from: fromStub }));

  const returningStub = vi.fn(async () => (updateRow ? [updateRow] : []));
  const whereUpdateStub = vi.fn(() => ({ returning: returningStub }));
  const setStub = vi.fn(() => ({ where: whereUpdateStub }));
  const updateStub = vi.fn(() => ({ set: setStub }));

  const returningInsertStub = vi.fn(async () => (updateRow ? [updateRow] : []));
  const valuesStub = vi.fn(() => ({ returning: returningInsertStub }));
  const insertStub = vi.fn(() => ({ values: valuesStub }));

  return {
    db: { select: selectStub, update: updateStub, insert: insertStub } as unknown,
    stubs: { whereStub, fromStub, selectStub, setStub, whereUpdateStub, returningStub, updateStub },
  };
}

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => ({
    activatePendingApproval: vi.fn(),
    create: vi.fn(),
    terminate: vi.fn(),
  })),
}));
vi.mock("../services/hire-hook.js", () => ({ notifyHireApproved: vi.fn() }));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  })),
}));
vi.mock("../services/budgets.js", () => ({
  budgetService: vi.fn(() => ({ upsertPolicy: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// approvalService.listByPlugin
// ---------------------------------------------------------------------------

describe("approvalService.listByPlugin", () => {
  it("queries approvals by sourcePluginId and companyId", async () => {
    const { approvalService } = await import("../services/approvals.ts");
    const fakeRow = {
      id: "appr-1",
      companyId: "cmp-1",
      sourcePluginId: "plug-1",
      status: "pending",
      payload: {},
      type: "plugin_workflow",
    };
    const { db, stubs } = makeDb([fakeRow]);
    const svc = approvalService(db as any);
    const result = await svc.listByPlugin("plug-1", "cmp-1");
    expect(result).toEqual([fakeRow]);
    expect(stubs.fromStub).toHaveBeenCalled();
  });

  it("returns empty array when no approvals match", async () => {
    const { approvalService } = await import("../services/approvals.ts");
    const { db } = makeDb([]);
    const svc = approvalService(db as any);
    const result = await svc.listByPlugin("plug-no-match", "cmp-1");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// approvalService.cancel
// ---------------------------------------------------------------------------

describe("approvalService.cancel", () => {
  it("sets status to cancelled with reason", async () => {
    const { approvalService } = await import("../services/approvals.ts");
    const cancelledRow = { id: "appr-1", status: "cancelled", decisionNote: "test reason" };
    const { db, stubs } = makeDb([], cancelledRow);
    const svc = approvalService(db as any);
    const result = await svc.cancel("appr-1", "test reason");
    expect(result?.status).toBe("cancelled");
    expect(stubs.setStub).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", decisionNote: "test reason" }),
    );
  });

  it("returns null when no rows updated (already resolved)", async () => {
    const { approvalService } = await import("../services/approvals.ts");
    const { db } = makeDb([], null);
    const svc = approvalService(db as any);
    const result = await svc.cancel("appr-already-done");
    expect(result).toBeNull();
  });
});

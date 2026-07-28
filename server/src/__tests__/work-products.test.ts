import { describe, expect, it, vi } from "vitest";
import { workProductService } from "../services/work-products.ts";

function createWorkProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-03-17T00:00:00.000Z");
  return {
    id: "work-product-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "PR 1",
    url: "https://example.com/pr/1",
    status: "open",
    reviewState: "draft",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("workProductService", () => {
  it("uses a transaction when creating a new primary work product", async () => {
    const updatedWhere = vi.fn(async () => undefined);
    const updateSet = vi.fn(() => ({ where: updatedWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const insertedRow = createWorkProductRow();
    const insertReturning = vi.fn(async () => [insertedRow]);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const tx = {
      update: txUpdate,
      insert: txInsert,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.createForIssue("issue-1", "company-1", {
      type: "pull_request",
      provider: "github",
      title: "PR 1",
      status: "open",
      reviewState: "draft",
      isPrimary: true,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(result?.id).toBe("work-product-1");
  });

  it("uses a transaction when promoting an existing work product to primary", async () => {
    const existingRow = createWorkProductRow({ isPrimary: false });

    // `.for("update")` locks the row so `previousStatus` describes the state this write replaces.
    const selectFor = vi.fn(async () => [existingRow]);
    const selectWhere = vi.fn(() => ({ for: selectFor }));
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const txSelect = vi.fn(() => ({ from: selectFrom }));

    const updateReturning = vi
      .fn()
      .mockResolvedValue([createWorkProductRow({ reviewState: "ready_for_review" })]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const tx = {
      select: txSelect,
      update: txUpdate,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.update("work-product-1", {
      isPrimary: true,
      reviewState: "ready_for_review",
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txSelect).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(selectFor).toHaveBeenCalledWith("update");
    expect(result?.reviewState).toBe("ready_for_review");
    expect(result?.previousStatus).toBe(existingRow.status);
  });

  // The productivity work trace reads the completion transition out of the audit row, not out of
  // the work product. Recording it after the update returns would let a status change commit while
  // the audit write fails, and a completion no reader can see is classified as a stall against work
  // that is already finished. The hook therefore runs inside the transaction, still holding the
  // row lock, so a failure takes the status change down with it.
  it("records the transition inside the update transaction, before the row is handed back", async () => {
    const existingRow = createWorkProductRow({ status: "open" });
    const mergedRow = createWorkProductRow({ status: "merged" });

    const selectFor = vi.fn(async () => [existingRow]);
    const selectWhere = vi.fn(() => ({ for: selectFor }));
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const txSelect = vi.fn(() => ({ from: selectFrom }));

    const updateReturning = vi.fn().mockResolvedValue([mergedRow]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const tx = { select: txSelect, update: txUpdate };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));
    const svc = workProductService({ transaction } as any);

    const seen: Array<{ status: string; previousStatus: string | null; txIsSame: boolean }> = [];
    const result = await svc.update(
      "work-product-1",
      { status: "merged" },
      {
        recordTransition: async (recordTx, { product, previousStatus }) => {
          seen.push({
            status: product.status,
            previousStatus,
            // The hook must receive the transaction, not the outer db — otherwise the audit row
            // commits on its own connection and the rollback below would not reach it.
            txIsSame: (recordTx as unknown) === tx,
          });
        },
      },
    );

    expect(seen).toEqual([{ status: "merged", previousStatus: "open", txIsSame: true }]);
    expect(result?.status).toBe("merged");

    // A failing transition write must not leave the status change behind: the error propagates out
    // of the transaction callback, so the surrounding transaction rolls back.
    const failing = svc.update(
      "work-product-1",
      { status: "merged" },
      {
        recordTransition: async () => {
          throw new Error("activity log unavailable");
        },
      },
    );
    await expect(failing).rejects.toThrow("activity log unavailable");
  });
});

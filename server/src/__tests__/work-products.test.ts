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

    const selectWhere = vi.fn(async () => [existingRow]);
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
    expect(result?.reviewState).toBe("ready_for_review");
  });

  it("deduplicates repeated external work products under load", async () => {
    const stored: ReturnType<typeof createWorkProductRow>[] = [];
    let locked = Promise.resolve();
    const transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
      const previous = locked;
      let release = () => {};
      locked = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const tx = {
        execute: vi.fn(async () => undefined),
        select: vi.fn(() => ({
          from: () => ({ where: async () => stored }),
        })),
        insert: vi.fn(() => ({
          values: () => ({
            returning: async () => {
              const row = createWorkProductRow({ externalId: "artifact-sha-1" });
              stored.push(row);
              return [row];
            },
          }),
        })),
      };
      try {
        return await callback(tx);
      } finally {
        release();
      }
    });
    const svc = workProductService({ transaction } as any);
    const input = {
      type: "artifact" as const,
      provider: "paperclip",
      externalId: "artifact-sha-1",
      title: "SER-377 report",
      status: "active",
    };

    const results = await Promise.all(
      Array.from({ length: 25 }, () => svc.createForIssue("issue-1", "company-1", input)),
    );

    expect(stored).toHaveLength(1);
    expect(new Set(results.map((result) => result?.id))).toEqual(new Set(["work-product-1"]));
  });

  it("releases the dedupe lock after failure so a retry can recover", async () => {
    let attempt = 0;
    const stored: ReturnType<typeof createWorkProductRow>[] = [];
    const transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
      const tx = {
        execute: vi.fn(async () => undefined),
        select: vi.fn(() => ({ from: () => ({ where: async () => stored }) })),
        insert: vi.fn(() => ({
          values: () => ({
            returning: async () => {
              attempt += 1;
              if (attempt === 1) throw new Error("injected insert failure");
              const row = createWorkProductRow({ externalId: "artifact-sha-recovery" });
              stored.push(row);
              return [row];
            },
          }),
        })),
      };
      return callback(tx);
    });
    const svc = workProductService({ transaction } as any);
    const input = {
      type: "artifact" as const,
      provider: "paperclip",
      externalId: "artifact-sha-recovery",
      title: "SER-377 recovery report",
      status: "active",
    };

    await expect(svc.createForIssue("issue-1", "company-1", input)).rejects.toThrow(
      "injected insert failure",
    );
    await expect(svc.createForIssue("issue-1", "company-1", input)).resolves.toMatchObject({
      id: "work-product-1",
      externalId: "artifact-sha-recovery",
    });
    expect(stored).toHaveLength(1);
  });
});

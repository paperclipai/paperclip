import { describe, expect, it, vi } from "vitest";
import {
  enrichWorkProductMetadataWithDiff,
  refreshPullRequestWorkProductMetadata,
  workProductDiffSummaryFromEventPayload,
  workProductService,
} from "../services/work-products.ts";

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
  it("extracts runner totals and enriches work-product metadata", () => {
    const summary = workProductDiffSummaryFromEventPayload({
      schema: "paperclip.workspace.diff.v1",
      totals: { files: 3, additions: 17, deletions: 5 },
    });

    expect(summary).toEqual({ changedFiles: 3, additions: 17, deletions: 5 });
    expect(enrichWorkProductMetadataWithDiff({ repo: "paperclipai/paperclip" }, summary)).toEqual({
      repo: "paperclipai/paperclip",
      changedFiles: 3,
      additions: 17,
      deletions: 5,
    });

    const prpEvent = {
      schema: "paperclip.prp.event.v1",
      payload: { totals: { files: 2, additions: 9, deletions: 4 } },
    };
    expect(workProductDiffSummaryFromEventPayload({ prpEvent })).toEqual({
      changedFiles: 2,
      additions: 9,
      deletions: 4,
    });
    expect(workProductDiffSummaryFromEventPayload(prpEvent)).toEqual({
      changedFiles: 2,
      additions: 9,
      deletions: 4,
    });
  });

  it("refreshes pull-request state without mutating the stored work product", async () => {
    const product = createWorkProductRow({
      companyId: "company-1",
      url: "https://github.com/paperclipai/paperclip/pull/42",
      metadata: {
        repo: "paperclipai/paperclip",
        number: 42,
        additions: 17,
        deletions: 5,
        changedFiles: 3,
        state: "open",
        draft: false,
      },
    }) as any;
    const resolve = vi.fn(async () => ({
      state: "open" as const,
      workProductState: "merged" as const,
      draft: false,
      headRef: "feature/rich-cards",
      headSha: "abc123",
      baseRef: "master",
      additions: 20,
      deletions: 7,
      changedFiles: 4,
    }));

    const [refreshed] = await refreshPullRequestWorkProductMetadata([product], resolve);

    expect(resolve).toHaveBeenCalledWith("company-1", {
      host: "github.com",
      owner: "paperclipai",
      repo: "paperclip",
      number: 42,
    });
    expect(refreshed?.metadata).toMatchObject({
      state: "merged",
      draft: false,
      baseRef: "master",
      headRef: "feature/rich-cards",
      additions: 20,
      deletions: 7,
      changedFiles: 4,
    });
    expect(product.metadata.state).toBe("open");
  });

  it("resolves GitHub commit stats when runner diff events are unavailable", async () => {
    const resolveCommitDetails = vi.fn(async () => ({ additions: 13, deletions: 2, changedFiles: 3 }));
    const svc = workProductService({} as any, { resolveCommitDetails });

    await expect(svc.resolveCommitDiffSummary("company-1", {
      provider: "github",
      url: "https://github.com/paperclipai/paperclip/commit/9c12ae7b41e5",
      metadata: null,
    })).resolves.toEqual({ additions: 13, deletions: 2, changedFiles: 3 });
    expect(resolveCommitDetails).toHaveBeenCalledWith("company-1", {
      host: "github.com",
      owner: "paperclipai",
      repo: "paperclip",
      sha: "9c12ae7b41e5",
    });
  });

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
});

import { describe, expect, it, vi } from "vitest";
import type { IssueWorkProduct } from "@paperclipai/shared";
import {
  resolveRuntimeServiceWorkProductState,
  workProductService,
} from "../services/work-products.ts";

function createWorkProductRow(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
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
  it("refreshes a runtime work product from its current managed service row", () => {
    const product = createWorkProductRow({
      executionWorkspaceId: "workspace-1",
      runtimeServiceId: "runtime-1",
      type: "runtime_service",
      provider: "paperclip",
      externalId: "runtime-1",
      title: "Managed dev server",
      url: "https://paperclip.example.test:42001",
      status: "active",
      healthStatus: "healthy",
      metadata: { serviceName: "paperclip-dev" },
    });

    const resolved = resolveRuntimeServiceWorkProductState(product, [{
      id: "runtime-1",
      companyId: "company-1",
      executionWorkspaceId: "workspace-1",
      serviceName: "paperclip-dev",
      status: "running",
      port: 42013,
      url: "https://paperclip.example.test:42013",
      healthStatus: "healthy",
    }]);

    expect(resolved).toMatchObject({
      runtimeServiceId: "runtime-1",
      externalId: "runtime-1",
      url: "https://paperclip.example.test:42013",
      status: "active",
      healthStatus: "healthy",
      metadata: {
        serviceName: "paperclip-dev",
        runtimeService: {
          id: "runtime-1",
          serviceName: "paperclip-dev",
          status: "running",
          port: 42013,
        },
      },
    });
  });

  it("does not substitute a different same-name runtime row", () => {
    const product = createWorkProductRow({
      executionWorkspaceId: "workspace-1",
      runtimeServiceId: "runtime-stopped",
      type: "runtime_service",
      provider: "paperclip",
      externalId: "runtime-stopped",
      url: "https://paperclip.example.test:42001",
      status: "active",
      healthStatus: "healthy",
      metadata: { serviceName: "paperclip-dev" },
    });
    const runtimeBase = {
      companyId: "company-1",
      executionWorkspaceId: "workspace-1",
      serviceName: "paperclip-dev",
      port: 42001,
      url: null,
      healthStatus: "unknown",
    };

    const resolved = resolveRuntimeServiceWorkProductState(product, [
      { ...runtimeBase, id: "runtime-stopped", status: "stopped" },
      {
        ...runtimeBase,
        id: "runtime-current",
        status: "running",
        port: 42013,
        url: "https://paperclip.example.test:42013",
        healthStatus: "healthy",
      },
    ]);

    expect(resolved).toMatchObject({
      runtimeServiceId: "runtime-stopped",
      externalId: "runtime-stopped",
      url: null,
      status: "archived",
      healthStatus: "unknown",
    });
  });

  it("removes a dead URL when no replacement runtime is active", () => {
    const product = createWorkProductRow({
      executionWorkspaceId: "workspace-1",
      runtimeServiceId: "runtime-stopped",
      type: "runtime_service",
      provider: "paperclip",
      url: "https://paperclip.example.test:42001",
      status: "active",
      healthStatus: "healthy",
    });

    const resolved = resolveRuntimeServiceWorkProductState(product, [{
      id: "runtime-stopped",
      companyId: "company-1",
      executionWorkspaceId: "workspace-1",
      serviceName: "paperclip-dev",
      status: "stopped",
      port: 42001,
      url: null,
      healthStatus: "unknown",
    }]);

    expect(resolved).toMatchObject({
      runtimeServiceId: "runtime-stopped",
      url: null,
      status: "archived",
      healthStatus: "unknown",
    });
  });

  it("hydrates runtime state when listing work products", async () => {
    const staleProduct = createWorkProductRow({
      executionWorkspaceId: "workspace-1",
      runtimeServiceId: "runtime-1",
      type: "runtime_service",
      provider: "paperclip",
      externalId: "runtime-1",
      url: "https://paperclip.example.test:42001",
      status: "active",
      healthStatus: "healthy",
      metadata: { serviceName: "paperclip-dev" },
    });
    const productOrderBy = vi.fn(async () => [staleProduct]);
    const productWhere = vi.fn(() => ({ orderBy: productOrderBy }));
    const productFrom = vi.fn(() => ({ where: productWhere }));
    const runtimeWhere = vi.fn(async () => [{
      id: "runtime-1",
      companyId: "company-1",
      executionWorkspaceId: "workspace-1",
      serviceName: "paperclip-dev",
      status: "running",
      port: 42013,
      url: "https://paperclip.example.test:42013",
      healthStatus: "healthy",
    }]);
    const runtimeFrom = vi.fn(() => ({ where: runtimeWhere }));
    const select = vi.fn()
      .mockReturnValueOnce({ from: productFrom })
      .mockReturnValueOnce({ from: runtimeFrom });

    const result = await workProductService({ select } as any).listForIssue("issue-1");

    expect(result[0]).toMatchObject({
      runtimeServiceId: "runtime-1",
      url: "https://paperclip.example.test:42013",
      status: "active",
      healthStatus: "healthy",
    });
    expect(select).toHaveBeenCalledTimes(2);
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

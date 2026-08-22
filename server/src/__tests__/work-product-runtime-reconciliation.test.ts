import { describe, expect, it } from "vitest";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { reconcileRuntimeServiceWorkProducts } from "../services/work-products.js";

function workProduct(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id: "wp-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: "ews-1",
    runtimeServiceId: "runtime-1",
    type: "runtime_service",
    provider: "paperclip",
    externalId: null,
    title: "Workspace preview",
    url: "https://workspace.example.ts.net:42013/",
    status: "open",
    reviewState: "none",
    isPrimary: true,
    healthStatus: "healthy",
    summary: null,
    metadata: null,
    sourceTrust: null,
    createdByRunId: null,
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
    updatedAt: new Date("2026-08-19T00:00:00.000Z"),
    ...overrides,
  };
}

describe("reconcileRuntimeServiceWorkProducts", () => {
  it("adopts the live runtime URL after a port change", () => {
    const [reconciled] = reconcileRuntimeServiceWorkProducts(
      [workProduct()],
      [{ id: "runtime-1", url: "https://workspace.example.ts.net:42055/", status: "running", healthStatus: "healthy" }],
    );
    expect(reconciled!.url).toBe("https://workspace.example.ts.net:42055/");
    expect(reconciled!.healthStatus).toBe("healthy");
  });

  it("marks a stopped or unhealthy runtime unhealthy instead of advertising it", () => {
    const [stopped] = reconcileRuntimeServiceWorkProducts(
      [workProduct()],
      [{ id: "runtime-1", url: "https://workspace.example.ts.net:42013/", status: "stopped", healthStatus: "healthy" }],
    );
    expect(stopped!.healthStatus).toBe("unhealthy");

    const [unhealthy] = reconcileRuntimeServiceWorkProducts(
      [workProduct()],
      [{ id: "runtime-1", url: "https://workspace.example.ts.net:42013/", status: "running", healthStatus: "unhealthy" }],
    );
    expect(unhealthy!.healthStatus).toBe("unhealthy");
  });

  it("keeps the recorded URL when the runtime row is gone, but stops calling it healthy", () => {
    const [reconciled] = reconcileRuntimeServiceWorkProducts([workProduct()], []);
    expect(reconciled!.url).toBe("https://workspace.example.ts.net:42013/");
    expect(reconciled!.healthStatus).toBe("unhealthy");
  });

  it("leaves non-runtime work products and unlinked rows untouched", () => {
    const pullRequest = workProduct({ id: "wp-pr", type: "pull_request", runtimeServiceId: null });
    const unlinked = workProduct({ id: "wp-unlinked", runtimeServiceId: null });
    const reconciled = reconcileRuntimeServiceWorkProducts([pullRequest, unlinked], []);
    expect(reconciled[0]).toBe(pullRequest);
    expect(reconciled[1]).toBe(unlinked);
  });

  it("returns the same objects when nothing drifted", () => {
    const product = workProduct();
    const reconciled = reconcileRuntimeServiceWorkProducts(
      [product],
      [{ id: "runtime-1", url: product.url, status: "running", healthStatus: "healthy" }],
    );
    expect(reconciled[0]).toBe(product);
  });
});

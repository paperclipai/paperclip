import { describe, it, expect } from "vitest";
import { toIssueWorkProduct } from "./work-products.js";
import type { issueWorkProducts } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;

const NOW = new Date("2024-06-01T12:00:00Z");
const THEN = new Date("2024-05-01T09:00:00Z");

/** Build a fully-populated row with all optional fields set. */
function makeFullRow(overrides: Partial<IssueWorkProductRow> = {}): IssueWorkProductRow {
  return {
    id: "wp-1",
    companyId: "co-1",
    projectId: "proj-1",
    issueId: "issue-1",
    executionWorkspaceId: "ws-1",
    runtimeServiceId: "svc-1",
    type: "pull_request",
    provider: "github",
    externalId: "pr-42",
    title: "My PR",
    url: "https://github.com/org/repo/pull/42",
    status: "active",
    reviewState: "none",
    isPrimary: true,
    healthStatus: "healthy",
    summary: "A summary",
    metadata: { key: "value" },
    createdByRunId: "run-1",
    createdAt: THEN,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Build a minimal row with all nullable optional fields set to null. */
function makeMinimalRow(overrides: Partial<IssueWorkProductRow> = {}): IssueWorkProductRow {
  return {
    id: "wp-2",
    companyId: "co-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "branch",
    provider: "paperclip",
    externalId: null,
    title: "My Branch",
    url: null,
    status: "draft",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: THEN,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// toIssueWorkProduct
// ---------------------------------------------------------------------------

describe("toIssueWorkProduct", () => {
  it("maps all required fields from a fully-populated row", () => {
    const row = makeFullRow();
    const wp = toIssueWorkProduct(row);

    expect(wp.id).toBe("wp-1");
    expect(wp.companyId).toBe("co-1");
    expect(wp.issueId).toBe("issue-1");
    expect(wp.type).toBe("pull_request");
    expect(wp.provider).toBe("github");
    expect(wp.title).toBe("My PR");
    expect(wp.status).toBe("active");
    expect(wp.reviewState).toBe("none");
    expect(wp.isPrimary).toBe(true);
    expect(wp.healthStatus).toBe("healthy");
    expect(wp.createdAt).toBe(THEN);
    expect(wp.updatedAt).toBe(NOW);
  });

  it("maps all optional fields when present", () => {
    const row = makeFullRow();
    const wp = toIssueWorkProduct(row);

    expect(wp.projectId).toBe("proj-1");
    expect(wp.executionWorkspaceId).toBe("ws-1");
    expect(wp.runtimeServiceId).toBe("svc-1");
    expect(wp.externalId).toBe("pr-42");
    expect(wp.url).toBe("https://github.com/org/repo/pull/42");
    expect(wp.summary).toBe("A summary");
    expect(wp.metadata).toEqual({ key: "value" });
    expect(wp.createdByRunId).toBe("run-1");
  });

  it("maps null optional fields to null (not undefined)", () => {
    const row = makeMinimalRow();
    const wp = toIssueWorkProduct(row);

    expect(wp.projectId).toBeNull();
    expect(wp.executionWorkspaceId).toBeNull();
    expect(wp.runtimeServiceId).toBeNull();
    expect(wp.externalId).toBeNull();
    expect(wp.url).toBeNull();
    expect(wp.summary).toBeNull();
    expect(wp.metadata).toBeNull();
    expect(wp.createdByRunId).toBeNull();
  });

  it("coerces undefined optional fields to null", () => {
    // Drizzle rows may have undefined for nullable columns in some query shapes
    const row = makeMinimalRow({
      projectId: undefined as unknown as null,
      executionWorkspaceId: undefined as unknown as null,
      runtimeServiceId: undefined as unknown as null,
      externalId: undefined as unknown as null,
      url: undefined as unknown as null,
      summary: undefined as unknown as null,
      metadata: undefined as unknown as null,
      createdByRunId: undefined as unknown as null,
    });
    const wp = toIssueWorkProduct(row);

    expect(wp.projectId).toBeNull();
    expect(wp.executionWorkspaceId).toBeNull();
    expect(wp.runtimeServiceId).toBeNull();
    expect(wp.externalId).toBeNull();
    expect(wp.url).toBeNull();
    expect(wp.summary).toBeNull();
    expect(wp.metadata).toBeNull();
    expect(wp.createdByRunId).toBeNull();
  });

  it("preserves isPrimary=false correctly", () => {
    const row = makeMinimalRow({ isPrimary: false });
    expect(toIssueWorkProduct(row).isPrimary).toBe(false);
  });

  it("preserves isPrimary=true correctly", () => {
    const row = makeFullRow({ isPrimary: true });
    expect(toIssueWorkProduct(row).isPrimary).toBe(true);
  });

  it("passes through type as IssueWorkProductType string", () => {
    const types = ["preview_url", "runtime_service", "pull_request", "branch", "commit", "artifact", "document"] as const;
    for (const type of types) {
      const wp = toIssueWorkProduct(makeFullRow({ type }));
      expect(wp.type).toBe(type);
    }
  });

  it("passes through reviewState as IssueWorkProductReviewState string", () => {
    const states = ["none", "needs_board_review", "approved", "changes_requested"] as const;
    for (const state of states) {
      const wp = toIssueWorkProduct(makeFullRow({ reviewState: state }));
      expect(wp.reviewState).toBe(state);
    }
  });

  it("passes through healthStatus", () => {
    const statuses = ["unknown", "healthy", "unhealthy"] as const;
    for (const hs of statuses) {
      const wp = toIssueWorkProduct(makeFullRow({ healthStatus: hs }));
      expect(wp.healthStatus).toBe(hs);
    }
  });

  it("preserves metadata object reference", () => {
    const metadata = { nested: { value: 42 }, list: [1, 2, 3] };
    const wp = toIssueWorkProduct(makeFullRow({ metadata }));
    expect(wp.metadata).toEqual(metadata);
  });

  it("preserves Date objects for createdAt and updatedAt", () => {
    const createdAt = new Date("2024-01-15T08:00:00Z");
    const updatedAt = new Date("2024-02-20T16:30:00Z");
    const wp = toIssueWorkProduct(makeFullRow({ createdAt, updatedAt }));
    expect(wp.createdAt).toBe(createdAt);
    expect(wp.updatedAt).toBe(updatedAt);
  });

  it("returns a plain object matching IssueWorkProduct shape", () => {
    const wp = toIssueWorkProduct(makeFullRow());
    // Verify all expected keys are present
    const keys = Object.keys(wp).sort();
    expect(keys).toEqual([
      "companyId",
      "createdAt",
      "createdByRunId",
      "executionWorkspaceId",
      "externalId",
      "healthStatus",
      "id",
      "isPrimary",
      "issueId",
      "metadata",
      "projectId",
      "provider",
      "reviewState",
      "runtimeServiceId",
      "status",
      "summary",
      "title",
      "type",
      "updatedAt",
      "url",
    ]);
  });
});

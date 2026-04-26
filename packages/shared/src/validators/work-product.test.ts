import { describe, expect, it } from "vitest";
import {
  issueWorkProductTypeSchema,
  issueWorkProductStatusSchema,
  issueWorkProductReviewStateSchema,
  createIssueWorkProductSchema,
  updateIssueWorkProductSchema,
} from "./work-product.js";

describe("issueWorkProductTypeSchema", () => {
  it("accepts all valid types", () => {
    for (const type of ["preview_url", "runtime_service", "pull_request", "branch", "commit", "artifact", "document"]) {
      expect(issueWorkProductTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it("rejects an unknown type", () => {
    expect(issueWorkProductTypeSchema.safeParse("deployment").success).toBe(false);
  });
});

describe("issueWorkProductStatusSchema", () => {
  it("accepts all valid statuses", () => {
    for (const status of ["active", "ready_for_review", "approved", "changes_requested", "merged", "closed", "failed", "archived", "draft"]) {
      expect(issueWorkProductStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it("rejects an unknown status", () => {
    expect(issueWorkProductStatusSchema.safeParse("pending").success).toBe(false);
  });
});

describe("issueWorkProductReviewStateSchema", () => {
  it("accepts all valid review states", () => {
    for (const state of ["none", "needs_board_review", "approved", "changes_requested"]) {
      expect(issueWorkProductReviewStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it("rejects an unknown review state", () => {
    expect(issueWorkProductReviewStateSchema.safeParse("blocked").success).toBe(false);
  });
});

describe("createIssueWorkProductSchema", () => {
  const minimal = {
    type: "pull_request" as const,
    provider: "github",
    title: "feat: add new feature",
  };

  it("accepts a minimal work product", () => {
    expect(createIssueWorkProductSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects an empty title", () => {
    expect(createIssueWorkProductSchema.safeParse({ ...minimal, title: "" }).success).toBe(false);
  });

  it("rejects an empty provider", () => {
    expect(createIssueWorkProductSchema.safeParse({ ...minimal, provider: "" }).success).toBe(false);
  });

  it("defaults status to active", () => {
    const result = createIssueWorkProductSchema.safeParse(minimal);
    expect(result.success && result.data.status).toBe("active");
  });

  it("defaults reviewState to none", () => {
    const result = createIssueWorkProductSchema.safeParse(minimal);
    expect(result.success && result.data.reviewState).toBe("none");
  });

  it("defaults isPrimary to false", () => {
    const result = createIssueWorkProductSchema.safeParse(minimal);
    expect(result.success && result.data.isPrimary).toBe(false);
  });

  it("defaults healthStatus to unknown", () => {
    const result = createIssueWorkProductSchema.safeParse(minimal);
    expect(result.success && result.data.healthStatus).toBe("unknown");
  });

  it("accepts optional URL", () => {
    expect(
      createIssueWorkProductSchema.safeParse({ ...minimal, url: "https://github.com/org/repo/pull/1" }).success,
    ).toBe(true);
  });

  it("rejects an invalid URL", () => {
    expect(createIssueWorkProductSchema.safeParse({ ...minimal, url: "not-a-url" }).success).toBe(false);
  });

  it("accepts a full work product", () => {
    const result = createIssueWorkProductSchema.safeParse({
      ...minimal,
      projectId: "00000000-0000-0000-0000-000000000001",
      executionWorkspaceId: "00000000-0000-0000-0000-000000000002",
      externalId: "PR-123",
      url: "https://github.com/org/repo/pull/123",
      status: "ready_for_review",
      reviewState: "needs_board_review",
      isPrimary: true,
      healthStatus: "healthy",
      summary: "Implements the new feature",
      metadata: { sha: "abc123" },
    });
    expect(result.success).toBe(true);
  });
});

describe("updateIssueWorkProductSchema", () => {
  it("accepts an empty object (all optional)", () => {
    expect(updateIssueWorkProductSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial updates", () => {
    expect(
      updateIssueWorkProductSchema.safeParse({ status: "merged", reviewState: "approved" }).success,
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  attachmentArtifactWorkProductMetadataSchema,
  createIssueWorkProductSchema,
  issueWorkProductReviewStateSchema,
  issueWorkProductStatusSchema,
  issueWorkProductTypeSchema,
  updateIssueWorkProductSchema,
} from "./work-product.js";

describe("issueWorkProductTypeSchema", () => {
  it("pins the supported product types", () => {
    // Pinned set so a future rename or removal breaks loudly here --
    // the issue board UI keys icons + grouping off these values.
    expect(issueWorkProductTypeSchema.options).toEqual([
      "preview_url",
      "runtime_service",
      "pull_request",
      "branch",
      "commit",
      "artifact",
      "document",
    ]);
  });

  it("rejects unknown product types", () => {
    expect(() => issueWorkProductTypeSchema.parse("podcast")).toThrow();
  });
});

describe("issueWorkProductStatusSchema", () => {
  it("pins the supported lifecycle statuses including draft", () => {
    // The "draft" status is load-bearing for the WIP filter on the
    // board -- removing it silently hides every draft work product.
    expect(issueWorkProductStatusSchema.options).toEqual([
      "active",
      "ready_for_review",
      "approved",
      "changes_requested",
      "merged",
      "closed",
      "failed",
      "archived",
      "draft",
    ]);
  });

  it("rejects unknown status", () => {
    expect(() => issueWorkProductStatusSchema.parse("in_progress")).toThrow();
  });
});

describe("issueWorkProductReviewStateSchema", () => {
  it("pins the four review states (none / needs_board_review / approved / changes_requested)", () => {
    expect(issueWorkProductReviewStateSchema.options).toEqual([
      "none",
      "needs_board_review",
      "approved",
      "changes_requested",
    ]);
  });
});

describe("createIssueWorkProductSchema defaults + required fields", () => {
  const minimal = {
    type: "pull_request" as const,
    provider: "github",
    title: "Initial PR",
  };

  it("accepts the minimal payload and applies all defaults", () => {
    const out = createIssueWorkProductSchema.parse(minimal);
    expect(out.status).toBe("active");
    expect(out.reviewState).toBe("none");
    expect(out.isPrimary).toBe(false);
    expect(out.healthStatus).toBe("unknown");
  });

  it("requires non-empty provider and title", () => {
    expect(() =>
      createIssueWorkProductSchema.parse({ ...minimal, provider: "" }),
    ).toThrow();
    expect(() =>
      createIssueWorkProductSchema.parse({ ...minimal, title: "" }),
    ).toThrow();
  });

  it("requires a known type", () => {
    expect(() =>
      createIssueWorkProductSchema.parse({
        ...minimal,
        type: "podcast" as never,
      }),
    ).toThrow();
  });

  it("rejects non-uuid foreign-key fields", () => {
    // Sloppy IDs would reach the DB and fail with a less helpful
    // error far from the API boundary -- pin uuid validation here.
    for (const key of [
      "projectId",
      "executionWorkspaceId",
      "runtimeServiceId",
      "createdByRunId",
    ] as const) {
      expect(() =>
        createIssueWorkProductSchema.parse({
          ...minimal,
          [key]: "not-a-uuid",
        }),
      ).toThrow();
    }
  });

  it("accepts uuid foreign-key fields", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    const out = createIssueWorkProductSchema.parse({
      ...minimal,
      projectId: uuid,
      executionWorkspaceId: uuid,
      runtimeServiceId: uuid,
      createdByRunId: uuid,
    });
    expect(out.projectId).toBe(uuid);
    expect(out.executionWorkspaceId).toBe(uuid);
    expect(out.runtimeServiceId).toBe(uuid);
    expect(out.createdByRunId).toBe(uuid);
  });

  it("rejects non-url url and accepts valid url", () => {
    expect(() =>
      createIssueWorkProductSchema.parse({
        ...minimal,
        url: "not a url",
      }),
    ).toThrow();
    const out = createIssueWorkProductSchema.parse({
      ...minimal,
      url: "https://example.com/pr/1",
    });
    expect(out.url).toBe("https://example.com/pr/1");
  });

  it("allows null for nullable optional fields", () => {
    const out = createIssueWorkProductSchema.parse({
      ...minimal,
      projectId: null,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      externalId: null,
      url: null,
      summary: null,
      metadata: null,
      createdByRunId: null,
    });
    expect(out.projectId).toBeNull();
    expect(out.url).toBeNull();
    expect(out.metadata).toBeNull();
  });

  it("accepts arbitrary record shape for metadata", () => {
    const out = createIssueWorkProductSchema.parse({
      ...minimal,
      metadata: { branch: "feat/x", revision: 42, nested: { k: "v" } },
    });
    expect(out.metadata).toEqual({
      branch: "feat/x",
      revision: 42,
      nested: { k: "v" },
    });
  });

  it("pins the healthStatus enum (unknown / healthy / unhealthy)", () => {
    for (const v of ["unknown", "healthy", "unhealthy"] as const) {
      expect(
        createIssueWorkProductSchema.parse({ ...minimal, healthStatus: v })
          .healthStatus,
      ).toBe(v);
    }
    expect(() =>
      createIssueWorkProductSchema.parse({
        ...minimal,
        healthStatus: "degraded" as never,
      }),
    ).toThrow();
  });

  it("respects explicit overrides of the default values", () => {
    const out = createIssueWorkProductSchema.parse({
      ...minimal,
      status: "merged",
      reviewState: "approved",
      isPrimary: true,
      healthStatus: "healthy",
    });
    expect(out.status).toBe("merged");
    expect(out.reviewState).toBe("approved");
    expect(out.isPrimary).toBe(true);
    expect(out.healthStatus).toBe("healthy");
  });
});

describe("updateIssueWorkProductSchema", () => {
  it("accepts an empty object (every field optional via .partial())", () => {
    expect(updateIssueWorkProductSchema.parse({})).toEqual({});
  });

  it("preserves enum + uuid validation on supplied fields", () => {
    expect(() =>
      updateIssueWorkProductSchema.parse({ status: "in_progress" as never }),
    ).toThrow();
    expect(() =>
      updateIssueWorkProductSchema.parse({ projectId: "nope" }),
    ).toThrow();
  });

  it("accepts a partial update with only one field", () => {
    const out = updateIssueWorkProductSchema.parse({ status: "merged" });
    expect(out.status).toBe("merged");
  });
});

describe("attachmentArtifactWorkProductMetadataSchema", () => {
  it("accepts the attachment-backed artifact metadata contract", () => {
    const parsed = attachmentArtifactWorkProductMetadataSchema.parse({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      contentType: "video/mp4",
      byteSize: 1234,
      contentPath: "/api/attachments/11111111-1111-4111-8111-111111111111/content",
      openPath: "/api/attachments/11111111-1111-4111-8111-111111111111/content",
      downloadPath: "/api/attachments/11111111-1111-4111-8111-111111111111/content?download=1",
      originalFilename: "demo.mp4",
    });

    expect(parsed.contentType).toBe("video/mp4");
    expect(parsed.downloadPath).toContain("download=1");
  });

  it("rejects off-route or scriptable paths", () => {
    const parsed = attachmentArtifactWorkProductMetadataSchema.safeParse({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      contentType: "video/mp4",
      byteSize: 1234,
      contentPath: "https://evil.example/video.mp4",
      openPath: "javascript:alert(1)",
      downloadPath: "/api/attachments/11111111-1111-4111-8111-111111111111/content",
      originalFilename: "demo.mp4",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error("Expected invalid attachment artifact metadata");
    }
    expect(parsed.error.issues.map((issue) => issue.path.join("."))).toEqual([
      "contentPath",
      "openPath",
      "downloadPath",
    ]);
  });
});

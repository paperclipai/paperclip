import type { Approval, Issue, IssueWorkProduct, ReviewedArtifactResolved } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  createSuggestedReviewedArtifactsResponse,
  hasPendingLinkedApproval,
  mapReviewedArtifactsResponse,
  shouldShowReviewedAssetsPanel,
} from "./reviewed-artifacts";

function createArtifact(overrides: Partial<ReviewedArtifactResolved> = {}): ReviewedArtifactResolved {
  return {
    id: overrides.id ?? "artifact-1",
    sourceType: overrides.sourceType ?? "issue_document",
    source: overrides.source ?? { type: "issue_document", issueId: "issue-1", key: "plan" },
    sourceIssue: overrides.sourceIssue ?? { id: "issue-1", identifier: "DIG-1", title: "Issue" },
    title: overrides.title ?? "Artifact",
    description: overrides.description ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    isPrimary: overrides.isPrimary ?? false,
    required: overrides.required ?? false,
    selectedExplicitly: overrides.selectedExplicitly ?? true,
    resolution: overrides.resolution ?? { status: "resolved", reason: null },
    preview: overrides.preview ?? {
      mode: "download_only",
      previewable: false,
      downloadUrl: "/download",
    },
    document: "document" in overrides ? overrides.document : { key: "plan", revisionId: "rev-1", revisionNumber: 1 },
    snapshot: overrides.snapshot ?? null,
  };
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
    companyId: overrides.companyId ?? "company-1",
    identifier: overrides.identifier ?? "DIG-1",
    title: overrides.title ?? "Issue",
    status: overrides.status ?? "todo",
    workProducts: overrides.workProducts ?? [],
  } as Issue;
}

function createApproval(status: Approval["status"]): Approval {
  return { id: "approval-1", status } as Approval;
}

function createWorkProduct(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id: overrides.id ?? "work-1",
    title: overrides.title ?? "Preview",
    url: overrides.url ?? "https://example.com/preview",
    status: overrides.status ?? "ready_for_review",
    reviewState: overrides.reviewState ?? "needs_board_review",
    isPrimary: overrides.isPrimary ?? true,
    provider: overrides.provider ?? "custom",
    healthStatus: overrides.healthStatus ?? "unknown",
    summary: overrides.summary ?? "Review this preview.",
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-04-01T00:00:00.000Z"),
  } as IssueWorkProduct;
}

describe("reviewed artifact mapper", () => {
  it("orders explicit artifacts before suggested fallback and preserves primary-first order within each group", () => {
    const model = mapReviewedArtifactsResponse({
      artifacts: [
        createArtifact({ id: "suggested-primary", selectedExplicitly: false, isPrimary: true, sortOrder: 0 }),
        createArtifact({ id: "explicit-secondary", selectedExplicitly: true, sortOrder: 2 }),
        createArtifact({ id: "explicit-primary", selectedExplicitly: true, isPrimary: true, sortOrder: 1 }),
      ],
    });

    expect(model.items.map((artifact) => artifact.id)).toEqual([
      "explicit-primary",
      "explicit-secondary",
      "suggested-primary",
    ]);
    expect(model.items[0]?.normalizedPrimary).toBe(true);
  });

  it("selects the first ordered artifact as primary when the backend does not provide one", () => {
    const model = mapReviewedArtifactsResponse({
      artifacts: [
        createArtifact({ id: "second", sortOrder: 2, isPrimary: false }),
        createArtifact({ id: "first", sortOrder: 1, isPrimary: false }),
      ],
    });

    expect(model.items.map((artifact) => [artifact.id, artifact.normalizedPrimary])).toEqual([
      ["first", true],
      ["second", false],
    ]);
  });

  it("keeps fallback artifacts labeled as suggested", () => {
    const response = createSuggestedReviewedArtifactsResponse(createIssue({
      workProducts: [createWorkProduct({ id: "work-1", isPrimary: true })],
    }));
    const model = mapReviewedArtifactsResponse(response);

    expect(model.hasExplicitSelection).toBe(false);
    expect(model.hasSuggestedSelection).toBe(true);
    expect(model.items[0]?.selectedExplicitly).toBe(false);
    expect(model.items[0]?.selectionLabel).toBe("Suggested");
  });

  it("keeps suggested artifact source issue identity separate from company identity", () => {
    const response = createSuggestedReviewedArtifactsResponse(createIssue({
      id: "issue-123",
      companyId: "company-456",
      identifier: "DIG-123",
      workProducts: [createWorkProduct({ id: "work-1", isPrimary: true })],
    }));
    const model = mapReviewedArtifactsResponse(response);

    expect(model.items[0]?.sourceIssue?.id).toBe("issue-123");
    expect(model.items[0]?.sourceIssue?.id).not.toBe("company-456");
    expect(model.items[0]?.source).toMatchObject({ type: "issue_work_product", issueId: "issue-123" });
  });

  it("uses backend preview mode and resolution status for render kind", () => {
    const model = mapReviewedArtifactsResponse({
      artifacts: [
        createArtifact({
          id: "markdown",
          preview: { mode: "markdown", previewable: true, markdownBody: "# Plan" },
        }),
        createArtifact({
          id: "image",
          preview: { mode: "image", previewable: true, previewUrl: "/image", contentType: "image/png" },
        }),
        createArtifact({
          id: "link",
          preview: { mode: "link", previewable: false, externalUrl: "https://example.com" },
        }),
        createArtifact({
          id: "missing",
          resolution: { status: "missing", reason: "Deleted" },
          preview: { mode: "image", previewable: true, previewUrl: "/deleted", contentType: "image/png" },
        }),
        createArtifact({
          id: "permission",
          resolution: { status: "permission_denied", reason: "Forbidden" },
        }),
      ],
    });

    expect(model.items.map((artifact) => [artifact.id, artifact.renderKind])).toEqual([
      ["markdown", "markdown"],
      ["image", "image"],
      ["link", "link"],
      ["missing", "missing"],
      ["permission", "permission_denied"],
    ]);
  });

  it("shows the panel for review context, pending approvals, or mapped assets", () => {
    expect(shouldShowReviewedAssetsPanel({
      issue: createIssue({ status: "in_review" }),
      linkedApprovals: [],
      response: { artifacts: [] },
    })).toBe(true);
    expect(shouldShowReviewedAssetsPanel({
      issue: createIssue({ status: "todo" }),
      linkedApprovals: [createApproval("pending")],
      response: { artifacts: [] },
    })).toBe(true);
    expect(shouldShowReviewedAssetsPanel({
      issue: createIssue({ status: "todo" }),
      linkedApprovals: [createApproval("approved")],
      response: { artifacts: [createArtifact()] },
    })).toBe(true);
    expect(hasPendingLinkedApproval([createApproval("revision_requested")])).toBe(true);
  });
});

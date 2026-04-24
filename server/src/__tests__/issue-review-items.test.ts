import { describe, expect, it } from "vitest";
import type {
  IssueAttachment,
  IssueBoardState,
  IssueComment,
  IssueDocument,
  IssueWorkProduct,
} from "@paperclipai/shared";
import { buildIssueReviewItems, buildIssueReviewPackSurface } from "../services/issue-review-items.js";

function makeComment(id: string, body: string, createdAt: string): IssueComment {
  return {
    id,
    companyId: "company-1",
    issueId: "issue-1",
    authorAgentId: "agent-1",
    authorUserId: null,
    body,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function makeAttachment(overrides: Partial<IssueAttachment> = {}): IssueAttachment {
  return {
    id: "attachment-1",
    companyId: "company-1",
    issueId: "issue-1",
    issueCommentId: null,
    assetId: "asset-1",
    provider: "local_disk",
    objectKey: "issues/issue-1/photo.png",
    contentType: "image/png",
    byteSize: 2048,
    sha256: "sha256",
    originalFilename: "photo.png",
    createdByAgentId: "agent-1",
    createdByUserId: null,
    createdAt: new Date("2026-04-17T09:00:00.000Z"),
    updatedAt: new Date("2026-04-17T09:00:00.000Z"),
    contentPath: "/api/attachments/attachment-1/content",
    ...overrides,
  };
}

function makeDocument(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "doc-1",
    companyId: "company-1",
    issueId: "issue-1",
    key: "listing-brief",
    title: "Listing Brief",
    format: "markdown",
    latestRevisionId: "rev-1",
    latestRevisionNumber: 1,
    createdByAgentId: "agent-1",
    createdByUserId: null,
    updatedByAgentId: "agent-1",
    updatedByUserId: null,
    createdAt: new Date("2026-04-17T08:00:00.000Z"),
    updatedAt: new Date("2026-04-17T08:00:00.000Z"),
    body: "# Listing brief\n\nUse the uploaded photos.",
    ...overrides,
  };
}

function makeWorkProduct(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id: "wp-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "preview_url",
    provider: "paperclip",
    externalId: null,
    title: "Published listing preview",
    url: "https://preview.paperclip.local/listings/preview-123",
    status: "ready_for_review",
    reviewState: "needs_board_review",
    isPrimary: true,
    healthStatus: "healthy",
    summary: "Marketplace draft preview",
    metadata: null,
    createdByRunId: null,
    createdAt: new Date("2026-04-17T07:00:00.000Z"),
    updatedAt: new Date("2026-04-17T07:00:00.000Z"),
    ...overrides,
  };
}

describe("buildIssueReviewItems", () => {
  it("extracts first-class items, marketplace links, and workspace paths into ranked groups", () => {
    const comments = [
      makeComment(
        "comment-1",
        [
          "Published draft: https://www.ebay.es/itm/123456789",
          "",
          "Use file ops/cocktail-machine-sale/listing-templates/wallapop.txt",
        ].join("\n"),
        "2026-04-17T10:00:00.000Z",
      ),
      makeComment(
        "comment-2",
        "Still using ops/cocktail-machine-sale/listing-templates/wallapop.txt for the Wallapop copy.",
        "2026-04-17T11:00:00.000Z",
      ),
    ];

    const items = buildIssueReviewItems({
      issueId: "issue-1",
      issueDescription: "Photos attached for the listing refresh.",
      hasProjectCodebase: true,
      comments,
      attachments: [makeAttachment()],
      documents: [makeDocument()],
      workProducts: [makeWorkProduct()],
    });

    expect(items.map((item) => item.group)).toContain("review_now");
    expect(items.map((item) => item.group)).toContain("references");

    expect(items[0]).toEqual(
      expect.objectContaining({
        kind: "work_product",
        group: "review_now",
        title: "Published listing preview",
      }),
    );

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "image",
          group: "review_now",
          resolvedTarget: expect.objectContaining({ attachmentId: "attachment-1" }),
        }),
        expect.objectContaining({
          kind: "document",
          group: "review_now",
          resolvedTarget: expect.objectContaining({ documentKey: "listing-brief" }),
        }),
        expect.objectContaining({
          kind: "marketplace_link",
          group: "review_now",
          resolvedTarget: expect.objectContaining({ url: "https://www.ebay.es/itm/123456789" }),
        }),
        expect.objectContaining({
          kind: "file",
          group: "references",
          resolvedTarget: expect.objectContaining({
            path: "ops/cocktail-machine-sale/listing-templates/wallapop.txt",
          }),
          mentionCount: 2,
        }),
      ]),
    );
  });

  it("marks workspace path items unavailable when the issue has no project codebase", () => {
    const items = buildIssueReviewItems({
      issueId: "issue-1",
      issueDescription: null,
      hasProjectCodebase: false,
      comments: [
        makeComment(
          "comment-1",
          "Use file ops/cocktail-machine-sale/listing-templates/wallapop.txt",
          "2026-04-17T10:00:00.000Z",
        ),
      ],
      attachments: [],
      documents: [],
      workProducts: [],
    });

    expect(items).toEqual([
      expect.objectContaining({
        kind: "file",
        group: "hidden_context",
        status: "unavailable",
        previewState: "missing",
      }),
    ]);
  });

  it("ignores agent, project, and skill mention URIs when extracting review assets", () => {
    const items = buildIssueReviewItems({
      issueId: "issue-1",
      issueDescription: null,
      hasProjectCodebase: true,
      comments: [
        makeComment(
          "comment-1",
          [
            "Owner: [@Product Engineer - App](agent://8cb74f2d-9f0d-45f3-b820-e594f66a6133)",
            "Project: [@Website](project://project-123?c=0099ff)",
            "Skill: [@checks](skill://skill-123?s=checks)",
            "Preview: https://preview.paperclip.local/listings/preview-123",
          ].join("\n"),
          "2026-04-17T12:00:00.000Z",
        ),
      ],
      attachments: [],
      documents: [],
      workProducts: [],
    });

    expect(items).toEqual([
      expect.objectContaining({
        kind: "generic_link",
        resolvedTarget: expect.objectContaining({
          url: "https://preview.paperclip.local/listings/preview-123",
        }),
      }),
    ]);
  });
});

describe("buildIssueReviewPackSurface", () => {
  it("groups marketplace listing files into one hero review pack with light heuristic hints", () => {
    const items = buildIssueReviewItems({
      issueId: "issue-1",
      issueDescription:
        "Publish listings: Wallapop, Milanuncios, eBay ES. Use templates in ops/cocktail-machine-sale/listing-templates and photos pack. Post today; comment live links.",
      hasProjectCodebase: true,
      comments: [
        makeComment(
          "comment-1",
          [
            "Outputs:",
            "- ops/cocktail-machine-sale/listing-templates/wallapop.txt",
            "- ops/cocktail-machine-sale/listing-templates/milanuncios.txt",
            "- ops/cocktail-machine-sale/listing-templates/ebay-es.txt",
            "- ops/cocktail-machine-sale/listing-templates/master-listing.md",
            "- ops/cocktail-machine-sale/listing-templates/publication-checklist.md",
            "- ops/cocktail-machine-sale/listing-templates/README.md",
          ].join("\n"),
          "2026-04-17T10:00:00.000Z",
        ),
      ],
      attachments: [],
      documents: [],
      workProducts: [],
    });

    const surface = buildIssueReviewPackSurface({
      issueId: "issue-1",
      issueTitle: "Publish listings: Wallapop, Milanuncios, eBay ES",
      issueDescription:
        "Use templates in ops/cocktail-machine-sale/listing-templates and photos pack. Post today; comment live links.",
      reviewItems: items,
      boardState: null,
    });

    expect(surface?.heroPack).toEqual(
      expect.objectContaining({
        title: "Publish listings pack",
        primaryItemIds: expect.arrayContaining([
          "path:ops/cocktail-machine-sale/listing-templates/wallapop.txt",
          "path:ops/cocktail-machine-sale/listing-templates/milanuncios.txt",
          "path:ops/cocktail-machine-sale/listing-templates/ebay-es.txt",
        ]),
        evidenceItemIds: expect.arrayContaining([
          "path:ops/cocktail-machine-sale/listing-templates/master-listing.md",
          "path:ops/cocktail-machine-sale/listing-templates/publication-checklist.md",
          "path:ops/cocktail-machine-sale/listing-templates/README.md",
        ]),
      }),
    );
    expect(surface?.heroPack.reason).toContain("3");
    expect(surface?.heroPack.hints.map((hint) => hint.code)).toEqual(
      expect.arrayContaining(["missing_live_links", "no_visible_images"]),
    );
    expect(surface?.heroPack.hints.map((hint) => hint.code)).not.toContain("missing_previewable_artifact");
    expect(surface?.heroPack.mentionCount).toBe(6);
    expect(surface?.blockers).toEqual([]);
  });

  it("prefers a marketplace review target over a supporting document when picking the hero item", () => {
    const items = buildIssueReviewItems({
      issueId: "issue-1",
      issueDescription: null,
      hasProjectCodebase: true,
      comments: [
        makeComment(
          "comment-1",
          "Review the live listing at https://www.ebay.es/itm/123456789 before editing the brief.",
          "2026-04-17T10:00:00.000Z",
        ),
      ],
      attachments: [],
      documents: [
        makeDocument({
          id: "doc-2",
          key: "supporting-brief",
          title: "Supporting brief",
        }),
      ],
      workProducts: [],
    });

    const surface = buildIssueReviewPackSurface({
      issueId: "issue-1",
      issueTitle: "Review live listing",
      issueDescription: null,
      reviewItems: items,
      boardState: null,
    });

    expect(surface?.heroPack?.primaryItemIds).toEqual(["url:https://www.ebay.es/itm/123456789"]);
    expect(surface?.queue.map((pack) => pack.primaryItemIds[0])).toContain("document:doc-2");
  });

  it("keeps all ranked secondary targets in the queue so the UI can expand beyond the first four", () => {
    const items = buildIssueReviewItems({
      issueId: "issue-1",
      issueDescription: null,
      hasProjectCodebase: true,
      comments: [],
      attachments: [],
      documents: [],
      workProducts: [
        makeWorkProduct(),
        makeWorkProduct({
          id: "wp-2",
          title: "Secondary preview 1",
          url: "https://preview.paperclip.local/listings/preview-2",
        }),
        makeWorkProduct({
          id: "wp-3",
          title: "Secondary preview 2",
          url: "https://preview.paperclip.local/listings/preview-3",
        }),
        makeWorkProduct({
          id: "wp-4",
          title: "Secondary preview 3",
          url: "https://preview.paperclip.local/listings/preview-4",
        }),
        makeWorkProduct({
          id: "wp-5",
          title: "Secondary preview 4",
          url: "https://preview.paperclip.local/listings/preview-5",
        }),
        makeWorkProduct({
          id: "wp-6",
          title: "Secondary preview 5",
          url: "https://preview.paperclip.local/listings/preview-6",
        }),
      ],
    });

    const surface = buildIssueReviewPackSurface({
      issueId: "issue-1",
      issueTitle: "Review publish outputs",
      issueDescription: null,
      reviewItems: items,
      boardState: null,
    });

    expect(surface?.heroPack?.primaryItemIds).toEqual(["work_product:wp-1"]);
    expect(surface?.queue).toHaveLength(5);
    expect(surface?.queue.map((pack) => pack.primaryItemIds[0])).toEqual([
      "work_product:wp-2",
      "work_product:wp-3",
      "work_product:wp-4",
      "work_product:wp-5",
      "work_product:wp-6",
    ]);
  });

  it("emits a compact blocker rail only when board state materially affects reviewability", () => {
    const items = buildIssueReviewItems({
      issueId: "issue-1",
      issueDescription: "Published draft: https://preview.paperclip.local/listings/preview-123",
      hasProjectCodebase: true,
      comments: [],
      attachments: [],
      documents: [],
      workProducts: [makeWorkProduct()],
    });

    const boardState: IssueBoardState = {
      kind: "system_error",
      headline: "System error in issue state",
      reasonCode: null,
      actorType: "system",
      actorId: null,
      primaryAction: {
        type: "open_issue",
        label: "Inspect issue state",
        targetEntity: "issue",
        targetId: "issue-1",
      },
    };

    const surface = buildIssueReviewPackSurface({
      issueId: "issue-1",
      issueTitle: "Publish listing preview",
      issueDescription: null,
      reviewItems: items,
      boardState,
    });

    expect(surface?.blockers).toEqual([
      expect.objectContaining({
        title: "System error in issue state",
        actionLabel: "Inspect issue state",
        severity: "critical",
      }),
    ]);
  });

  it("explains capability-blocked review packs with a specialist-availability summary", () => {
    const items = buildIssueReviewItems({
      issueId: "issue-1",
      issueDescription: "Threat review needs staffing before it can proceed.",
      hasProjectCodebase: true,
      comments: [],
      attachments: [],
      documents: [],
      workProducts: [makeWorkProduct()],
    });

    const boardState: IssueBoardState = {
      kind: "blocked",
      headline: "No security specialist available",
      reasonCode: "capability_blocked",
      actorType: "system",
      actorId: "issue-1",
      primaryAction: {
        type: "open_issue",
        label: "Open issue",
        targetEntity: "issue",
        targetId: "issue-1",
      },
    };

    const surface = buildIssueReviewPackSurface({
      issueId: "issue-1",
      issueTitle: "Threat review",
      issueDescription: null,
      reviewItems: items,
      boardState,
    });

    expect(surface?.blockers).toEqual([
      expect.objectContaining({
        title: "No security specialist available",
        summary: "This review pack cannot advance because the required specialist role is unavailable.",
        actionLabel: "Open issue",
        severity: "warning",
      }),
    ]);
  });
});

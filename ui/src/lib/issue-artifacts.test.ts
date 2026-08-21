import { describe, expect, it } from "vitest";
import type { IssueAttachment, IssueWorkProduct } from "@paperclipai/shared";
import {
  documentDisplayTitle,
  isAgentAttachment,
  selectAgentArtifactAttachments,
  workProductHref,
} from "./issue-artifacts";

function makeAttachment(overrides: Partial<IssueAttachment> & { id: string }): IssueAttachment {
  return {
    companyId: "company-1",
    issueId: "issue-1",
    issueCommentId: null,
    assetId: "asset-1",
    provider: "local",
    objectKey: `objects/${overrides.id}`,
    contentType: "image/png",
    byteSize: 1024,
    sha256: "0".repeat(64),
    originalFilename: "shot.png",
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-08-01T12:00:00Z"),
    updatedAt: new Date("2026-08-01T12:00:00Z"),
    contentPath: `/api/attachments/${overrides.id}/content`,
    ...overrides,
  } as IssueAttachment;
}

function makePromotingWorkProduct(attachmentId: string): IssueWorkProduct {
  return {
    id: `wp-${attachmentId}`,
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: "output.png",
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: {
      attachmentId,
      contentType: "image/png",
      byteSize: 1024,
      contentPath: `/api/attachments/${attachmentId}/content`,
      openPath: `/api/attachments/${attachmentId}/content`,
      downloadPath: `/api/attachments/${attachmentId}/content?download=1`,
      originalFilename: "output.png",
    },
    createdByRunId: null,
    createdAt: new Date("2026-08-01T12:00:00Z"),
    updatedAt: new Date("2026-08-01T12:00:00Z"),
  } as IssueWorkProduct;
}

describe("isAgentAttachment", () => {
  it("accepts agent-authored rows regardless of comment binding", () => {
    expect(isAgentAttachment(makeAttachment({ id: "a", createdByAgentId: "agent-1" }))).toBe(true);
    expect(
      isAgentAttachment(
        makeAttachment({ id: "b", createdByAgentId: "agent-1", issueCommentId: "comment-1" }),
      ),
    ).toBe(true);
  });

  it("rejects user uploads", () => {
    expect(isAgentAttachment(makeAttachment({ id: "c", createdByUserId: "user-1" }))).toBe(false);
    expect(
      isAgentAttachment(
        makeAttachment({ id: "d", createdByUserId: "user-1", issueCommentId: "comment-1" }),
      ),
    ).toBe(false);
  });

  it("treats authorless rows as agent output only when not comment-bound", () => {
    expect(isAgentAttachment(makeAttachment({ id: "e" }))).toBe(true);
    expect(isAgentAttachment(makeAttachment({ id: "f", issueCommentId: "comment-1" }))).toBe(false);
  });
});

describe("selectAgentArtifactAttachments", () => {
  it("keeps agent attachments and drops user uploads", () => {
    const agent = makeAttachment({ id: "agent-file", createdByAgentId: "agent-1" });
    const user = makeAttachment({
      id: "user-file",
      createdByUserId: "user-1",
      issueCommentId: "comment-1",
    });
    expect(selectAgentArtifactAttachments([agent, user], [])).toEqual([agent]);
  });

  it("dedupes attachments already promoted to work products", () => {
    // The promotion metadata schema requires a UUID attachmentId.
    const promotedId = "00000000-0000-4000-8000-000000000001";
    const promoted = makeAttachment({ id: promotedId, createdByAgentId: "agent-1" });
    const loose = makeAttachment({ id: "loose", createdByAgentId: "agent-1" });
    const result = selectAgentArtifactAttachments(
      [promoted, loose],
      [makePromotingWorkProduct(promotedId)],
    );
    expect(result.map((a) => a.id)).toEqual(["loose"]);
  });

  it("tolerates missing inputs", () => {
    expect(selectAgentArtifactAttachments(null, null)).toEqual([]);
  });
});

describe("workProductHref", () => {
  it("prefers the top-level url", () => {
    expect(
      workProductHref({ url: "https://example.com/pr/1", metadata: { openPath: "/api/x" } }),
    ).toBe("https://example.com/pr/1");
  });

  it("falls back to metadata.openPath, then metadata.url", () => {
    expect(
      workProductHref({ url: null, metadata: { openPath: "/api/attachments/a/content" } }),
    ).toBe("/api/attachments/a/content");
    expect(
      workProductHref({ url: null, metadata: { url: "https://tunnel.here.now/x" } }),
    ).toBe("https://tunnel.here.now/x");
    expect(
      workProductHref({
        url: null,
        metadata: { openPath: "/api/attachments/a/content", url: "https://tunnel.here.now/x" },
      }),
    ).toBe("/api/attachments/a/content");
  });

  it("ignores non-string and blank metadata values", () => {
    expect(workProductHref({ url: null, metadata: { openPath: 42, url: "   " } })).toBeNull();
  });

  it("returns null without url or metadata links", () => {
    expect(workProductHref({ url: null, metadata: null })).toBeNull();
    expect(workProductHref({ url: null, metadata: { attachmentId: "a" } })).toBeNull();
  });
});

describe("documentDisplayTitle", () => {
  it("prefers the stored title", () => {
    expect(documentDisplayTitle({ key: "synthesis", title: "Findings Synthesis" })).toBe(
      "Findings Synthesis",
    );
  });

  it("humanizes the key when no title is set", () => {
    expect(documentDisplayTitle({ key: "synthesis", title: null })).toBe("Synthesis");
    expect(documentDisplayTitle({ key: "design_notes-v2", title: "  " })).toBe("Design notes v2");
  });
});

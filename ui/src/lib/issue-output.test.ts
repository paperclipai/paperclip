import { describe, expect, it } from "vitest";
import type { IssueWorkProduct } from "@paperclipai/shared";
import {
  formatBytes,
  formatDuration,
  getIssueOutputs,
  getOutputFileGlyph,
} from "./issue-output";

function makeWorkProduct(overrides: Partial<IssueWorkProduct> & { id: string }): IssueWorkProduct {
  return {
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: overrides.title ?? "output.mp4",
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: new Date("2026-05-30T12:00:00Z"),
    updatedAt: new Date("2026-05-30T12:00:00Z"),
    ...overrides,
  } as IssueWorkProduct;
}

let uuidCounter = 0;
function uuid() {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

function videoMetadata(attachmentId = uuid()) {
  return {
    attachmentId,
    contentType: "video/mp4",
    byteSize: 19_293_798,
    contentPath: `/api/attachments/${attachmentId}/content`,
    openPath: `/api/attachments/${attachmentId}/content`,
    downloadPath: `/api/attachments/${attachmentId}/content?download=1`,
    originalFilename: "demo.mp4",
  };
}

describe("formatBytes", () => {
  it("renders bytes below 1KB as whole bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("uses one trimmed decimal place from KB upward", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(412 * 1024)).toBe("412 KB");
    expect(formatBytes(19_293_798)).toBe("18.4 MB");
    expect(formatBytes(1.2 * 1024 * 1024 * 1024)).toBe("1.2 GB");
  });

  it("handles invalid input defensively", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-10)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  it("formats sub-hour durations as m:ss", () => {
    expect(formatDuration(58)).toBe("0:58");
    expect(formatDuration(102)).toBe("1:42");
  });

  it("formats durations over an hour as h:mm:ss", () => {
    expect(formatDuration(3600 + 42 * 60 + 9)).toBe("1:42:09");
  });
});

describe("getOutputFileGlyph", () => {
  it("maps known mime types to tone + label", () => {
    expect(getOutputFileGlyph("video/mp4")).toEqual({ label: "MP4", tone: "video" });
    expect(getOutputFileGlyph("video/quicktime")).toEqual({ label: "MOV", tone: "video" });
    expect(getOutputFileGlyph("application/pdf")).toEqual({ label: "PDF", tone: "pdf" });
    expect(getOutputFileGlyph("application/zip")).toEqual({ label: "ZIP", tone: "zip" });
    expect(getOutputFileGlyph("image/png")).toEqual({ label: "IMG", tone: "image" });
  });

  it("falls back to BIN for unknown types", () => {
    expect(getOutputFileGlyph("application/octet-stream")).toEqual({ label: "BIN", tone: "bin" });
    expect(getOutputFileGlyph(undefined)).toEqual({ label: "BIN", tone: "bin" });
  });
});

describe("getIssueOutputs", () => {
  it("ignores non-artifact work products and returns empty for no outputs", () => {
    const result = getIssueOutputs([
      makeWorkProduct({ id: "pr-1", type: "pull_request" }),
      makeWorkProduct({ id: "doc-1", type: "document" }),
      makeWorkProduct({ id: "artifact-1", type: "artifact", provider: "custom", metadata: videoMetadata() }),
    ]);
    expect(result.count).toBe(0);
    expect(result.primary).toBeNull();
    expect(result.rest).toEqual([]);
  });

  it("parses a single video artifact into a primary output", () => {
    const result = getIssueOutputs([
      makeWorkProduct({ id: "wp-1", metadata: videoMetadata(), isPrimary: true }),
    ]);
    expect(result.count).toBe(1);
    expect(result.primary?.id).toBe("wp-1");
    expect(result.primary?.degraded).toBe(false);
    expect(result.primary?.metadata?.contentType).toBe("video/mp4");
    expect(result.rest).toEqual([]);
  });

  it("orders the explicit primary first, then most recent", () => {
    const result = getIssueOutputs([
      makeWorkProduct({
        id: "old",
        createdAt: new Date("2026-05-29T10:00:00Z"),
        metadata: videoMetadata(),
      }),
      makeWorkProduct({
        id: "primary",
        isPrimary: true,
        createdAt: new Date("2026-05-28T10:00:00Z"),
        metadata: videoMetadata(),
      }),
      makeWorkProduct({
        id: "recent",
        createdAt: new Date("2026-05-30T10:00:00Z"),
        metadata: videoMetadata(),
      }),
    ]);
    expect(result.primary?.id).toBe("primary");
    expect(result.rest.map((r) => r.id)).toEqual(["recent", "old"]);
  });

  it("marks artifacts with invalid metadata as degraded without throwing", () => {
    const result = getIssueOutputs([
      makeWorkProduct({
        id: "broken",
        metadata: { attachmentId: "att-x", contentType: "video/mp4" } as Record<string, unknown>,
      }),
    ]);
    expect(result.count).toBe(1);
    expect(result.primary?.degraded).toBe(true);
    expect(result.primary?.metadata).toBeNull();
  });
});

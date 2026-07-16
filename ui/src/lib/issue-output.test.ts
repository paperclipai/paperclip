import { describe, expect, it } from "vitest";
import type { IssueWorkProduct } from "@paperclipai/shared";
import {
  formatBytes,
  formatDuration,
  getIssueOutputs,
  getOutputFileGlyph,
  getPromotedOutputAttachmentIds,
  isOutputEligibleContentType,
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

function artifactMetadata(contentType: string, originalFilename: string, attachmentId = uuid()) {
  return {
    ...videoMetadata(attachmentId),
    contentType,
    originalFilename,
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
    expect(getOutputFileGlyph("video/mp4; charset=binary")).toEqual({ label: "MP4", tone: "video" });
    expect(getOutputFileGlyph("video/quicktime")).toEqual({ label: "MOV", tone: "video" });
    expect(getOutputFileGlyph("application/pdf")).toEqual({ label: "PDF", tone: "pdf" });
    expect(getOutputFileGlyph("application/zip")).toEqual({ label: "ZIP", tone: "zip" });
    expect(getOutputFileGlyph("image/png")).toEqual({ label: "IMG", tone: "image" });
  });

  it("falls back to BIN for unknown types", () => {
    expect(getOutputFileGlyph("application/octet-stream")).toEqual({ label: "BIN", tone: "bin" });
    expect(getOutputFileGlyph(undefined)).toEqual({ label: "BIN", tone: "bin" });
  });

  it("labels document-like fallbacks defensively", () => {
    expect(getOutputFileGlyph("text/plain")).toEqual({ label: "TXT", tone: "bin" });
    expect(getOutputFileGlyph("text/markdown")).toEqual({ label: "MD", tone: "bin" });
    expect(getOutputFileGlyph("application/json; charset=utf-8")).toEqual({ label: "JSON", tone: "bin" });
    expect(getOutputFileGlyph("application/wasm")).toEqual({ label: "WASM", tone: "bin" });
  });
});

describe("isOutputEligibleContentType", () => {
  it("keeps media, pdf, zip, and true generic binary outputs eligible", () => {
    expect(isOutputEligibleContentType("video/mp4; charset=binary")).toBe(true);
    expect(isOutputEligibleContentType("image/png")).toBe(true);
    expect(isOutputEligibleContentType("image/svg+xml")).toBe(true);
    expect(isOutputEligibleContentType("application/pdf")).toBe(true);
    expect(isOutputEligibleContentType("application/vnd.example.bundle+zip")).toBe(true);
    expect(isOutputEligibleContentType("application/wasm")).toBe(true);
    expect(isOutputEligibleContentType("application/octet-stream")).toBe(true);
    expect(isOutputEligibleContentType("application/octet-stream", "build.bin")).toBe(true);
  });

  it("filters document-like and source formats out of outputs", () => {
    expect(isOutputEligibleContentType("text/markdown")).toBe(false);
    expect(isOutputEligibleContentType("text/plain")).toBe(false);
    expect(isOutputEligibleContentType("application/json")).toBe(false);
    expect(isOutputEligibleContentType("application/vnd.api+json")).toBe(false);
    expect(isOutputEligibleContentType("text/html")).toBe(false);
    expect(isOutputEligibleContentType("application/xml")).toBe(false);
    expect(isOutputEligibleContentType("text/csv")).toBe(false);
    expect(isOutputEligibleContentType("application/x-yaml")).toBe(false);
    expect(isOutputEligibleContentType("application/octet-stream", "report.md")).toBe(false);
    expect(isOutputEligibleContentType("application/octet-stream", "notes.txt")).toBe(false);
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

  it("ignores markdown and text artifact metadata instead of promoting them to outputs", () => {
    const result = getIssueOutputs([
      makeWorkProduct({ id: "markdown", metadata: artifactMetadata("text/markdown", "report.md") }),
      makeWorkProduct({ id: "text", metadata: artifactMetadata("text/plain", "notes.txt") }),
      makeWorkProduct({ id: "json", metadata: artifactMetadata("application/json", "summary.json") }),
      makeWorkProduct({ id: "generic-markdown", metadata: artifactMetadata("application/octet-stream", "legacy-report.md") }),
    ]);
    expect(result.count).toBe(0);
    expect(result.primary).toBeNull();
  });

  it("keeps video, image, pdf, zip, and binary artifact metadata as outputs", () => {
    const result = getIssueOutputs([
      makeWorkProduct({ id: "video", metadata: artifactMetadata("video/mp4", "demo.mp4") }),
      makeWorkProduct({ id: "image", metadata: artifactMetadata("image/png", "screenshot.png") }),
      makeWorkProduct({ id: "svg", metadata: artifactMetadata("image/svg+xml", "diagram.svg") }),
      makeWorkProduct({ id: "pdf", metadata: artifactMetadata("application/pdf", "brief.pdf") }),
      makeWorkProduct({ id: "zip", metadata: artifactMetadata("application/zip; charset=binary", "bundle.zip") }),
      makeWorkProduct({ id: "wasm", metadata: artifactMetadata("application/wasm", "module.wasm") }),
      makeWorkProduct({ id: "binary", metadata: artifactMetadata("application/octet-stream", "build.bin") }),
    ]);
    expect(result.items.map((item) => item.id)).toEqual(["video", "image", "svg", "pdf", "zip", "wasm", "binary"]);
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

describe("getPromotedOutputAttachmentIds", () => {
  it("returns backing attachment ids only for work products promoted to outputs", () => {
    const videoAttachmentId = uuid();
    const markdownAttachmentId = uuid();
    const ids = getPromotedOutputAttachmentIds([
      makeWorkProduct({ id: "video", metadata: videoMetadata(videoAttachmentId) }),
      makeWorkProduct({ id: "markdown", metadata: artifactMetadata("text/markdown", "report.md", markdownAttachmentId) }),
      makeWorkProduct({ id: "broken", metadata: { attachmentId: "bad" } as Record<string, unknown> }),
    ]);

    expect(Array.from(ids)).toEqual([videoAttachmentId]);
  });
});

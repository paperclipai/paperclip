import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { IssueOutputSection } from "./IssueOutputSection";

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
    title: "output",
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

const UUIDS: Record<string, string> = {
  "att-1": "11111111-1111-4111-8111-111111111111",
  "att-vid": "22222222-2222-4222-8222-222222222222",
  "att-pdf": "33333333-3333-4333-8333-333333333333",
};

function metadata(key: string, contentType: string, filename: string) {
  const attachmentId = UUIDS[key] ?? key;
  return {
    attachmentId,
    contentType,
    byteSize: 19_293_798,
    contentPath: `/api/attachments/${attachmentId}/content`,
    openPath: `/api/attachments/${attachmentId}/content`,
    downloadPath: `/api/attachments/${attachmentId}/content?download=1`,
    originalFilename: filename,
  };
}

describe("IssueOutputSection", () => {
  it("renders a playable, downloadable video as the primary output", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[
          makeWorkProduct({
            id: "wp-1",
            title: "Demo walkthrough",
            isPrimary: true,
            metadata: metadata("att-1", "video/mp4", "demo.mp4"),
          }),
        ]}
      />,
    );

    // Native video player present
    expect(markup).toContain("<video");
    expect(markup).toContain("controls");
    expect(markup).toContain(`/api/attachments/${UUIDS["att-1"]}/content`);
    // Filename surfaced and download/open wired
    expect(markup).toContain("demo.mp4");
    expect(markup).toContain(`/api/attachments/${UUIDS["att-1"]}/content?download=1`);
    expect(markup).toContain("Download");
    expect(markup).toContain("Open");
    // Section header + size formatting
    expect(markup).toContain("Output");
    expect(markup).toContain("18.4 MB");
  });

  it("renders nothing when the issue has no artifact outputs (empty state)", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[
          makeWorkProduct({ id: "pr-1", type: "pull_request" }),
        ]}
      />,
    );
    expect(markup).toBe("");
  });

  it("renders the primary card plus an Also produced list for multiple outputs", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[
          makeWorkProduct({
            id: "wp-primary",
            isPrimary: true,
            createdAt: new Date("2026-05-30T12:00:00Z"),
            metadata: metadata("att-vid", "video/mp4", "summary.mp4"),
          }),
          makeWorkProduct({
            id: "wp-pdf",
            createdAt: new Date("2026-05-30T11:00:00Z"),
            metadata: metadata("att-pdf", "application/pdf", "talking-points.pdf"),
          }),
        ]}
      />,
    );

    expect(markup).toContain("Also produced");
    expect(markup).toContain("summary.mp4");
    expect(markup).toContain("talking-points.pdf");
    // PDF glyph tile label appears for the secondary row
    expect(markup).toContain("PDF");
  });

  it("surfaces an output with failed/invalid attachment metadata without crashing", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[
          makeWorkProduct({
            id: "wp-broken",
            title: "broken-output.mp4",
            isPrimary: true,
            // Missing required path fields → fails the shared metadata schema
            metadata: { attachmentId: "att-x", contentType: "video/mp4" } as Record<string, unknown>,
          }),
        ]}
      />,
    );

    expect(markup).toContain("broken-output.mp4");
    expect(markup).toContain("metadata is unavailable");
    // No video element and no download link can be built from invalid metadata
    expect(markup).not.toContain("<video");
    expect(markup).not.toContain("download=1");
  });
});

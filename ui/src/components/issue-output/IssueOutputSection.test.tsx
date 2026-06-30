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
  "att-img": "44444444-4444-4444-8444-444444444444",
  "att-webm": "55555555-5555-4555-8555-555555555555",
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

  it("keeps the open action for primary videos when gallery browsing is enabled", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[
          makeWorkProduct({
            id: "wp-video",
            title: "Demo walkthrough",
            isPrimary: true,
            metadata: metadata("att-1", "video/mp4", "demo.mp4"),
          }),
        ]}
        onMediaClick={() => undefined}
      />,
    );

    expect(markup).toContain("Browse");
    expect(markup).toContain("Open");
    expect(markup).toContain(`href="/api/attachments/${UUIDS["att-1"]}/content"`);
    expect(markup).toContain("Download");
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

  it("renders nothing for markdown-only artifact work products", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[
          makeWorkProduct({
            id: "wp-markdown",
            title: "plan.md",
            isPrimary: true,
            metadata: metadata("att-1", "text/markdown", "plan.md"),
          }),
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

  it("renders secondary image and video outputs as preview tiles", () => {
    const markup = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[
          makeWorkProduct({
            id: "wp-primary",
            isPrimary: true,
            metadata: metadata("att-pdf", "application/pdf", "brief.pdf"),
          }),
          makeWorkProduct({
            id: "wp-image",
            createdAt: new Date("2026-05-30T11:00:00Z"),
            metadata: metadata("att-img", "image/png", "screenshot.png"),
          }),
          makeWorkProduct({
            id: "wp-video",
            createdAt: new Date("2026-05-30T10:00:00Z"),
            metadata: metadata("att-webm", "video/webm", "clip.webm"),
          }),
        ]}
      />,
    );

    expect(markup).toContain("Also produced");
    expect(markup).toContain("screenshot.png");
    expect(markup).toContain("clip.webm");
    expect(markup).toContain("<img");
    expect(markup).toContain("<video");
    expect(markup).toContain("Open screenshot.png");
    expect(markup).toContain("Open clip.webm");
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

// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ReviewedArtifactResolved, ReviewedArtifactsResponse } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewedAssetsPanel } from "./ReviewedAssetsPanel";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="markdown-body" className={className}>{children}</div>
  ),
}));

vi.mock("./ImageGalleryModal", () => ({
  ImageGalleryModal: ({ images, open }: { images: unknown[]; open: boolean }) => {
    const firstImage = images[0] as { companyId?: string; issueId?: string } | undefined;
    return (
      <div
        data-testid="image-gallery"
        data-count={images.length}
        data-open={String(open)}
        data-company-id={firstImage?.companyId ?? ""}
        data-issue-id={firstImage?.issueId ?? ""}
      />
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createArtifact(overrides: Partial<ReviewedArtifactResolved> = {}): ReviewedArtifactResolved {
  return {
    id: overrides.id ?? "artifact-1",
    sourceType: overrides.sourceType ?? "issue_document",
    source: overrides.source ?? { type: "issue_document", issueId: "issue-1", key: "plan" },
    sourceIssue: overrides.sourceIssue ?? { id: "issue-1", identifier: "DIG-1", title: "Issue" },
    title: overrides.title ?? "Artifact",
    description: overrides.description ?? "Artifact summary",
    sortOrder: overrides.sortOrder ?? 0,
    isPrimary: overrides.isPrimary ?? false,
    required: overrides.required ?? false,
    selectedExplicitly: overrides.selectedExplicitly ?? true,
    resolution: overrides.resolution ?? { status: "resolved", reason: null },
    preview: overrides.preview ?? { mode: "download_only", previewable: false, downloadUrl: "/download" },
    document: "document" in overrides ? overrides.document : { key: "plan", revisionId: "rev-1", revisionNumber: 1 },
    snapshot: overrides.snapshot ?? { updatedAt: "2026-04-01T00:00:00.000Z" },
  };
}

function response(artifacts: ReviewedArtifactResolved[], errors: ReviewedArtifactsResponse["errors"] = []): ReviewedArtifactsResponse {
  return { artifacts, errors };
}

function renderPanel(
  container: HTMLDivElement,
  props: Partial<ComponentProps<typeof ReviewedAssetsPanel>> = {},
) {
  const root = createRoot(container);
  act(() => {
    root.render(
      <ReviewedAssetsPanel
        response={props.response ?? response([])}
        isLoading={props.isLoading}
        error={props.error}
        issuePathId={props.issuePathId ?? "DIG-1"}
        companyId={props.companyId ?? "company-1"}
        title={props.title}
        subtitle={props.subtitle}
      />,
    );
  });
  return root;
}

describe("ReviewedAssetsPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T01:00:00.000Z"));
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("renders loading and empty explicit states", () => {
    let root = renderPanel(container, { isLoading: true });
    expect(container.querySelector('[data-testid="reviewed-assets-loading"]')).not.toBeNull();
    act(() => root.unmount());

    root = renderPanel(container, { response: response([]) });
    expect(container.querySelector('[data-testid="reviewed-assets-empty"]')?.textContent).toContain(
      "No reviewed assets selected yet",
    );
    act(() => root.unmount());
  });

  it("labels suggested fallback assets without presenting them as selected", () => {
    const root = renderPanel(container, {
      response: response([
        createArtifact({
          id: "suggested",
          title: "Preview URL",
          sourceType: "issue_work_product",
          selectedExplicitly: false,
          isPrimary: true,
          preview: { mode: "link", previewable: false, externalUrl: "https://example.com" },
          document: null,
        }),
      ]),
    });

    expect(container.textContent).toContain("Suggested review assets");
    expect(container.textContent).toContain("Suggested");
    expect(container.textContent).not.toContain("Selected");
    act(() => root.unmount());
  });

  it("renders multiple artifacts with normalized primary and partial-failure metadata", () => {
    const root = renderPanel(container, {
      response: response([
        createArtifact({ id: "secondary", title: "Secondary", sortOrder: 2 }),
        createArtifact({ id: "primary", title: "Primary", sortOrder: 1, isPrimary: true }),
      ], [{ source: "manifest", status: 500, message: "Manifest failed" }]),
    });

    const cards = Array.from(container.querySelectorAll('[data-testid="reviewed-asset-card"]'));
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain("Primary");
    expect(cards[1]?.textContent).toContain("Secondary");
    expect(container.textContent).toContain("Some assets could not load");
    expect(container.textContent).toContain("manifest: Manifest failed");
    act(() => root.unmount());
  });

  it("renders markdown and image previews from backend preview mode", () => {
    const root = renderPanel(container, {
      response: response([
        createArtifact({
          id: "markdown",
          title: "Plan",
          preview: { mode: "markdown", previewable: true, markdownBody: "# Plan" },
        }),
        createArtifact({
          id: "image",
          title: "Screenshot",
          preview: { mode: "image", previewable: true, previewUrl: "/image.png", contentType: "image/png" },
          sourceIssue: { id: "issue-not-company", identifier: "DIG-2", title: "Different issue" },
          document: null,
        }),
      ]),
      companyId: "company-123",
    });

    expect(container.querySelector('[data-testid="markdown-body"]')?.textContent).toContain("# Plan");
    expect((container.querySelector("img") as HTMLImageElement | null)?.src).toContain("/image.png");
    const previewButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Preview"));
    act(() => previewButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const gallery = container.querySelector('[data-testid="image-gallery"]');
    expect(gallery?.getAttribute("data-open")).toBe("true");
    expect(gallery?.getAttribute("data-company-id")).toBe("company-123");
    expect(gallery?.getAttribute("data-issue-id")).toBe("issue-not-company");
    act(() => root.unmount());
  });

  it("renders link and download-only assets with safe actions", () => {
    const root = renderPanel(container, {
      response: response([
        createArtifact({
          id: "link",
          title: "Pull request",
          sourceType: "issue_work_product",
          preview: { mode: "link", previewable: false, externalUrl: "https://github.com/example/pr/1" },
          document: null,
          snapshot: { provider: "github", status: "ready_for_review" },
        }),
        createArtifact({
          id: "download",
          title: "Archive",
          sourceType: "issue_attachment",
          preview: { mode: "download_only", previewable: false, downloadUrl: "/download.zip", contentType: "application/zip" },
          document: null,
        }),
      ]),
    });

    expect(container.querySelector('[data-testid="reviewed-artifact-link"]')?.textContent).toContain("github");
    expect(container.querySelector('a[href="https://github.com/example/pr/1"]')?.textContent).toContain("Open");
    expect(container.querySelector('[data-testid="reviewed-artifact-download"]')?.textContent).toContain("Download this asset");
    expect(container.querySelector('a[href="/download.zip"]')?.textContent).toContain("Download");
    expect(container.querySelector("iframe")).toBeNull();
    act(() => root.unmount());
  });

  it("renders unsupported, missing, and permission-denied asset states", () => {
    const root = renderPanel(container, {
      response: response([
        createArtifact({
          id: "unsupported",
          title: "Vector",
          resolution: { status: "unsupported", reason: "SVG is download-only." },
          preview: { mode: "image", previewable: true, previewUrl: "/logo.svg", contentType: "image/svg+xml" },
        }),
        createArtifact({
          id: "missing",
          title: "Deleted",
          resolution: { status: "missing", reason: "Deleted after review." },
        }),
        createArtifact({
          id: "permission",
          title: "Private",
          resolution: { status: "permission_denied", reason: "Access denied." },
        }),
      ]),
    });

    expect(container.querySelector('[data-testid="reviewed-artifact-unsupported"]')?.textContent).toContain("SVG is download-only");
    expect(container.querySelector('[data-testid="reviewed-artifact-missing"]')?.textContent).toContain("Deleted after review");
    expect(container.querySelector('[data-testid="reviewed-artifact-permission_denied"]')?.textContent).toContain("Access denied");
    expect(container.querySelector("img")).toBeNull();
    act(() => root.unmount());
  });
});

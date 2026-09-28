import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssueWorkProduct } from "@paperclipai/shared";
import {
  IssueArtifactFile,
  IssueWorkProductArtifactCard,
} from "./IssueArtifactCard";

import { DocumentCard } from "./RichArtifactCards";

function product(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id: "wp-1",
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "Actual artifact title",
    url: "https://github.com/org/repo/pull/42",
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: "Actual artifact summary",
    metadata: null,
    createdByRunId: null,
    createdAt: new Date("2026-09-28"),
    updatedAt: new Date("2026-09-28"),
    ...overrides,
  };
}
function render(wp: IssueWorkProduct) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IssueWorkProductArtifactCard workProduct={wp} author="Actual agent" />
    </QueryClientProvider>,
  );
}

describe("production artifact cards", () => {
  it("renders supplied PR metadata without synthesizing missing counts, checks or branch names", () => {
    const sparse = render(product());
    expect(sparse).toContain("Actual artifact title");
    expect(sparse).toContain("Actual artifact summary");
    expect(sparse).toContain("Actual agent");
    expect(sparse).toContain("Checks not available");
    expect(sparse).not.toContain("Checks passed");
    expect(sparse).not.toContain("+0");
    expect(sparse).not.toContain("#0");
    expect(sparse).not.toContain("master");
    const full = render(
      product({
        metadata: {
          number: 42,
          repo: "org/repo",
          state: "draft",
          additions: 0,
          deletions: 8,
          changedFiles: 2,
          headRef: "feature",
          baseRef: "main",
        },
      }),
    );
    for (const value of [
      "#42",
      "org/repo",
      "Draft",
      "+0",
      "−8",
      "feature",
      "main",
    ])
      expect(full).toContain(value);
  });
  it("preserves review and unhealthy states", () => {
    expect(
      render(product({ reviewState: "changes_requested", status: "merged" })),
    ).toContain("Changes requested");
    expect(
      render(product({ type: "preview_url", healthStatus: "unhealthy" })),
    ).toContain("Unhealthy");
    expect(
      render(product({ type: "preview_url", healthStatus: "unknown" })),
    ).not.toContain("Healthy");
  });
  it("selects commit, link, image, video and file renderers from real records", () => {
    expect(
      render(
        product({
          type: "commit",
          metadata: { sha: "123456789abcdef", repo: "org/repo" },
        }),
      ),
    ).toContain("12345678");
    expect(render(product({ type: "preview_url" }))).toContain("Open link");
    const attachment = {
      contentPath: "/api/attachments/file-1/content",
      byteSize: 25,
    };
    expect(
      render(
        product({
          type: "artifact",
          metadata: {
            ...attachment,
            contentType: "image/png",
            originalFilename: "actual.png",
          },
        }),
      ),
    ).toContain("View image");
    const video = render(
      product({
        type: "artifact",
        metadata: {
          ...attachment,
          contentType: "video/mp4",
          originalFilename: "actual.mp4",
        },
      }),
    );
    expect(video).toContain("<video");
    expect(video).toContain("controls");
    expect(video).not.toContain("autoplay");
    const file = render(
      product({
        type: "artifact",
        metadata: {
          ...attachment,
          contentType: "application/pdf",
          originalFilename: "actual.pdf",
        },
      }),
    );
    expect(file).toContain("Download file");
    expect(file).toContain("25 B");
    expect(file).toContain("?download=1");
  });
  it("shows parsed attachment rows and downloads the original CSV", () => {
    const client = new QueryClient();
    client.setQueryData(
      ["artifact-csv", "csv-1", "/api/attachments/csv-1/content", "Today"],
      { columns: ["Region"], rows: [["Actual region"]], truncated: false },
    );
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <IssueArtifactFile
          id="csv-1"
          title="Report"
          summary=""
          author=""
          updatedAt="Today"
          filename="actual.csv"
          contentType="text/csv"
          contentPath="/api/attachments/csv-1/content"
          downloadPath="/api/attachments/csv-1/content?download=1"
          byteSize={100}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("Actual region");
    expect(html).toContain("View data");
  });
  it("does not fetch remote Markdown images just to render a document preview", () => {
    const html = renderToStaticMarkup(
      <DocumentCard
        title="Report"
        summary=""
        author=""
        updatedAt=""
        filename="report.md"
        revision={1}
        body="![External image](https://tracker.example/image.png)\n\n![Uploaded image](/api/attachments/image-1/content)"
      />,
    );
    expect(html).not.toContain('src="https://tracker.example');
    expect(html).toContain('href="https://tracker.example/image.png"');
    expect(html).toContain('src="/api/attachments/image-1/content"');
  });
  it("does not automatically load remote thumbnail or poster metadata", () => {
    const link = render(
      product({
        type: "preview_url",
        metadata: { imageUrl: "https://tracker.example/pixel.png" },
      }),
    );
    expect(link).not.toContain("<img");
    expect(link).not.toContain("tracker.example");
    const video = render(
      product({
        type: "artifact",
        metadata: {
          contentType: "video/mp4",
          contentPath: "/api/attachments/file-1/content",
          posterUrl: "https://tracker.example/poster.png",
        },
      }),
    );
    expect(video).not.toContain("poster=");
    const local = render(
      product({
        type: "preview_url",
        metadata: { imageUrl: "/api/attachments/thumbnail-1/content" },
      }),
    );
    expect(local).toContain('src="/api/attachments/thumbnail-1/content"');
  });
  it("keeps branch and runtime actions and blocks unsafe artifact URLs", () => {
    expect(render(product({ type: "branch" }))).toContain("Open on GitHub");
    expect(
      render(product({ type: "runtime_service", healthStatus: "unhealthy" })),
    ).toContain("Unhealthy");
    expect(
      render(product({ type: "preview_url", url: "javascript:alert(1)" })),
    ).not.toContain("javascript:");
  });
});

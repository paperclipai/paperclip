// @vitest-environment node
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IssueAttachment, IssueWorkProduct } from "@paperclipai/shared";
import { ThemeProvider } from "@/context/ThemeContext";
import { IssueOutputSection } from "../issue-output/IssueOutputSection";
import { IssueAttachmentsSection } from "../IssueAttachmentsSection";
import { TaskChatBubble } from "./TaskChatBubble";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode } & React.ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/PAP/issues/PAP-1", search: "", hash: "", state: null }),
}));

vi.mock("@/hooks/useArtifactsV1Enabled", () => ({
  useArtifactsV1Enabled: () => ({ enabled: false }),
}));

vi.mock("@/hooks/useAgentChatRead", () => ({
  useAgentChatRead: () => () => undefined,
}));

vi.mock("@/components/coordinator/CoordinatorPresentation", () => ({
  useCoordinatorPresentation: () => false,
}));

vi.mock("@/components/EmailMessageCard", () => ({
  useEmailComment: () => null,
}));

describe("Responsive media grids and chat bubble table containment", () => {
  it("uses grid-cols-2 sm:grid-cols-4 in IssueOutputSection media grids", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const makeImage = (id: string, attachmentId: string, filename: string): IssueWorkProduct => ({
      id,
      companyId: "company-1",
      projectId: null,
      issueId: "issue-1",
      executionWorkspaceId: null,
      runtimeServiceId: null,
      type: "artifact",
      provider: "paperclip",
      externalId: id,
      title: filename,
      url: `/api/attachments/${attachmentId}/content`,
      status: "active",
      reviewState: "none",
      isPrimary: id === "wp-1",
      healthStatus: "unknown",
      summary: null,
      metadata: {
        attachmentId,
        contentPath: `/api/attachments/${attachmentId}/content`,
        openPath: `/api/attachments/${attachmentId}/content`,
        downloadPath: `/api/attachments/${attachmentId}/content?download=1`,
        contentType: "image/png",
        byteSize: 1024,
        originalFilename: filename,
      },
      createdByRunId: null,
      createdAt: now,
      updatedAt: now,
    });

    const html = renderToStaticMarkup(
      <IssueOutputSection
        workProducts={[
          makeImage("wp-1", "11111111-1111-4111-8111-111111111111", "primary.png"),
          makeImage("wp-2", "22222222-2222-4222-8222-222222222222", "second.png"),
        ]}
      />,
    );

    expect(html).toContain("grid grid-cols-2 gap-2 sm:grid-cols-4");
    expect(html).not.toContain('class="grid grid-cols-4 gap-2"');
  });

  it("uses grid-cols-2 sm:grid-cols-4 in IssueAttachmentsSection image grids", () => {
    const attachments: IssueAttachment[] = [
      {
        id: "att-1",
        companyId: "company-1",
        issueId: "issue-1",
        issueCommentId: null,
        assetId: "asset-1",
        provider: "local",
        objectKey: "att-1.png",
        contentType: "image/png",
        byteSize: 2048,
        sha256: "abc",
        originalFilename: "shot-1.png",
        createdByAgentId: null,
        createdByUserId: null,
        createdAt: new Date("2026-08-01T12:00:00Z"),
        updatedAt: new Date("2026-08-01T12:00:00Z"),
        contentPath: "/api/attachments/att-1/content",
      },
    ];

    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <IssueAttachmentsSection attachments={attachments} onImageClick={() => undefined} />
      </QueryClientProvider>,
    );

    expect(html).toContain("grid grid-cols-2 gap-2 sm:grid-cols-4");
    expect(html).not.toContain('class="grid grid-cols-4 gap-2"');
  });

  it("keeps TaskChatBubble flex containers min-w-0 max-w-full and uses responsive 2-to-4 column media grids", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <TaskChatBubble
            item={{
              kind: "message",
              id: "msg-1",
              author: "agent",
              authorName: "Chief of Staff",
              text: [
                "| Column A | Column B | Column C | Column D | Column E |",
                "| --- | --- | --- | --- | --- |",
                "| val-1 | val-2 | val-3 | val-4 | val-5 |",
                "",
                "![Shot 1](/api/attachments/a1/content)",
              ].join("\n"),
              timestamp: "12:00 PM",
            }}
          />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain("flex w-full min-w-0 flex-col gap-1");
    expect(html).toContain("min-w-0 max-w-full break-words py-2 text-sm");
    expect(html).toContain("paperclip-markdown-table-scroll max-w-full overflow-x-auto");
    expect(html).toContain("grid grid-cols-2 gap-2 sm:grid-cols-4");
  });
});

// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueAttachment } from "@paperclipai/shared";
import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueAttachmentsSection } from "./IssueAttachmentsSection";

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: string; className?: string }) => (
    <div className={className} data-testid="markdown-body">{children}</div>
  ),
}));

vi.mock("./FoldCurtain", () => ({
  FoldCurtain: ({ children }: { children?: ReactNode }) => <div data-testid="fold-curtain">{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    asChild,
    children,
    onClick,
    type = "button",
    ...props
  }: ComponentProps<"button"> & { asChild?: boolean }) => {
    if (asChild) return <>{children}</>;
    return <button type={type} onClick={onClick} {...props}>{children}</button>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function makeAttachment(overrides: Partial<IssueAttachment> = {}): IssueAttachment {
  return {
    id: "attachment-1",
    companyId: "company-1",
    issueId: "issue-1",
    issueCommentId: null,
    assetId: "asset-1",
    provider: "local_disk",
    objectKey: "att-1",
    contentType: "text/plain",
    byteSize: 1024,
    sha256: "sha",
    originalFilename: "notes.txt",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    contentPath: "/api/attachments/attachment-1/content",
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushReact();
    }
  }
  throw lastError;
}

describe("IssueAttachmentsSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("# Imported plan\n\n- Use the document renderer"),
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders markdown attachments with the document markdown presentation", async () => {
    const attachment = makeAttachment({
      id: "markdown-attachment",
      originalFilename: "plan.md",
      contentType: "text/plain",
      contentPath: "/api/attachments/markdown-attachment/content",
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueAttachmentsSection
            attachments={[attachment]}
            onDelete={vi.fn()}
            onImageClick={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/attachments/markdown-attachment/content",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: expect.stringContaining("text/markdown") }),
      }),
    );
    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="fold-curtain"]')).toBeTruthy();
      const markdownBody = container.querySelector('[data-testid="markdown-body"]');
      expect(markdownBody?.textContent).toContain("Imported plan");
      expect(markdownBody?.className).toContain("paperclip-edit-in-place-content");
    });
  });

  it("does not promote specific non-markdown content types by filename alone", async () => {
    const attachment = makeAttachment({
      id: "zip-markdown",
      originalFilename: "report.md",
      contentType: "application/zip",
      contentPath: "/api/attachments/zip-markdown/content",
      openPath: "/api/attachments/zip-markdown/content",
      downloadPath: "/api/attachments/zip-markdown/content?download=1",
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueAttachmentsSection
            attachments={[attachment]}
            onDelete={vi.fn()}
            onImageClick={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('[data-testid="markdown-body"]')).toBeNull();
    expect(container.textContent).toContain("report.md");
    expect(container.textContent).toContain("application/zip");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders video attachments through the same player used for artifact outputs", async () => {
    const attachment = makeAttachment({
      id: "video-attachment",
      originalFilename: "demo.webm",
      contentType: "video/webm",
      contentPath: "/api/attachments/video-attachment/content",
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueAttachmentsSection
            attachments={[attachment]}
            onDelete={vi.fn()}
            onImageClick={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toBe("/api/attachments/video-attachment/content");
    expect(video?.getAttribute("controls")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets video attachments open the shared media gallery", async () => {
    const attachment = makeAttachment({
      id: "video-attachment",
      originalFilename: "demo.webm",
      contentType: "video/webm",
      contentPath: "/api/attachments/video-attachment/content",
    });
    const onImageClick = vi.fn();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueAttachmentsSection
            attachments={[attachment]}
            onDelete={vi.fn()}
            onImageClick={onImageClick}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const browse = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Browse demo.webm in gallery"]',
    );
    expect(browse).toBeTruthy();

    await act(async () => {
      browse?.click();
    });

    expect(onImageClick).toHaveBeenCalledWith(attachment);
  });

  it("treats mp4 filenames as playable videos even with a generic binary content type", async () => {
    const attachment = makeAttachment({
      id: "misclassified-mp4",
      originalFilename: "demo.mp4",
      contentType: "application/octet-stream",
      contentPath: "/api/attachments/misclassified-mp4/content",
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueAttachmentsSection
            attachments={[attachment]}
            onDelete={vi.fn()}
            onImageClick={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toBe("/api/attachments/misclassified-mp4/content");
    expect(container.textContent).toContain("application/octet-stream");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not promote specific non-video content types by filename alone", async () => {
    const attachment = makeAttachment({
      id: "zip-mp4",
      originalFilename: "bundle.mp4",
      contentType: "application/zip",
      contentPath: "/api/attachments/zip-mp4/content",
      openPath: "/api/attachments/zip-mp4/content",
      downloadPath: "/api/attachments/zip-mp4/content?download=1",
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueAttachmentsSection
            attachments={[attachment]}
            onDelete={vi.fn()}
            onImageClick={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector("video")).toBeNull();
    expect(container.textContent).toContain("bundle.mp4");
    expect(container.textContent).toContain("application/zip");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps generic attachments as compact file rows with open and download actions", async () => {
    const attachment = makeAttachment({
      id: "pdf-attachment",
      originalFilename: "report.pdf",
      contentType: "application/pdf",
      contentPath: "/api/attachments/pdf-attachment/content",
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueAttachmentsSection
            attachments={[attachment]}
            onDelete={vi.fn()}
            onImageClick={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("report.pdf");
    expect(container.textContent).toContain("application/pdf");
    expect(container.querySelector('a[aria-label="Open report.pdf"]')?.getAttribute("href")).toBe(
      "/api/attachments/pdf-attachment/content",
    );
    expect(container.querySelector('a[aria-label="Download report.pdf"]')?.getAttribute("href")).toBe(
      "/api/attachments/pdf-attachment/content?download=1",
    );
  });
});

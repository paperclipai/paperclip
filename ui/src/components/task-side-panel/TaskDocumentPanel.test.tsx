// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueDocument } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDocumentPanel } from "./TaskDocumentPanel";
import { queryKeys } from "@/lib/queryKeys";

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/", search: "", hash: "" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <article data-rendered>{children}</article>,
}));

vi.mock("@/components/IssueDocumentAnnotations", () => ({
  IssueDocumentAnnotations: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DocumentAnnotationsCountChip: () => <span data-testid="annotations-chip" />,
}));

const copyTextMock = vi.fn(async (_text: string) => undefined);
vi.mock("@/lib/clipboard", () => ({
  copyTextToClipboard: (text: string) => copyTextMock(text),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date();
const sampleDoc: IssueDocument = {
  id: "doc-1",
  companyId: "company-1",
  issueId: "issue-123",
  key: "published-post",
  title: "Why I Run Dual Caddy",
  format: "markdown",
  body: "# Homelab Setup\n\nDual Caddy and Dual DNS.",
  latestRevisionNumber: 2,
  latestRevisionId: "rev-2",
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lockedAt: null,
  lockedByAgentId: null,
  lockedByUserId: null,
  createdAt: now,
  updatedAt: now,
};

describe("TaskDocumentPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    copyTextMock.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    client.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderPanel(doc: IssueDocument = sampleDoc) {
    client.setQueryData([...queryKeys.issues.documents(doc.issueId), doc.key], doc);
    return act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TaskDocumentPanel issueId={doc.issueId} documentKey={doc.key} initialDocument={doc} />
        </QueryClientProvider>,
      );
    });
  }

  it("renders document title, revision number, and action buttons above the title", async () => {
    await renderPanel();

    expect(container.textContent).toContain("Why I Run Dual Caddy");
    expect(container.textContent).toContain("Revision 2");
    expect(container.querySelector("[data-rendered]")?.textContent).toContain("Dual Caddy and Dual DNS");

    const copyBtn = container.querySelector<HTMLButtonElement>('button[title="Copy Markdown"]');
    const downloadBtn = container.querySelector<HTMLButtonElement>('button[title="Download Markdown"]');
    expect(copyBtn).not.toBeNull();
    expect(downloadBtn).not.toBeNull();
    expect(copyBtn?.textContent).toContain("Copy");
    expect(downloadBtn?.textContent).toContain("Download");
  });

  it("copies markdown body, shows confirmation, and reverts label after timeout", async () => {
    await renderPanel();

    const copyBtn = container.querySelector<HTMLButtonElement>('button[title="Copy Markdown"]');
    expect(copyBtn).not.toBeNull();

    await act(async () => {
      copyBtn!.click();
    });

    expect(copyTextMock).toHaveBeenCalledWith(sampleDoc.body);
    expect(copyBtn?.textContent).toContain("Copied");

    await act(async () => {
      vi.advanceTimersByTime(1600);
    });

    expect(copyBtn?.textContent).toContain("Copy");
  });

  it("shows failure label when copying to clipboard fails", async () => {
    copyTextMock.mockRejectedValueOnce(new Error("Clipboard denied"));
    await renderPanel();

    const copyBtn = container.querySelector<HTMLButtonElement>('button[title="Copy Markdown"]');
    expect(copyBtn).not.toBeNull();

    await act(async () => {
      copyBtn!.click();
    });

    expect(copyBtn?.textContent).toContain("Failed");

    await act(async () => {
      vi.advanceTimersByTime(2100);
    });

    expect(copyBtn?.textContent).toContain("Copy");
  });

  it("resets copy confirmation state when document key changes", async () => {
    await renderPanel();

    const copyBtn = container.querySelector<HTMLButtonElement>('button[title="Copy Markdown"]');
    await act(async () => {
      copyBtn!.click();
    });
    expect(copyBtn?.textContent).toContain("Copied");

    const otherDoc: IssueDocument = { ...sampleDoc, key: "other-doc", title: "Other Document" };
    client.setQueryData([...queryKeys.issues.documents(otherDoc.issueId), otherDoc.key], otherDoc);

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TaskDocumentPanel issueId={otherDoc.issueId} documentKey={otherDoc.key} initialDocument={otherDoc} />
        </QueryClientProvider>,
      );
    });

    const newCopyBtn = container.querySelector<HTMLButtonElement>('button[title="Copy Markdown"]');
    expect(newCopyBtn?.textContent).toContain("Copy");
  });

  it("does not update copied state if document changes while copy is in flight", async () => {
    let resolveCopy = () => {};
    copyTextMock.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      resolveCopy = () => resolve(undefined);
    }));

    await renderPanel();
    const copyBtn = container.querySelector<HTMLButtonElement>('button[title="Copy Markdown"]');
    await act(async () => {
      copyBtn!.click();
    });

    const otherDoc: IssueDocument = { ...sampleDoc, key: "other-doc", title: "Other Document" };
    client.setQueryData([...queryKeys.issues.documents(otherDoc.issueId), otherDoc.key], otherDoc);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TaskDocumentPanel issueId={otherDoc.issueId} documentKey={otherDoc.key} initialDocument={otherDoc} />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      resolveCopy();
    });

    const newCopyBtn = container.querySelector<HTMLButtonElement>('button[title="Copy Markdown"]');
    expect(newCopyBtn?.textContent).toContain("Copy");
    expect(newCopyBtn?.textContent).not.toContain("Copied");
  });

  it("triggers download with safe slugified filename and falls back to key when title is absent", async () => {
    const createObjectURLMock = vi.fn(() => "blob:http://localhost/test-uuid");
    const revokeObjectURLMock = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: createObjectURLMock,
      revokeObjectURL: revokeObjectURLMock,
    });

    let clickedAnchor: HTMLAnchorElement | null = null;
    const originalAppendChild = document.body.appendChild.bind(document.body);
    const appendChildSpy = vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
      if (node instanceof HTMLAnchorElement) {
        clickedAnchor = node;
      }
      return originalAppendChild(node);
    });

    await renderPanel();

    const downloadBtn = container.querySelector<HTMLButtonElement>('button[title="Download Markdown"]');
    expect(downloadBtn).not.toBeNull();

    await act(async () => {
      downloadBtn!.click();
    });

    expect(createObjectURLMock).toHaveBeenCalled();
    const anchor = clickedAnchor as HTMLAnchorElement | null;
    expect(anchor).not.toBeNull();
    expect(anchor?.download).toBe("why-i-run-dual-caddy.md");
    expect(anchor?.href).toBe("blob:http://localhost/test-uuid");

    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:http://localhost/test-uuid");

    await renderPanel({ ...sampleDoc, title: "" });
    await act(async () => {
      downloadBtn!.click();
    });
    const secondAnchor = clickedAnchor as HTMLAnchorElement | null;
    expect(secondAnchor?.download).toBe("published-post.md");

    appendChildSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("shows fallback message when document is not found", async () => {
    client.setQueryData([...queryKeys.issues.documents("issue-1"), "missing"], null);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TaskDocumentPanel issueId="issue-1" documentKey="missing" />
        </QueryClientProvider>,
      );
    });

    expect(container.textContent).toContain("Document no longer available");
  });
});

// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueDocument } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { TaskDocumentPanel } from "./TaskDocumentPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiFixture = vi.hoisted(() => ({
  getDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));

vi.mock("@/api/issues", () => ({
  issuesApi: {
    getDocument: apiFixture.getDocument,
    deleteDocument: apiFixture.deleteDocument,
  },
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ hash: "" }),
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("@/components/IssueDocumentAnnotations", () => ({
  DocumentAnnotationsCountChip: () => null,
  IssueDocumentAnnotations: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function documentFixture(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "document-brief",
    issueId: "task-1",
    companyId: "company-1",
    key: "brief",
    title: "Launch brief",
    body: "# Launch brief",
    latestRevisionNumber: 2,
    createdAt: "2026-10-14T12:00:00.000Z",
    updatedAt: "2026-10-15T12:00:00.000Z",
    ...overrides,
  } as IssueDocument;
}

describe("TaskDocumentPanel", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    apiFixture.getDocument.mockReset();
    apiFixture.deleteDocument.mockReset().mockResolvedValue({ ok: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(
    document: IssueDocument,
    props: { canDeleteDocuments?: boolean; onDeleted?: (key: string) => void } = {},
    documentKey = document.key,
  ) {
    apiFixture.getDocument.mockResolvedValue(document);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <TaskDocumentPanel
              key={documentKey}
              issueId="task-1"
              documentKey={documentKey}
              initialDocument={document}
              {...props}
            />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
  }

  it("confirms deletion, clears document caches, and reports the deleted tab", async () => {
    const issueDocument = documentFixture();
    const onDeleted = vi.fn();
    queryClient.setQueryData([...queryKeys.issues.documents("task-1"), "list"], [issueDocument, documentFixture({ id: "document-notes", key: "notes" })]);
    queryClient.setQueryData(queryKeys.issues.detail("task-1"), {
      id: "task-1",
      documentSummaries: [issueDocument, documentFixture({ id: "document-notes", key: "notes" })],
    } as unknown as Issue);
    queryClient.setQueryData(queryKeys.issues.detail("PAP-1"), {
      id: "task-1",
      identifier: "PAP-1",
      documentSummaries: [issueDocument, documentFixture({ id: "document-notes", key: "notes" })],
    } as unknown as Issue);

    await render(issueDocument, { canDeleteDocuments: true, onDeleted });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Delete Launch brief"]')?.click());

    expect(document.body.textContent).toContain("This action cannot be undone");

    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Delete document");
    await act(async () => {
      confirm?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(apiFixture.deleteDocument).toHaveBeenCalledExactlyOnceWith("task-1", "brief");
    expect(onDeleted).toHaveBeenCalledExactlyOnceWith("brief");
    expect(queryClient.getQueryData<IssueDocument[]>([...queryKeys.issues.documents("task-1"), "list"]))
      .toEqual([expect.objectContaining({ key: "notes" })]);
    expect(queryClient.getQueryData([...queryKeys.issues.documents("task-1"), "brief"])).toBeNull();
    expect(queryClient.getQueryData<Issue>(queryKeys.issues.detail("task-1"))?.documentSummaries)
      .toEqual([expect.objectContaining({ key: "notes" })]);
    expect(queryClient.getQueryData<Issue>(queryKeys.issues.detail("PAP-1"))?.documentSummaries)
      .toEqual([expect.objectContaining({ key: "notes" })]);
  });

  it("cleans up the requested document when selection changes during deletion", async () => {
    let finishDeletion: ((value: { ok: boolean }) => void) | undefined;
    apiFixture.deleteDocument.mockReturnValue(new Promise((resolve) => {
      finishDeletion = resolve;
    }));
    const issueDocument = documentFixture();
    const notesDocument = documentFixture({ id: "document-notes", key: "notes", title: "Notes" });
    const onDeleted = vi.fn();
    queryClient.setQueryData([...queryKeys.issues.documents("task-1"), "list"], [issueDocument, notesDocument]);

    await render(issueDocument, { canDeleteDocuments: true, onDeleted });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Delete Launch brief"]')?.click());
    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Delete document");
    await act(async () => confirm?.click());

    await render(notesDocument, { canDeleteDocuments: true, onDeleted });
    await act(async () => {
      finishDeletion?.({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(apiFixture.deleteDocument).toHaveBeenCalledExactlyOnceWith("task-1", "brief");
    expect(onDeleted).toHaveBeenCalledExactlyOnceWith("brief");
    expect(queryClient.getQueryData<IssueDocument[]>([...queryKeys.issues.documents("task-1"), "list"]))
      .toEqual([expect.objectContaining({ key: "notes" })]);
    expect(queryClient.getQueryData([...queryKeys.issues.documents("task-1"), "brief"])).toBeNull();
  });

  it("does not offer deletion without board access or while the document is locked", async () => {
    await render(documentFixture());
    expect(container.querySelector('button[aria-label="Delete Launch brief"]')).toBeNull();

    queryClient.removeQueries({ queryKey: [...queryKeys.issues.documents("task-1"), "brief"] });
    await render(documentFixture({ lockedAt: new Date("2026-10-15T12:30:00.000Z") }), { canDeleteDocuments: true });
    expect(container.querySelector('button[aria-label="Delete Launch brief"]')).toBeNull();
  });

  it("keeps the confirmation open and announces an API failure", async () => {
    apiFixture.deleteDocument.mockRejectedValue(new Error("Document is locked"));
    await render(documentFixture(), { canDeleteDocuments: true });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Delete Launch brief"]')?.click());
    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Delete document");
    await act(async () => {
      confirm?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Document is locked");
    expect(document.body.textContent).toContain("Delete “Launch brief”?");
  });
});

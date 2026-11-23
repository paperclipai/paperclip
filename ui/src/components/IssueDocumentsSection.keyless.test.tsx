// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueDocument } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueDocumentsSection } from "./IssueDocumentsSection";
import { queryKeys } from "../lib/queryKeys";

const mockIssuesApi = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  listDocumentRevisions: vi.fn(),
  restoreDocumentRevision: vi.fn(),
  upsertDocument: vi.fn(),
  lockDocument: vi.fn(),
  unlockDocument: vi.fn(),
  deleteDocument: vi.fn(),
  getDocument: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "user-1" } }) } }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ hash: "" }) }));
vi.mock("./IssueDocumentAnnotations", () => ({
  DocumentAnnotationsCountChip: () => null,
  IssueDocumentAnnotations: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./DocumentMarkdownBody", () => ({
  DocumentMarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => <div>{value}</div>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} {...props}>{children}</button>
  ),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

function createIssueDocument(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "document-1",
    companyId: "company-1",
    issueId: "issue-1",
    key: "plan",
    title: "Plan",
    format: "markdown",
    body: "",
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: new Date("2026-03-31T12:00:00.000Z"),
    updatedAt: new Date("2026-03-31T12:05:00.000Z"),
    ...overrides,
  };
}

function createIssue(): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "DOC-1",
    title: "Keyless documents",
    documentSummaries: [],
    legacyPlanDocument: null,
  } as unknown as Issue;
}

/** A cached row that lost its key, as seen by the task panel before this fix. */
function keylessDocument(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return { ...createIssueDocument(overrides), key: undefined } as unknown as IssueDocument;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("IssueDocumentsSection keyless rows", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });

  it.each([false, true])("skips a cached row without a key (general only: %s)", async generalDocumentsOnly => {
    mockIssuesApi.listDocuments.mockResolvedValue([
      keylessDocument({ id: "keyless", body: "Keyless row content" }),
      createIssueDocument({ id: "note", key: "notes", title: "Task note", body: "General document content" }),
    ]);
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <IssueDocumentsSection issue={createIssue()} canDeleteDocuments={false} generalDocumentsOnly={generalDocumentsOnly} />
      </QueryClientProvider>,
    ));
    await flush();
    expect(container.textContent).toContain("General document content");
    expect(container.textContent).not.toContain("Keyless row content");
  });

  it("keeps a keyless mutation response out of the cached document list", async () => {
    const document = createIssueDocument({ body: "Lockable plan body" });
    // Hold the post-lock refetch so the test observes the synced cache, not fresh server rows.
    mockIssuesApi.listDocuments
      .mockResolvedValueOnce([document])
      .mockReturnValue(new Promise(() => {}));
    mockIssuesApi.lockDocument.mockResolvedValue(keylessDocument({ lockedAt: new Date("2026-03-31T12:06:00.000Z") }));
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <IssueDocumentsSection issue={createIssue()} canDeleteDocuments={false} canManageDocumentLocks />
      </QueryClientProvider>,
    ));
    await flush();
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Lock document"]')?.click());
    await flush();
    expect(mockIssuesApi.lockDocument).toHaveBeenCalledWith("issue-1", "plan");
    const cached = client.getQueryData<IssueDocument[]>(queryKeys.issues.documents("issue-1")) ?? [];
    expect(cached.map(entry => entry.key)).toEqual(["plan"]);
    expect(container.textContent).toContain("Lockable plan body");
  });
});

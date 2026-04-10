// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DocumentRevision, Issue, IssueDocument } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueDocumentsSection } from "./IssueDocumentsSection";
import { queryKeys } from "../lib/queryKeys";

const mockIssuesApi = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  listDocumentRevisions: vi.fn(),
  restoreDocumentRevision: vi.fn(),
  upsertDocument: vi.fn(),
  deleteDocument: vi.fn(),
  getDocument: vi.fn(),
}));

const markdownEditorMockState = vi.hoisted(() => ({
  emitMountEmptyChange: false,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../hooks/useAutosaveIndicator", () => ({
  useAutosaveIndicator: () => ({
    state: "idle",
    markDirty: vi.fn(),
    reset: vi.fn(),
    runSave: async (save: () => Promise<unknown>) => save(),
  }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ hash: "" }),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: string; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("./MarkdownEditor", async () => {
  const React = await import("react");

  return {
    MarkdownEditor: ({ value, onChange, placeholder, contentClassName }: {
      value: string;
      onChange?: (value: string) => void;
      placeholder?: string;
      contentClassName?: string;
    }) => {
      React.useEffect(() => {
        if (!markdownEditorMockState.emitMountEmptyChange) return;
        onChange?.("");
      }, []);

      return (
        <div className={contentClassName} data-testid="markdown-editor">
          {value || placeholder || ""}
        </div>
      );
    },
  };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/ui/dropdown-menu", async () => {
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuItem: ({ children, onClick, onSelect, disabled }: {
      children: React.ReactNode;
      onClick?: () => void;
      onSelect?: () => void;
      disabled?: boolean;
    }) => (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          onSelect?.();
          onClick?.();
        }}
      >
        {children}
      </button>
    ),
    DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuRadioGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuRadioItem: ({ children, onSelect, disabled }: {
      children: React.ReactNode;
      onSelect?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
        {children}
      </button>
    ),
    DropdownMenuSeparator: () => <hr />,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function createIssueDocument(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "document-1",
    companyId: "company-1",
    issueId: "issue-1",
    key: "plan",
    title: "Plan",
    format: "markdown",
    body: "",
    latestRevisionId: "revision-4",
    latestRevisionNumber: 4,
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    createdAt: new Date("2026-03-31T12:00:00.000Z"),
    updatedAt: new Date("2026-03-31T12:05:00.000Z"),
    ...overrides,
  };
}

function createRevision(overrides: Partial<DocumentRevision> = {}): DocumentRevision {
  return {
    id: "revision-3",
    companyId: "company-1",
    documentId: "document-1",
    issueId: "issue-1",
    key: "plan",
    revisionNumber: 3,
    title: "Plan",
    format: "markdown",
    body: "Restored plan body",
    changeSummary: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-03-31T11:00:00.000Z"),
    ...overrides,
  };
}

function createIssue(): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-807",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Plan rendering",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    issueNumber: 807,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    planDocument: createIssueDocument(),
    documentSummaries: [createIssueDocument()],
    legacyPlanDocument: null,
    createdAt: new Date("2026-03-31T12:00:00.000Z"),
    updatedAt: new Date("2026-03-31T12:05:00.000Z"),
  };
}

describe("IssueDocumentsSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    vi.clearAllMocks();
    markdownEditorMockState.emitMountEmptyChange = false;
  });

  afterEach(() => {
    container.remove();
  });

  it("shows the restored document body immediately after a revision restore", async () => {
    const blankLatestDocument = createIssueDocument({
      body: "",
      latestRevisionId: "revision-4",
      latestRevisionNumber: 4,
    });
    const restoredDocument = createIssueDocument({
      body: "Restored plan body",
      latestRevisionId: "revision-5",
      latestRevisionNumber: 5,
      updatedAt: new Date("2026-03-31T12:06:00.000Z"),
    });
    const pendingDocuments = deferred<IssueDocument[]>();
    const issue = createIssue();
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
        mutations: {
          retry: false,
        },
      },
    });

    mockIssuesApi.listDocuments
      .mockResolvedValueOnce([blankLatestDocument])
      .mockImplementation(() => pendingDocuments.promise);
    mockIssuesApi.restoreDocumentRevision.mockResolvedValue(restoredDocument);
    queryClient.setQueryData(
      queryKeys.issues.documentRevisions(issue.id, "plan"),
      [
        createRevision({ id: "revision-4", revisionNumber: 4, body: "", createdAt: new Date("2026-03-31T12:05:00.000Z") }),
        createRevision(),
      ],
    );

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments={false} />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    expect(container.textContent).not.toContain("Restored plan body");

    const revisionButtons = Array.from(container.querySelectorAll("button"));
    const historicalRevisionButton = revisionButtons.find((button) => button.textContent?.includes("rev 3"));
    expect(historicalRevisionButton).toBeTruthy();

    await act(async () => {
      historicalRevisionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Viewing revision 3");
    expect(container.textContent).toContain("Restored plan body");

    const restoreButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Restore this revision"));
    expect(restoreButton).toBeTruthy();

    await act(async () => {
      restoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockIssuesApi.restoreDocumentRevision).toHaveBeenCalledWith("issue-1", "plan", "revision-3");
    expect(container.textContent).toContain("Restored plan body");
    expect(container.textContent).not.toContain("Viewing revision 3");

    pendingDocuments.resolve([restoredDocument]);
    await flush();
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("ignores mount-time editor change noise before a document is actively being edited", async () => {
    markdownEditorMockState.emitMountEmptyChange = true;

    const document = createIssueDocument({
      body: "Loaded plan body",
    });
    const issue = createIssue();
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
        mutations: {
          retry: false,
        },
      },
    });

    mockIssuesApi.listDocuments.mockResolvedValue([document]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments={false} />
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    expect(container.textContent).toContain("Loaded plan body");
    expect(container.textContent).not.toContain("Markdown body");

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("wraps the documents header actions so mobile layouts do not overflow", async () => {
    const issue = createIssue();
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
        mutations: {
          retry: false,
        },
      },
    });

    mockIssuesApi.listDocuments.mockResolvedValue([createIssueDocument()]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection
            issue={issue}
            canDeleteDocuments={false}
            extraActions={(
              <>
                <button type="button">Upload</button>
                <button type="button">Sub-issue</button>
              </>
            )}
          />
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    const heading = container.querySelector("h3");
    expect(heading).toBeTruthy();
    expect(heading?.parentElement?.className).toContain("flex-wrap");
    expect(heading?.nextElementSibling?.className).toContain("flex-wrap");

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });
});

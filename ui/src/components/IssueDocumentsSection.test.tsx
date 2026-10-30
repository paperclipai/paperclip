// @vitest-environment jsdom

import { act as reactAct } from "react";
import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DocumentRevision, Issue, IssueDocument } from "@paperclipai/shared";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
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

const markdownEditorMockState = vi.hoisted(() => ({
  emitMountEmptyChange: false,
  /** Typed into the editor on mount, for forms the test cannot type into. */
  emitMountValue: null as string | null,
  changeBody: null as null | ((body: string) => void),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act<T>(callback: () => T | Promise<T>): Promise<T> {
  if (typeof reactAct === "function") {
    return await (reactAct(callback) as T | Promise<T>);
  }

  let result: T | Promise<T> | undefined;
  flushSync(() => {
    result = callback();
  });
  const resolved = await result;
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
  return resolved as T;
}

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

const mockSession = vi.hoisted(() => ({ userId: "user-1", unreachable: false }));
vi.mock("../api/auth", () => ({
  authApi: {
    getSession: async () => {
      if (mockSession.unreachable) throw new Error("Service unavailable");
      return { user: { id: mockSession.userId } };
    },
  },
}));

const mockLocation = vi.hoisted(() => ({ hash: "" }));
vi.mock("@/lib/router", () => ({ useLocation: () => mockLocation }));
vi.mock("./DocumentMarkdownBody", async () => ({
  DocumentMarkdownBody: (await import("./MarkdownBody")).MarkdownBody,
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({
    children,
    className,
    externalReferences,
  }: {
    children: string;
    className?: string;
    externalReferences?: Record<string, unknown>;
  }) => (
    <div
      className={className}
      data-testid="markdown-body"
      data-external-reference-keys={externalReferences ? Object.keys(externalReferences).join(",") : ""}
    >
      {children}
    </div>
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
        if (markdownEditorMockState.emitMountValue !== null) {
          onChange?.(markdownEditorMockState.emitMountValue);
          return;
        }
        if (!markdownEditorMockState.emitMountEmptyChange) return;
        onChange?.("");
      }, []);

      markdownEditorMockState.changeBody = onChange ?? null;
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

const localStorageEntries = new Map<string, string>();

function ensureLocalStorageMock() {
  if (
    typeof window.localStorage?.getItem === "function"
    && typeof window.localStorage?.setItem === "function"
    && typeof window.localStorage?.removeItem === "function"
    && typeof window.localStorage?.clear === "function"
  ) {
    return;
  }

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => localStorageEntries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        localStorageEntries.set(key, value);
      },
      removeItem: (key: string) => {
        localStorageEntries.delete(key);
      },
      clear: () => {
        localStorageEntries.clear();
      },
    },
  });
}

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
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
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
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
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
    ensureLocalStorageMock();
    window.localStorage.clear();
    vi.clearAllMocks();
    markdownEditorMockState.emitMountEmptyChange = false;
    markdownEditorMockState.emitMountValue = null;
    markdownEditorMockState.changeBody = null;
    mockSession.unreachable = false;
    mockLocation.hash = "";
  });

  afterEach(() => {
    container.remove();
  });

  it("unfolds a Classic confirmation link and loads its bound revision rather than the latest text", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockLocation.hash = "#document-plan&revision=revision-3&interaction=review-1";
    localStorage.setItem("paperclip:issue-document-folds:issue-1", JSON.stringify(["plan"]));
    mockIssuesApi.listDocuments.mockResolvedValue([createIssueDocument({ body: "Newer unreviewed text" })]);
    let loadHistory!: (value: DocumentRevision[]) => void;
    mockIssuesApi.listDocumentRevisions.mockReturnValue(new Promise<DocumentRevision[]>((resolve) => { loadHistory = resolve; }));
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    await act(async () => root.render(<QueryClientProvider client={queryClient}><IssueDocumentsSection issue={createIssue()} canDeleteDocuments={false} /></QueryClientProvider>));
    await flush();
    expect(mockIssuesApi.listDocumentRevisions).toHaveBeenCalledWith("issue-1", "plan");
    expect(scroll).toHaveBeenCalled();
    expect(container.textContent).toContain("Loading reviewed revision");
    expect(container.textContent).not.toContain("Newer unreviewed text");
    await act(async () => loadHistory([createRevision({ body: "Exact reviewed text" })]));
    await flush();
    expect(container.textContent).toContain("Viewing revision 3");
    expect(container.textContent).toContain("Exact reviewed text");
    expect(container.textContent).not.toContain("Newer unreviewed text");
    const latest = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Return to latest"));
    expect(latest).toBeTruthy();
    await act(async () => latest!.click());
    expect(container.textContent).toContain("Newer unreviewed text");
    mockLocation.hash = "#document-plan&revision=revision-3&interaction=review-2&image=2";
    await act(async () => root.render(<QueryClientProvider client={queryClient}><IssueDocumentsSection issue={createIssue()} canDeleteDocuments={false} /></QueryClientProvider>));
    expect(container.textContent).toContain("Exact reviewed text");
    expect(container.textContent).not.toContain("Newer unreviewed text");
    mockLocation.hash = "#document-plan&revision=revision-3&interaction=review-2&image=3";
    await act(async () => root.render(<QueryClientProvider client={queryClient}><IssueDocumentsSection issue={createIssue()} canDeleteDocuments={false} /></QueryClientProvider>));
    expect(container.textContent).toContain("Exact reviewed text");
    await act(async () => root.unmount());
    scroll.mockRestore();
    queryClient.clear();
  });

  it("does not substitute newer content when a Classic review revision is missing", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockLocation.hash = "#document-plan&revision=missing&interaction=review-1";
    mockIssuesApi.listDocuments.mockResolvedValue([createIssueDocument({ body: "Newer unreviewed text" })]);
    mockIssuesApi.listDocumentRevisions.mockResolvedValue([]);
    await act(async () => root.render(<QueryClientProvider client={queryClient}><IssueDocumentsSection issue={createIssue()} canDeleteDocuments={false} /></QueryClientProvider>));
    await flush();
    await flush();
    expect(container.textContent).toContain("The reviewed revision is unavailable");
    expect(container.textContent).not.toContain("Newer unreviewed text");
    await act(async () => root.unmount());
    queryClient.clear();
  });

  it.each(["loaded", "failed"])("preserves an unsaved draft when linked revision loading %s", async (outcome) => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const storageKey = "paperclip:document-draft:v2:user-1:issue-1:plan";
    localStorage.setItem(storageKey, JSON.stringify({ key: "plan", title: "Plan", body: "My unsaved draft", baseRevisionId: "revision-4", isNew: false }));
    mockIssuesApi.listDocuments.mockResolvedValue([createIssueDocument({ body: "Saved latest body" })]);
    let load!: (value: DocumentRevision[]) => void;
    let fail!: (error: Error) => void;
    mockIssuesApi.listDocumentRevisions.mockReturnValue(new Promise<DocumentRevision[]>((resolve, reject) => { load = resolve; fail = reject; }));
    const show = () => root.render(<QueryClientProvider client={queryClient}><IssueDocumentsSection issue={createIssue()} canDeleteDocuments={false} /></QueryClientProvider>);
    await act(async () => show());
    await flush();
    await flush();
    expect(container.querySelector('[data-testid="markdown-editor"]')?.textContent).toBe("My unsaved draft");
    mockLocation.hash = "#document-plan&revision=revision-3&interaction=review-1";
    await act(async () => show());
    await flush();
    expect(container.querySelector('[data-testid="markdown-editor"]')?.textContent).toBe("My unsaved draft");
    expect(JSON.parse(localStorage.getItem(storageKey)!).body).toBe("My unsaved draft");
    await act(async () => outcome === "loaded" ? load([createRevision()]) : fail(new Error("Disconnected")));
    await flush();
    await flush();
    expect(container.textContent).toContain(outcome === "loaded" ? "Save or cancel your local changes" : "Could not load the reviewed revision");
    expect(container.querySelector('[data-testid="markdown-editor"]')?.textContent).toBe("My unsaved draft");
    await act(async () => markdownEditorMockState.changeBody!("My unsaved draft, continued"));
    await flush();
    expect(JSON.parse(localStorage.getItem(storageKey)!).body).toBe("My unsaved draft, continued");
    expect(mockIssuesApi.upsertDocument).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    queryClient.clear();
  });

  it("keeps system handoff documents out of the normal document surface", async () => {
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

    mockIssuesApi.listDocuments.mockResolvedValue([
      createIssueDocument({ key: "plan", body: "# Plan" }),
      createIssueDocument({
        id: "document-handoff",
        key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
        title: "Continuation Summary",
        body: "# Handoff",
      }),
    ]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments={false} />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("# Plan");
    expect(container.textContent).not.toContain("# Handoff");
    expect(container.querySelector(`#document-${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}`)).toBeNull();

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("copies document bodies through the plain HTTP clipboard fallback", async () => {
    const issue = createIssue();
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const writeText = vi.fn(async () => {});
    const execCommand = vi.fn(() => true);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalSecureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    mockIssuesApi.listDocuments.mockResolvedValue([
      createIssueDocument({ body: "# Copy over HTTP" }),
    ]);

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <IssueDocumentsSection issue={issue} canDeleteDocuments={false} />
          </QueryClientProvider>,
        );
      });
      await flush();
      await flush();

      const copyButton = container.querySelector('button[title="Copy document"]');
      expect(copyButton).toBeTruthy();

      await act(async () => {
        copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(writeText).not.toHaveBeenCalled();
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(container.querySelector('button[title="Copied"]')).toBeTruthy();
    } finally {
      await act(async () => {
        root.unmount();
      });
      queryClient.clear();
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        delete (navigator as { clipboard?: Clipboard }).clipboard;
      }
      if (originalSecureContext) {
        Object.defineProperty(window, "isSecureContext", originalSecureContext);
      } else {
        delete (window as { isSecureContext?: boolean }).isSecureContext;
      }
      if (originalExecCommand) {
        Object.defineProperty(document, "execCommand", originalExecCommand);
      } else {
        delete (document as { execCommand?: (command: string) => boolean }).execCommand;
      }
    }
  });

  it("locks documents from the document header action", async () => {
    const unlockedDocument = createIssueDocument({
      body: "Draftable plan body",
      lockedAt: null,
    });
    const lockedDocument = createIssueDocument({
      body: "Draftable plan body",
      lockedAt: new Date("2026-03-31T12:06:00.000Z"),
      lockedByUserId: "user-1",
      updatedAt: new Date("2026-03-31T12:06:00.000Z"),
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

    mockIssuesApi.listDocuments
      .mockResolvedValueOnce([unlockedDocument])
      .mockResolvedValue([lockedDocument]);
    mockIssuesApi.lockDocument.mockResolvedValue(lockedDocument);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments={false} canManageDocumentLocks />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const lockButton = container.querySelector('button[title="Lock document"]');
    expect(lockButton).toBeTruthy();

    await act(async () => {
      lockButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.lockDocument).toHaveBeenCalledWith("issue-1", "plan");
    expect(container.querySelector('button[title="Unlock document"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("hides direct edit and delete actions for locked documents", async () => {
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

    mockIssuesApi.listDocuments.mockResolvedValue([
      createIssueDocument({
        body: "Locked plan body",
        lockedAt: new Date("2026-03-31T12:06:00.000Z"),
        lockedByUserId: "user-1",
      }),
    ]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments canManageDocumentLocks />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Locked plan body");
    expect(container.textContent).not.toContain("Edit document");
    expect(container.textContent).not.toContain("Delete document");
    expect(container.querySelector('button[title="Unlock document"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("shows revision authors with names and avatars in the revision history menu", async () => {
    const currentDocument = createIssueDocument({
      body: "Current plan body",
      latestRevisionId: "revision-agent",
      latestRevisionNumber: 4,
      updatedByAgentId: "agent-1",
      updatedByUserId: null,
      updatedAt: new Date("2026-03-31T12:05:00.000Z"),
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

    mockIssuesApi.listDocuments.mockResolvedValue([currentDocument]);
    queryClient.setQueryData(
      queryKeys.issues.documentRevisions(issue.id, "plan"),
      [
        createRevision({
          id: "revision-agent",
          revisionNumber: 4,
          body: "Current plan body",
          createdByAgentId: "agent-1",
          createdByUserId: null,
          createdAt: new Date("2026-03-31T12:05:00.000Z"),
        }),
        createRevision({
          id: "revision-user",
          revisionNumber: 3,
          body: "Board-written plan body",
          createdByAgentId: null,
          createdByUserId: "user-1",
          createdAt: new Date("2026-03-31T11:00:00.000Z"),
        }),
      ],
    );

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection
            issue={issue}
            canDeleteDocuments={false}
            agentMap={new Map([["agent-1", { id: "agent-1", name: "CodexCoder", icon: "code" }]])}
            userProfileMap={new Map([["user-1", { label: "Dotta", image: "https://example.test/dotta.png" }]])}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const revisionButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("rev 4"));
    expect(revisionButton).toBeTruthy();

    await act(async () => {
      revisionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(document.body.textContent).toContain("CodexCoder");
    expect(document.body.textContent).toContain("Dotta");
    expect(document.body.textContent).not.toContain("• agent");
    expect(document.body.querySelectorAll('[data-slot="avatar"], [data-slot="agent-avatar"]').length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
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
    await flush();

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

  it("returns from a historical preview when the current revision only exists in derived state", async () => {
    const currentDocument = createIssueDocument({
      body: "Current plan body",
      latestRevisionId: "revision-4",
      latestRevisionNumber: 4,
      updatedAt: new Date("2026-03-31T12:05:00.000Z"),
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

    mockIssuesApi.listDocuments.mockResolvedValue([currentDocument]);
    queryClient.setQueryData(
      queryKeys.issues.documentRevisions(issue.id, "plan"),
      [
        createRevision({
          id: "revision-3",
          revisionNumber: 3,
          body: "Historical plan body",
          createdAt: new Date("2026-03-31T11:00:00.000Z"),
        }),
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

    expect(container.textContent).toContain("Current plan body");

    const revisionButtons = Array.from(container.querySelectorAll("button"));
    const historicalRevisionButton = revisionButtons.find((button) => button.textContent?.includes("rev 3"));
    expect(historicalRevisionButton).toBeTruthy();

    await act(async () => {
      historicalRevisionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Viewing revision 3");
    expect(container.textContent).toContain("Historical plan body");

    const currentRevisionButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("rev 4"));
    expect(currentRevisionButton).toBeTruthy();

    await act(async () => {
      currentRevisionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).not.toContain("Viewing revision 3");
    expect(container.textContent).toContain("Current plan body");

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("returns from a historical preview when fetched history is newer than the document summary", async () => {
    const staleDocument = createIssueDocument({
      body: "Original plan body",
      latestRevisionId: "revision-2",
      latestRevisionNumber: 2,
      updatedAt: new Date("2026-03-31T12:00:00.000Z"),
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

    mockIssuesApi.listDocuments.mockResolvedValue([staleDocument]);
    queryClient.setQueryData(
      queryKeys.issues.documentRevisions(issue.id, "plan"),
      [
        createRevision({
          id: "revision-3",
          revisionNumber: 3,
          body: "Current plan body",
          createdAt: new Date("2026-03-31T12:05:00.000Z"),
        }),
        createRevision({
          id: "revision-2",
          revisionNumber: 2,
          body: "Original plan body",
          createdAt: new Date("2026-03-31T12:00:00.000Z"),
        }),
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

    expect(container.textContent).toContain("Current plan body");

    const revisionButtons = Array.from(container.querySelectorAll("button"));
    const historicalRevisionButton = revisionButtons.find((button) => button.textContent?.includes("rev 2"));
    expect(historicalRevisionButton).toBeTruthy();

    await act(async () => {
      historicalRevisionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Viewing revision 2");
    expect(container.textContent).toContain("Original plan body");

    const currentRevisionButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("rev 3"));
    expect(currentRevisionButton).toBeTruthy();

    await act(async () => {
      currentRevisionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).not.toContain("Viewing revision 2");
    expect(container.textContent).toContain("Current plan body");

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

  it("does not restore another account's unsaved edit", async () => {
    const document = createIssueDocument({ body: "Server body" });
    const issue = createIssue();
    window.localStorage.setItem(
      `paperclip:document-draft:v2:user-2:${issue.id}:plan`,
      JSON.stringify({ key: "plan", title: "Plan", body: "Someone else's draft", baseRevisionId: "revision-4", isNew: false }),
    );
    mockIssuesApi.listDocuments.mockResolvedValue([document]);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments={false} />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
    expect(container.textContent).toContain("Server body");
    expect(container.textContent).not.toContain("Someone else's draft");
    expect(mockIssuesApi.upsertDocument).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    window.localStorage.clear();
  });

  it("drops a mounted editor's private draft when the signed-in account changes", async () => {
    const issue = createIssue();
    const document = createIssueDocument({ body: "Server plan" });
    mockIssuesApi.listDocuments.mockResolvedValue([document]);
    window.localStorage.setItem(`paperclip:document-draft:v2:user-1:${issue.id}:plan`, JSON.stringify({
      key: "plan", title: document.title ?? "", body: "Private unpublished text", baseRevisionId: "revision-4", isNew: false,
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    const root = createRoot(container);
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><IssueDocumentsSection issue={issue} canDeleteDocuments={false} /></QueryClientProvider>); });
    await flush(); await flush();
    expect(container.textContent).toContain("Private unpublished text");
    await act(async () => { queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } }); });
    await flush();
    expect(window.localStorage.getItem(`paperclip:document-draft:v2:user-2:${issue.id}:plan`)).toBeNull();
    expect(container.textContent).not.toContain("Private unpublished text");
    act(() => root.unmount()); queryClient.clear();
  });
  it("restores task B without copying task A's mounted document draft", async () => {
    const a = createIssue();
    const b = { ...a, id: "task-b", identifier: "DOC-2" };
    const document = createIssueDocument({ body: "Server plan" });
    mockIssuesApi.listDocuments.mockResolvedValue([document]);
    const key = (id: string) => `paperclip:document-draft:v2:user-1:${id}:plan`;
    const stored = (body: string) => JSON.stringify({ key: "plan", title: "Plan", body, baseRevisionId: "revision-4", isNew: false });
    localStorage.setItem(key(a.id), stored("Task A private edit"));
    const originalB = stored("Task B private edit");
    localStorage.setItem(key(b.id), originalB);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    client.setQueryData(queryKeys.issues.documents(a.id), [document]);
    client.setQueryData(queryKeys.issues.documents(b.id), [document]);
    const root = createRoot(container);
    const show = (issue: Issue) => root.render(<QueryClientProvider client={client}><IssueDocumentsSection issue={issue} canDeleteDocuments={false} /></QueryClientProvider>);
    try {
      await act(async () => show(a)); await flush();
      expect(container.textContent).toContain("Task A private edit");
      await act(async () => show(b)); await flush();
      expect(container.textContent).not.toContain("Task A private edit");
      expect(container.textContent).toContain("Task B private edit");
      expect(localStorage.getItem(key(b.id))).toBe(originalB);
    } finally { act(() => root.unmount()); client.clear(); localStorage.clear(); }
  });

  it("keeps the known account's drafts while a session refetch fails", async () => {
    const document = createIssueDocument({ body: "Server body" });
    const issue = createIssue();
    window.localStorage.setItem(
      `paperclip:document-draft:v2:user-1:${issue.id}:plan`,
      JSON.stringify({ key: "plan", title: "Plan", body: "Typed before the outage", baseRevisionId: "revision-4", isNew: false }),
    );
    mockIssuesApi.listDocuments.mockResolvedValue([document]);
    mockSession.unreachable = true;
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    // Signed in earlier; the refetch on mount fails but the query keeps its data.
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } }, { updatedAt: 0 });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments={false} />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
    expect(queryClient.getQueryState(queryKeys.auth.session)?.status).toBe("error");
    expect(container.textContent).toContain("Typed before the outage");

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    window.localStorage.clear();
  });

  it("restores an unsaved edit after reload and treats a 409 with our own text as saved", async () => {
    const { ApiError } = await import("../api/client");
    const document = createIssueDocument({ body: "Server body" });
    const issue = createIssue();
    // An edit typed before a reload; its save may have landed with a lost response.
    window.localStorage.setItem(
      `paperclip:document-draft:v2:user-1:${issue.id}:plan`,
      JSON.stringify({ key: "plan", title: "Plan", body: "Edited during the outage", baseRevisionId: "revision-4", isNew: false }),
    );
    const saved = createIssueDocument({ body: "Edited during the outage", latestRevisionId: "revision-5" });
    // The refetch after saving returns the server's current copy.
    mockIssuesApi.listDocuments.mockResolvedValueOnce([document]).mockResolvedValue([saved]);
    mockIssuesApi.upsertDocument.mockRejectedValue(
      new ApiError("Document was updated by someone else", 409, { error: "Document was updated by someone else" }),
    );
    mockIssuesApi.getDocument.mockResolvedValue(saved);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments={false} />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
    expect(container.textContent).toContain("Edited during the outage");

    // Autosave debounce.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    await flush();

    expect(mockIssuesApi.upsertDocument).toHaveBeenCalledWith(issue.id, "plan", expect.objectContaining({
      body: "Edited during the outage",
      baseRevisionId: "revision-4",
    }));
    expect(container.textContent).not.toContain("Out of date");
    expect(window.localStorage.getItem(`paperclip:document-draft:v2:user-1:${issue.id}:plan`)).toBeNull();

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("treats a 409 on a new document whose saved copy is ours as created", async () => {
    const { ApiError } = await import("../api/client");
    const issue = createIssue();
    // An earlier create landed but its response was lost; the key now exists.
    const saved = createIssueDocument({ key: "notes", title: null, body: "Notes body", latestRevisionId: "revision-1" });
    mockIssuesApi.listDocuments.mockResolvedValueOnce([]).mockResolvedValue([saved]);
    mockIssuesApi.upsertDocument.mockRejectedValue(
      new ApiError("Document already exists", 409, { error: "Document already exists" }),
    );
    mockIssuesApi.getDocument.mockResolvedValue(saved);
    markdownEditorMockState.emitMountValue = "Notes body";
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments={false} />
        </QueryClientProvider>,
      );
    });
    await flush();

    const newDocument = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("New document"))!;
    await act(async () => {
      newDocument.click();
    });
    const keyInput = container.querySelector<HTMLInputElement>('input[placeholder="Document key"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(keyInput, "notes");
      keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const create = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create document"))!;
    await act(async () => {
      create.click();
    });
    await flush();
    await flush();

    expect(mockIssuesApi.upsertDocument).toHaveBeenCalledWith(issue.id, "notes", expect.objectContaining({
      body: "Notes body",
      baseRevisionId: null,
    }));
    expect(mockIssuesApi.getDocument).toHaveBeenCalledWith(issue.id, "notes");
    // The form closes as for any created document; no conflict, no error.
    expect(container.querySelector('input[placeholder="Document key"]')).toBeNull();
    expect(container.textContent).not.toContain("Out of date");
    expect(container.textContent).not.toContain("already exists");

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("forwards externalReferences to the rendered document body so URL decoration applies", async () => {
    const issue = createIssue();
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    mockIssuesApi.listDocuments.mockResolvedValue([
      createIssueDocument({
        body: "Linked work: https://github.com/example/repo/pull/99",
      }),
    ]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection
            issue={issue}
            canDeleteDocuments={false}
            externalReferences={{
              "https://github.com/example/repo/pull/99": {
                providerKey: "github",
                objectType: "pull_request",
                statusCategory: "open",
                liveness: "fresh",
                statusLabel: "Open",
                displayTitle: "PR #99",
              },
            }}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const markdownBodies = Array.from(
      container.querySelectorAll('[data-testid="markdown-body"]'),
    ) as HTMLElement[];
    expect(markdownBodies.length).toBeGreaterThan(0);
    const rendered = markdownBodies.find((element) =>
      (element.textContent ?? "").includes("Linked work"),
    );
    expect(rendered?.getAttribute("data-external-reference-keys"))
      .toContain("https://github.com/example/repo/pull/99");

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

  it("renders and locks documents for a non-issue document subject", async () => {
    const caseDocument = createIssueDocument({
      id: "case-document-1",
      issueId: "case-1",
      key: "body",
      title: "Body",
      body: "Reusable case document body",
      latestRevisionId: "case-revision-2",
      latestRevisionNumber: 2,
      updatedByAgentId: "agent-1",
      updatedByUserId: null,
    });
    const lockedCaseDocument = {
      ...caseDocument,
      lockedAt: new Date("2026-03-31T12:06:00.000Z"),
      lockedByUserId: "user-1",
      updatedAt: new Date("2026-03-31T12:06:00.000Z"),
    };
    const listDocuments = vi.fn()
      .mockResolvedValueOnce([caseDocument])
      .mockResolvedValue([lockedCaseDocument]);
    const setDocumentLock = vi.fn().mockResolvedValue(lockedCaseDocument);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection
            subject={{
              id: "case-1",
              documentsQueryKey: ["cases", "documents", "case-1"],
              idleDocumentRevisionsQueryKey: ["cases", "revisions", "case-1", "__idle__"],
              documentRevisionsQueryKey: (key) => ["cases", "revisions", "case-1", key],
              listDocuments,
              listDocumentRevisions: vi.fn().mockResolvedValue([]),
              getDocument: vi.fn().mockResolvedValue(caseDocument),
              upsertDocument: vi.fn().mockResolvedValue(caseDocument),
              deleteDocument: vi.fn().mockResolvedValue({ ok: true }),
              restoreDocumentRevision: vi.fn().mockResolvedValue(caseDocument),
              setDocumentLock,
              hideSystemDocuments: false,
              legacyPlanDocument: null,
              annotations: null,
            }}
            canDeleteDocuments
            canManageDocumentLocks
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    expect(listDocuments).toHaveBeenCalled();
    expect(container.textContent).toContain("Reusable case document body");
    expect(container.textContent).toContain("body");

    const lockButton = container.querySelector('button[title="Lock document"]');
    expect(lockButton).toBeTruthy();

    await act(async () => {
      lockButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(setDocumentLock).toHaveBeenCalledWith("body", true);
    expect(container.querySelector('button[title="Unlock document"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });
});

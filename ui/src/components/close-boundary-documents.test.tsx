// @vitest-environment jsdom

import { act as reactAct, useState } from "react";
import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DocumentRevision, Issue, IssueDocument } from "@paperclipai/shared";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueDocumentsSection } from "./IssueDocumentsSection";
import { queryKeys } from "../lib/queryKeys";
import { i18n } from "@/i18n";

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
    MarkdownEditor: ({ value, onChange, placeholder, contentClassName, onSubmit }: {
      value: string;
      onChange?: (value: string) => void;
      placeholder?: string;
      contentClassName?: string;
      onSubmit?: () => void;
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
          {value || placeholder || ""}<button onClick={onSubmit}>Submit test edit</button>
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


it.each(["delete", "lock", "restore", "manual", "save"])("close-boundary document %s capability keeps diagnostics and draft guards", async scenario => {
  await i18n.changeLanguage("en"); ensureLocalStorageMock();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const doc = createIssueDocument({ key: "notes", title: "Raw title", body: "Raw body" });
  const list = vi.fn().mockResolvedValue([doc]); const save = scenario === "save" ? vi.fn().mockRejectedValue(null) : vi.fn().mockResolvedValue(doc);
  const manual = vi.fn().mockRejectedValue(new Error("Document locking is not available"));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const subject = { id: "boundary-doc", documentsQueryKey: ["boundary-docs"], idleDocumentRevisionsQueryKey: ["boundary-idle"], documentRevisionsQueryKey: (key: string) => ["boundary-revisions", key],
    listDocuments: list, listDocumentRevisions: vi.fn().mockResolvedValue([createRevision({ id: "revision-old", revisionNumber: 0, documentId: doc.id, key: doc.key }), createRevision({ id: doc.latestRevisionId!, revisionNumber: 4, documentId: doc.id, key: doc.key, body: doc.body, title: doc.title })]), getDocument: vi.fn().mockResolvedValue(doc), upsertDocument: save,
    ...(scenario === "manual" ? { setDocumentLock: manual } : {}) };
  client.setQueryData(subject.documentRevisionsQueryKey(doc.key), [createRevision({ id: "revision-old", revisionNumber: 0, documentId: doc.id, key: doc.key, body: "Raw body" }), createRevision({ id: doc.latestRevisionId!, revisionNumber: 4, documentId: doc.id, key: doc.key, body: doc.body, title: doc.title })]);
  const click = async (name: string) => { const button = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === name || b.title === name || b.getAttribute("aria-label") === name || (name === "rev 0" && b.textContent?.startsWith("rev ") && !b.textContent?.startsWith("rev 4"))); expect(button, name).toBeTruthy(); await act(async () => button!.click()); await flush(); };
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><IssueDocumentsSection subject={subject} canDeleteDocuments canManageDocumentLocks /></QueryClientProvider>)); await flush();
    if (scenario === "delete") { await click("Delete document"); expect(container.textContent).toContain("Delete this document?"); expect(save).not.toHaveBeenCalled(); await click("Cancel"); await click("Delete document"); await click("Delete"); }
    else if (scenario === "restore") { await click("rev 4"); await click("rev 0"); expect(container.textContent).toContain("Viewing revision 0"); await click("Restore this revision"); }
    else if (scenario === "save") { await click("Edit document"); await act(async () => markdownEditorMockState.changeBody?.("Raw draft body")); await click("Submit test edit"); }
    else await click("Lock document");
    const en = scenario === "save" ? "An unexpected error occurred. Please try again." : scenario === "delete" ? "Document deletion is not available" : scenario === "restore" ? "Document revision restore is not available" : "Document locking is not available";
    expect(container.textContent).toContain(en);
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(container.textContent).toContain(scenario === "save" ? "发生了意外错误，请重试。" : scenario === "manual" ? en : scenario === "delete" ? "无法删除文档" : scenario === "restore" ? "无法恢复文档修订版本" : "无法锁定文档");
    expect(container.textContent).toContain(scenario === "save" ? "Raw draft body" : "Raw body"); expect(save).toHaveBeenCalledTimes(scenario === "save" ? 1 : 0);
    if (scenario === "save") expect(container.textContent).not.toContain(en); expect(manual).toHaveBeenCalledTimes(scenario === "manual" ? 1 : 0);
    await act(async () => { await i18n.changeLanguage("en"); }); expect(container.textContent).toContain(en);
  } finally { await act(async () => root.unmount()); client.clear(); container.remove(); await i18n.changeLanguage("en"); }
});

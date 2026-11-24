// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueDocument } from "@paperclipai/shared";
import { expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { IssueDocumentsSection } from "./IssueDocumentsSection";

const api = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  upsertDocument: vi.fn(),
}));

vi.mock("../api/issues", () => ({ issuesApi: api }));
vi.mock("../api/auth", () => ({
  authApi: { getSession: async () => ({ user: { id: "user-1" } }) },
}));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ hash: "" }) }));
vi.mock("./DocumentMarkdownBody", () => ({
  DocumentMarkdownBody: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Document body" value={value} onChange={event => onChange(event.target.value)} />
  ),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => children,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => children,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => children,
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => children,
  DropdownMenuSeparator: () => null,
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

function createIssue(): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Document editing",
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
    issueNumber: 1,
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
    planDocument: null,
    documentSummaries: [],
    legacyPlanDocument: null,
    createdAt: new Date("2026-03-31T12:00:00.000Z"),
    updatedAt: new Date("2026-03-31T12:05:00.000Z"),
  };
}

it("keeps the fetched conflict revision until the document list has a newer revision", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const doc = createIssueDocument({ key: "report", title: "Report", body: "Original report" });
  api.listDocuments.mockResolvedValue([doc]);
  api.getDocument.mockResolvedValue({
    ...doc,
    body: "Agent update",
    latestRevisionId: "revision-5",
    latestRevisionNumber: 5,
  });
  api.upsertDocument.mockRejectedValue(new ApiError("Document changed", 409, null));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const button = (label: string) => [...container.querySelectorAll("button")]
    .find(item => item.textContent?.trim() === label);
  const editor = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Document body"]')!;
  const typeBody = (body: string) => act(async () => {
    const input = editor();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, body);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  try {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <IssueDocumentsSection issue={createIssue()} canDeleteDocuments={false} generalDocumentsOnly />
      </QueryClientProvider>,
    ));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(button("Edit document")).toBeDefined();
    });
    await act(async () => button("Edit document")!.click());
    await typeBody("My first edit");
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(button("Reload remote")).toBeDefined();
    }, { timeout: 3000 });
    expect(container.textContent).toContain("Remote revision 5");
    expect(container.textContent).toContain("Agent update");

    const latest = {
      ...doc,
      body: "Second agent update",
      latestRevisionId: "revision-6",
      latestRevisionNumber: 6,
    };
    await act(async () => client.setQueryData(queryKeys.issues.documents("issue-1"), [latest]));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).toContain("Remote revision 6");
    });
    await act(async () => button("Reload remote")!.click());
    expect(editor().value).toBe(latest.body);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  }
});

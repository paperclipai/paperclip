// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueLink } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueLinksSection } from "./IssueLinksSection";

const mockIssuesApi = vi.hoisted(() => ({
  listLinks: vi.fn(),
  createLink: vi.fn(),
  updateLink: vi.fn(),
  deleteLink: vi.fn(),
}));

const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function changeInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Linked issue",
    description: null,
    dueDate: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    links: [],
    createdAt: new Date("2026-04-18T12:00:00.000Z"),
    updatedAt: new Date("2026-04-18T12:05:00.000Z"),
    ...overrides,
  };
}

function createLink(overrides: Partial<IssueLink> = {}): IssueLink {
  return {
    id: "link-1",
    companyId: "company-1",
    issueId: "issue-1",
    url: "https://example.com/spec",
    title: "Spec",
    position: 0,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdByRunId: null,
    createdAt: new Date("2026-04-18T12:00:00.000Z"),
    updatedAt: new Date("2026-04-18T12:00:00.000Z"),
    ...overrides,
  };
}

function renderSection(container: HTMLDivElement, issue: Issue) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IssueLinksSection issue={issue} />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("IssueLinksSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    mockIssuesApi.listLinks.mockResolvedValue([]);
    mockIssuesApi.createLink.mockImplementation(async (_issueId: string, data: { url: string }) =>
      createLink({ id: "created-link", url: data.url, title: null }),
    );
    mockIssuesApi.updateLink.mockImplementation(async (id: string, data: Partial<IssueLink>) =>
      createLink({ id, title: data.title ?? "Spec" }),
    );
    mockIssuesApi.deleteLink.mockResolvedValue(createLink());
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders existing links", async () => {
    const link = createLink();
    mockIssuesApi.listLinks.mockResolvedValue([link]);
    const root = renderSection(container, createIssue({ links: [link] }));
    await flush();

    expect(container.textContent).toContain("Links");
    expect(container.textContent).toContain("Spec");
    expect(container.querySelector('a[href="https://example.com/spec"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("adds a link", async () => {
    mockIssuesApi.listLinks
      .mockResolvedValueOnce([])
      .mockResolvedValue([createLink({ id: "created-link", url: "https://example.com/new", title: null })]);
    const root = renderSection(container, createIssue());
    await flush();

    const input = container.querySelector('input[aria-label="New link URL"]') as HTMLInputElement;
    act(() => {
      changeInputValue(input, "https://example.com/new");
    });
    await act(async () => {
      container.querySelector('[aria-label="Add link"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    await flush();

    expect(mockIssuesApi.createLink).toHaveBeenCalledWith("issue-1", { url: "https://example.com/new" });
    expect(container.textContent).toContain("example.com");

    act(() => root.unmount());
  });

  it("adds an Apple Note link with a title and Notes label", async () => {
    mockIssuesApi.listLinks
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        createLink({
          id: "apple-note-link",
          url: "applenotes://showNote?identifier=ABCDEF",
          title: "Client note",
        }),
      ]);
    mockIssuesApi.createLink.mockImplementation(async (_issueId: string, data: { url: string; title?: string }) =>
      createLink({ id: "apple-note-link", url: data.url, title: data.title ?? null }),
    );
    const root = renderSection(container, createIssue());
    await flush();

    const appleButton = container.querySelector('button[aria-label="Add Apple Note"]') as HTMLButtonElement;
    await act(async () => {
      appleButton.click();
    });

    const titleInput = container.querySelector('input[aria-label="Apple Note title"]') as HTMLInputElement;
    const urlInput = container.querySelector('input[aria-label="Apple Note URL"]') as HTMLInputElement;
    act(() => {
      changeInputValue(titleInput, "Client note");
      changeInputValue(urlInput, "applenotes://showNote?identifier=ABCDEF");
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Add")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    await flush();

    expect(mockIssuesApi.createLink).toHaveBeenCalledWith("issue-1", {
      url: "applenotes://showNote?identifier=ABCDEF",
      title: "Client note",
    });
    expect(container.textContent).toContain("Client note");
    expect(container.textContent).toContain("Apple Note");

    act(() => root.unmount());
  });

  it("shows an inline error for malformed link URLs", async () => {
    const root = renderSection(container, createIssue());
    await flush();

    const input = container.querySelector('input[aria-label="New link URL"]') as HTMLInputElement;
    act(() => {
      changeInputValue(input, "javascript:alert(1)");
    });
    await act(async () => {
      container.querySelector('[aria-label="Add link"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockIssuesApi.createLink).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Paste a valid http(s)");

    act(() => root.unmount());
  });

  it("restores a deleted link when delete fails", async () => {
    const link = createLink();
    mockIssuesApi.listLinks.mockResolvedValue([link]);
    mockIssuesApi.deleteLink.mockRejectedValue(new Error("Nope"));
    const root = renderSection(container, createIssue({ links: [link] }));
    await flush();

    await act(async () => {
      container.querySelector('[aria-label="Delete link"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Spec");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Link was not deleted" }));

    act(() => root.unmount());
  });
});

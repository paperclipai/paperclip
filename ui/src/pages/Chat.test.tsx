// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "./Chat";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockIssuesApi = vi.hoisted(() => ({
  getCeoChat: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
  }),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  NavLink: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("../components/IssueChatThread", () => ({
  IssueChatThread: () => <div data-testid="issue-chat-thread">Chat Thread</div>,
}));

vi.mock("../lib/optimistic-issue-comments", () => ({
  flattenIssueCommentPages: (pages: unknown[][] | undefined) => (pages ?? []).flat(),
  getNextIssueCommentPageParam: () => null,
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    issues: {
      comments: (id: string) => ["issues", "comments", id],
    },
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderPage(queryClient: QueryClient) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Chat />
      </QueryClientProvider>,
    );
  });
  return { container, root };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Chat page", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mockIssuesApi.listComments.mockResolvedValue([]);
    mockIssuesApi.addComment.mockResolvedValue({});
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the IssueChatThread for the CEO chat issue", async () => {
    mockIssuesApi.getCeoChat.mockResolvedValue({
      issueId: "issue-ceo-1",
      companyId: "company-1",
      assigneeAgentId: "agent-ceo",
      isCeoChat: true,
      status: "in_progress",
      title: "CEO Chat",
    });

    const queryClient = makeQueryClient();
    const result = renderPage(queryClient);
    container = result.container as HTMLDivElement;
    root = result.root;

    await flushReact();

    const stub = container.querySelector('[data-testid="issue-chat-thread"]');
    expect(stub).not.toBeNull();
  });

  it("shows an empty state when no CEO is hired yet", async () => {
    const { ApiError } = await import("../api/client");
    mockIssuesApi.getCeoChat.mockRejectedValue(
      new ApiError("not found", 404, null),
    );

    const queryClient = makeQueryClient();
    const result = renderPage(queryClient);
    container = result.container as HTMLDivElement;
    root = result.root;

    await flushReact();

    expect(container.textContent).toMatch(/hire your ceo/i);
  });
});

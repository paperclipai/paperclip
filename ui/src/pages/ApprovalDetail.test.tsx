// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalDetail } from "./ApprovalDetail";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const getApprovalMock = vi.fn();
const listCommentsMock = vi.fn();
const listIssuesMock = vi.fn();
const listAgentsMock = vi.fn();
const setSelectedCompanyIdMock = vi.fn();
const setBreadcrumbsMock = vi.fn();
const navigateMock = vi.fn();

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    get: () => getApprovalMock(),
    listComments: () => listCommentsMock(),
    listIssues: () => listIssuesMock(),
    approve: vi.fn(),
    reject: vi.fn(),
    requestRevision: vi.fn(),
    resubmit: vi.fn(),
    addComment: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: () => listAgentsMock(),
    remove: vi.fn(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    setSelectedCompanyId: setSelectedCompanyIdMock,
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    approvals: {
      detail: (approvalId: string) => ["approvals", "detail", approvalId],
      comments: (approvalId: string) => ["approvals", "comments", approvalId],
      issues: (approvalId: string) => ["approvals", "issues", approvalId],
      list: (companyId: string, status?: string) => ["approvals", companyId, status ?? "all"],
    },
    agents: {
      list: (companyId: string) => ["agents", companyId],
    },
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className }: { children: unknown; to: string; className?: string }) => (
    <a href={to} className={className}>{children as never}</a>
  ),
  useNavigate: () => navigateMock,
  useParams: () => ({ approvalId: "approval-1" }),
  useSearchParams: () => [new URLSearchParams("resolved=approved"), vi.fn()],
}));

vi.mock("../components/ApprovalPayload", () => ({
  approvalLabel: () => "Hire agent",
  typeIcon: {},
  defaultTypeIcon: () => <div>type-icon</div>,
  ApprovalPayloadRenderer: () => <div>approval-payload</div>,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ApprovalDetail", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getApprovalMock.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      status: "approved",
      type: "hire_agent",
      payload: { agentId: "agent-2" },
      requestedByAgentId: "agent-1",
      decisionNote: null,
    });
    listCommentsMock.mockResolvedValue([]);
    listIssuesMock.mockResolvedValue([]);
    listAgentsMock.mockResolvedValue([
      { id: "agent-1", name: "Requester Bot" },
    ]);
    setSelectedCompanyIdMock.mockReset();
    setBreadcrumbsMock.mockReset();
    navigateMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <ApprovalDetail />
          </I18nProvider>
        </QueryClientProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    return root;
  }

  async function waitFor(condition: () => boolean, attempts = 10) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (condition()) return;
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    throw new Error("Timed out waiting for ApprovalDetail to settle");
  }

  it("renders localized approval detail chrome", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("审批已确认") === true);

    expect(container.textContent).toContain("审批已确认");
    expect(container.textContent).toContain("请求智能体已收到通知，会检查该审批及关联事项。");
    expect(container.textContent).toContain("打开已录用智能体");
    expect(container.textContent).toContain("发起人");
    expect(container.textContent).toContain("查看完整请求");
    expect(container.textContent).toContain("关联事项");
    expect(container.textContent).toContain("发布评论");
    expect(container.textContent).toContain("评论");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "审批", href: "/approvals" },
      { label: "approval" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });
});

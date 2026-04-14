// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalDetail } from "./ApprovalDetail";
import { I18nProvider } from "../context/I18nContext";
import { ThemeProvider } from "../context/ThemeContext";

const navigateMock = vi.fn();
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storage.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    storage.delete(key);
  }),
};

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
  ),
  useNavigate: () => navigateMock,
  useParams: () => ({ approvalId: "approval-1" }),
  useSearchParams: () => [new URLSearchParams(""), vi.fn()],
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    get: vi.fn(async () => ({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      requestedByAgentId: "agent-1",
      payload: {
        agentId: "agent-1",
        name: "Agent One",
        role: "engineer",
        title: "VP of Engineering",
        icon: "code",
        capabilities: "Build systems",
        adapterType: "codex_local",
        desiredSkills: ["paperclip"],
      },
      decisionNote: "Please tighten the scope first.",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    })),
    listComments: vi.fn(async () => [
      {
        id: "comment-1",
        approvalId: "approval-1",
        authorAgentId: null,
        body: "A board-side comment",
        createdAt: new Date("2026-04-02T01:02:03.000Z"),
      },
    ]),
    listIssues: vi.fn(async () => [
      {
        id: "issue-1",
        identifier: "PAP-123",
        title: "Follow up on the approval",
      },
    ]),
    approve: vi.fn(),
    reject: vi.fn(),
    requestRevision: vi.fn(),
    resubmit: vi.fn(),
    addComment: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn(async () => [
      {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent One",
      },
    ]),
    remove: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ApprovalDetail", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    storage.clear();
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      configurable: true,
    });
    localStorage.setItem("paperclip.locale", "zh-CN");
  });

  afterEach(() => {
    localStorage.removeItem("paperclip.locale");
    container.remove();
    navigateMock.mockReset();
  });

  it("renders zh-CN copy for the approval detail surface", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const root = createRoot(container);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <ThemeProvider>
              <ApprovalDetail />
            </ThemeProvider>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    expect(container.textContent).toContain("招聘智能体: VP of Engineering");
    expect(container.textContent).toContain("请求人");
    expect(container.textContent).toContain("查看完整请求");
    expect(container.textContent).toContain("关联任务");
    expect(container.textContent).toContain("评论（1）");
    expect(container.textContent).toContain("批准");
    expect(container.textContent).toContain("拒绝");
    expect(container.textContent).toContain("名称");
    expect(container.textContent).toContain("角色");
    expect(container.textContent).toContain("头衔");
    expect(container.textContent).toContain("能力");
    expect(container.textContent).toContain("适配器");
    expect(container.textContent).toContain("技能");
    expect(container.textContent).not.toContain("Hire Agent");
    expect(container.textContent).not.toContain("Requested by");
    expect(container.textContent).not.toContain("Post comment");
    expect(container.textContent).not.toContain("Name");
    expect(container.textContent).not.toContain("Role");
    expect(container.textContent).not.toContain("Title");
    expect(container.textContent).not.toContain("Capabilities");
    expect(container.textContent).not.toContain("Adapter");
    expect(container.textContent).not.toContain("Skills");
    expect(container.querySelector("textarea")?.getAttribute("placeholder")).toBe("添加评论...");

    act(() => {
      root.unmount();
    });
  });
});

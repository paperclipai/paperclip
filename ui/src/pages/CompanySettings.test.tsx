// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettings, buildAgentSnippet } from "./CompanySettings";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const setBreadcrumbsMock = vi.fn();
const pushToastMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const setSelectedCompanyIdMock = vi.fn();

let companies = [
  { id: "company-1", status: "active", name: "Paperclip", issuePrefix: "pc" },
  { id: "company-2", status: "active", name: "Other", issuePrefix: "ot" },
];
let selectedCompanyId: string | null = "company-1";
let selectedCompany: {
  id: string;
  name: string;
  description: string | null;
  brandColor: string | null;
  logoUrl: string | null;
  status: string;
  requireBoardApprovalForNewAgents: boolean;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingTermsVersion: string | null;
  feedbackDataSharingConsentAt: string | null;
  feedbackDataSharingConsentByUserId: string | null;
} | null = {
  id: "company-1",
  name: "Paperclip",
  description: "Workspace tools",
  brandColor: null,
  logoUrl: null,
  status: "active",
  requireBoardApprovalForNewAgents: false,
  feedbackDataSharingEnabled: false,
  feedbackDataSharingTermsVersion: null,
  feedbackDataSharingConsentAt: null,
  feedbackDataSharingConsentByUserId: null,
};

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies, selectedCompany, selectedCompanyId, setSelectedCompanyId: setSelectedCompanyIdMock }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("../api/companies", () => ({
  companiesApi: {
    update: vi.fn(),
    archive: vi.fn(),
  },
}));

vi.mock("../api/access", () => ({
  accessApi: {
    createOpenClawInvitePrompt: vi.fn(),
    getInviteOnboarding: vi.fn(),
  },
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadCompanyLogo: vi.fn(),
  },
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    companies: { all: ["companies", "all"], stats: ["companies", "stats"] },
    sidebarBadges: (companyId: string) => ["sidebar-badges", companyId],
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
}));

vi.mock("../components/CompanyPatternIcon", () => ({
  CompanyPatternIcon: () => <div>company-pattern-icon</div>,
}));

vi.mock("../components/agent-config-primitives", () => ({
  Field: ({ label, hint, children }: { label: string; hint?: string; children: unknown }) => (
    <label>
      <span>{label}</span>
      {hint ? <span>{hint}</span> : null}
      <div>{children as never}</div>
    </label>
  ),
  ToggleField: ({ label, hint }: { label: string; hint?: string }) => (
    <div>
      <span>{label}</span>
      {hint ? <span>{hint}</span> : null}
    </div>
  ),
  HintIcon: ({ text }: { text: string }) => <span>{text}</span>,
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CompanySettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companies = [
      { id: "company-1", status: "active", name: "Paperclip", issuePrefix: "pc" },
      { id: "company-2", status: "active", name: "Other", issuePrefix: "ot" },
    ];
    selectedCompanyId = "company-1";
    selectedCompany = {
      id: "company-1",
      name: "Paperclip",
      description: "Workspace tools",
      brandColor: null,
      logoUrl: null,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      feedbackDataSharingEnabled: false,
      feedbackDataSharingTermsVersion: null,
      feedbackDataSharingConsentAt: null,
      feedbackDataSharingConsentByUserId: null,
    };
    setBreadcrumbsMock.mockReset();
    pushToastMock.mockReset();
    invalidateQueriesMock.mockReset();
    setSelectedCompanyIdMock.mockReset();
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
        mutations: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <CompanySettings />
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

    throw new Error("Timed out waiting for CompanySettings to settle");
  }

  it("renders localized empty state when no company is selected", async () => {
    selectedCompany = null;
    selectedCompanyId = null;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("尚未选择公司。请先从上方切换器中选择一个公司。") === true);

    expect(container.textContent).toContain("尚未选择公司。请先从上方切换器中选择一个公司。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized shell copy for selected company", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("公司设置") === true);

    expect(container.textContent).toContain("公司设置");
    expect(container.textContent).toContain("常规");
    expect(container.textContent).toContain("公司名称");
    expect(container.textContent).toContain("外观");
    expect(container.textContent).toContain("徽标");
    expect(container.textContent).toContain("品牌颜色");
    expect(container.textContent).toContain("雇佣");
    expect(container.textContent).toContain("反馈共享");
    expect(container.textContent).toContain("阅读我们的服务条款");
    expect(container.textContent).toContain("邀请");
    expect(container.textContent).toContain("生成 OpenClaw 邀请提示");
    expect(container.textContent).toContain("公司包");
    expect(container.textContent).toContain("导出");
    expect(container.textContent).toContain("导入");
    expect(container.textContent).toContain("危险区");
    expect(container.textContent).toContain("归档公司");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "Paperclip", href: "/dashboard" },
      { label: "设置" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });

  it("builds a localized onboarding snippet for invites", () => {
    const snippet = buildAgentSnippet({
      onboardingTextUrl: "https://paperclip.example.com/api/invites/token/onboarding.txt",
      connectionCandidates: ["https://paperclip.example.com"],
      testResolutionUrl: "https://paperclip.example.com/api/invites/token/test-resolution",
    });

    expect(snippet).toContain("你已被邀请加入一个 Paperclip 组织。");
    expect(snippet).toContain("你应该尝试的 URL：");
    expect(snippet).toContain("连通性说明：");
    expect(snippet).toContain("你必须测试 Paperclip 到 gateway 的连通性");
    expect(snippet).not.toContain("You're invited to join a Paperclip organization.");
  });
});

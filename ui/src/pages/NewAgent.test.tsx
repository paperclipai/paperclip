// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewAgent } from "./NewAgent";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const listAgentsMock = vi.fn();
const adapterModelsMock = vi.fn();
const listCompanySkillsMock = vi.fn();
const hireMock = vi.fn();
const setBreadcrumbsMock = vi.fn();
const navigateMock = vi.fn();

let selectedCompanyId: string | null = "company-1";
let adapterTypeParam: string | null = null;

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: () => listAgentsMock(),
    adapterModels: () => adapterModelsMock(),
    hire: (companyId: string, data: Record<string, unknown>) => hireMock(companyId, data),
  },
}));

vi.mock("../api/companySkills", () => ({
  companySkillsApi: {
    list: () => listCompanySkillsMock(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    agents: {
      list: (companyId: string) => ["agents", companyId],
      adapterModels: (companyId: string, adapterType: string) => ["agents", companyId, "adapter-models", adapterType],
    },
    companySkills: {
      list: (companyId: string) => ["company-skills", companyId],
    },
    approvals: {
      list: (companyId: string) => ["approvals", companyId],
    },
  },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [{ get: (key: string) => (key === "adapterType" ? adapterTypeParam : null) }],
}));

vi.mock("../components/agent-config-primitives", () => ({
  roleLabels: { general: "General", ceo: "CEO" },
}));

vi.mock("../components/AgentConfigForm", () => ({
  AgentConfigForm: () => <div>agent-config-form</div>,
}));

vi.mock("../components/ReportsToPicker", () => ({
  ReportsToPicker: () => <div>reports-to-picker</div>,
}));

vi.mock("../components/ui/popover", () => ({
  Popover: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  PopoverTrigger: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  PopoverContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: () => <div>checkbox</div>,
}));

vi.mock("../adapters", () => ({
  getUIAdapter: () => ({ buildAdapterConfig: () => ({}) }),
  listUIAdapters: () => [],
}));

vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => undefined,
}));

vi.mock("../adapters/metadata", () => ({
  isValidAdapterType: () => false,
}));

vi.mock("../lib/new-agent-runtime-config", () => ({
  buildNewAgentRuntimeConfig: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("NewAgent", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    selectedCompanyId = "company-1";
    adapterTypeParam = null;
    listAgentsMock.mockResolvedValue([]);
    adapterModelsMock.mockResolvedValue([]);
    listCompanySkillsMock.mockResolvedValue([]);
    hireMock.mockResolvedValue({ agent: { id: "agent-1", urlKey: "agent-1" } });
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
        mutations: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <NewAgent />
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

    throw new Error("Timed out waiting for NewAgent to settle");
  }

  it("renders localized page shell and placeholders", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("新建智能体") === true);

    expect(container.textContent).toContain("新建智能体");
    expect(container.textContent).toContain("高级智能体配置");
    expect(container.innerHTML).toContain('placeholder="智能体名称"');
    expect(container.innerHTML).toContain('placeholder="头衔（例如：工程副总裁）"');
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "智能体", href: "/agents" },
      { label: "新建智能体" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized skills empty state and first-agent hint", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("公司技能") === true);

    expect(container.textContent).toContain("公司技能");
    expect(container.textContent).toContain("来自公司技能库的可选技能。内置的 Paperclip 运行时技能会自动添加。");
    expect(container.textContent).toContain("当前还没有安装可选的公司技能。");
    expect(container.textContent).toContain("这将是 CEO");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized footer actions", async () => {
    listAgentsMock.mockResolvedValue([
      { id: "agent-1", name: "Worker" },
    ]);
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("取消") === true);

    expect(container.textContent).toContain("取消");
    expect(container.textContent).toContain("创建智能体");

    await act(async () => {
      root.unmount();
    });
  });
});

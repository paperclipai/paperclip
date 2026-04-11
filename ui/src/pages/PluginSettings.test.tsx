// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginSettings } from "./PluginSettings";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const getPluginMock = vi.fn();
const healthMock = vi.fn();
const dashboardMock = vi.fn();
const logsMock = vi.fn();
const getConfigMock = vi.fn();
const setBreadcrumbsMock = vi.fn();

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    get: () => getPluginMock(),
    health: () => healthMock(),
    dashboard: () => dashboardMock(),
    logs: () => logsMock(),
    getConfig: () => getConfigMock(),
    saveConfig: vi.fn(),
    testConfig: vi.fn(),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null, selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children: unknown }) => <a>{children as never}</a>,
  Navigate: () => <div>navigate</div>,
  useParams: () => ({ pluginId: "plugin-1", companyPrefix: undefined }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => null,
  usePluginSlots: () => ({ slots: [] }),
}));

vi.mock("@/lib/queryKeys", () => ({
  queryKeys: {
    plugins: {
      detail: (pluginId: string) => ["plugins", "detail", pluginId],
      health: (pluginId: string) => ["plugins", "health", pluginId],
      dashboard: (pluginId: string) => ["plugins", "dashboard", pluginId],
      logs: (pluginId: string) => ["plugins", "logs", pluginId],
      config: (pluginId: string) => ["plugins", "config", pluginId],
    },
  },
}));

vi.mock("@/components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ label: string }> }) => (
    <div>{items.map((item) => item.label).join(", ")}</div>
  ),
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  TabsContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

vi.mock("@/components/JsonSchemaForm", () => ({
  JsonSchemaForm: () => <div>json-schema-form</div>,
  validateJsonSchemaForm: () => ({}),
  getDefaultValues: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("PluginSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getPluginMock.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "plugin.example",
      packageName: "@paperclipai/plugin-example",
      version: "1.0.0",
      status: "ready",
      categories: [],
      manifestJson: {
        displayName: "Example Plugin",
        description: "Plugin description",
        author: "Paperclip",
        version: "1.0.0",
        capabilities: [],
      },
      supportsConfigTest: true,
    });
    healthMock.mockResolvedValue(null);
    dashboardMock.mockResolvedValue(null);
    logsMock.mockResolvedValue([]);
    getConfigMock.mockResolvedValue({ configJson: {} });
    setBreadcrumbsMock.mockReset();
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
            <PluginSettings />
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

    throw new Error("Timed out waiting for PluginSettings to settle");
  }

  it("renders localized plugin settings frame and breadcrumbs", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("配置") === true && container.textContent?.includes("关于") === true);

    expect(container.textContent).toContain("配置");
    expect(container.textContent).toContain("状态");
    expect(container.textContent).toContain("关于");
    expect(container.textContent).toContain("设置");
    expect(container.textContent).toContain("健康状态");
    expect(container.textContent).toContain("详情");
    expect(container.textContent).toContain("权限");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "Company", href: "/dashboard" },
      { label: "设置", href: "/instance/settings/heartbeats" },
      { label: "插件", href: "/instance/settings/plugins" },
      { label: "Example Plugin" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });
});

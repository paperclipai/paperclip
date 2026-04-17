// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginManager } from "./PluginManager";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const listPluginsMock = vi.fn();
const listExamplesMock = vi.fn();
const setBreadcrumbsMock = vi.fn();
const pushToastMock = vi.fn();

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    list: () => listPluginsMock(),
    listExamples: () => listExamplesMock(),
    install: vi.fn(),
    uninstall: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("@/lib/queryKeys", () => ({
  queryKeys: {
    plugins: {
      all: ["plugins", "all"],
      examples: ["plugins", "examples"],
      uiContributions: ["plugins", "ui-contributions"],
    },
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children: unknown }) => <a>{children as never}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("PluginManager", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listPluginsMock.mockResolvedValue([]);
    listExamplesMock.mockResolvedValue([]);
    setBreadcrumbsMock.mockReset();
    pushToastMock.mockReset();
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
            <PluginManager />
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

    throw new Error("Timed out waiting for PluginManager to settle");
  }

  it("renders localized plugin manager chrome and breadcrumbs", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("插件管理") === true);

    expect(container.textContent).toContain("插件管理");
    expect(container.textContent).toContain("安装插件");
    expect(container.textContent).toContain("可用插件");
    expect(container.textContent).toContain("已安装插件");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "Company", href: "/dashboard" },
      { label: "设置", href: "/instance/settings/heartbeats" },
      { label: "插件" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });
});

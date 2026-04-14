// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginPage } from "./PluginPage";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const listUiContributionsMock = vi.fn();
const setBreadcrumbsMock = vi.fn();

let routeCompanyPrefix: string | undefined;
let pluginId: string | undefined;
let pluginRoutePath: string | undefined;
let companies: Array<{ id: string; issuePrefix: string }> = [];
let selectedCompanyId: string | null = null;

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    listUiContributions: () => listUiContributionsMock(),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ companies, selectedCompanyId }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/lib/queryKeys", () => ({
  queryKeys: {
    plugins: { uiContributions: ["plugins", "ui-contributions"] },
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
  Navigate: ({ to }: { to: string }) => <div>{to}</div>,
  useParams: () => ({ companyPrefix: routeCompanyPrefix, pluginId, pluginRoutePath }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: ({ slot }: { slot: { pluginDisplayName: string } }) => <div>{slot.pluginDisplayName}</div>,
}));

vi.mock("./NotFound", () => ({
  NotFoundPage: () => <div>not-found-page</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("PluginPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    routeCompanyPrefix = undefined;
    pluginId = "plugin-1";
    pluginRoutePath = undefined;
    companies = [{ id: "company-1", issuePrefix: "pc" }];
    selectedCompanyId = "company-1";
    listUiContributionsMock.mockResolvedValue([]);
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
            <PluginPage />
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

    throw new Error("Timed out waiting for PluginPage to settle");
  }

  it("renders localized empty state when no company is selected", async () => {
    companies = [];
    selectedCompanyId = null;
    pluginId = undefined;
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("选择一个公司以查看此页面。") === true);

    expect(container.textContent).toContain("选择一个公司以查看此页面。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized loading state", async () => {
    listUiContributionsMock.mockImplementation(() => new Promise(() => {}));
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    expect(container.textContent).toContain("加载中…");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized conflict message", async () => {
    pluginId = undefined;
    pluginRoutePath = "reports";
    listUiContributionsMock.mockResolvedValue([
      { pluginId: "plugin-1", pluginKey: "a", displayName: "A", version: "1.0.0", slots: [{ type: "page", routePath: "reports" }] },
      { pluginId: "plugin-2", pluginKey: "b", displayName: "B", version: "1.0.0", slots: [{ type: "page", routePath: "reports" }] },
    ]);
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("多个插件声明了路由 reports。") === true);

    expect(container.textContent).toContain("多个插件声明了路由 reports。在冲突解决之前，请使用 plugin-id 路由。");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders localized breadcrumb and back button when slot exists", async () => {
    listUiContributionsMock.mockResolvedValue([
      { pluginId: "plugin-1", pluginKey: "plugin.one", displayName: "Reports", version: "1.0.0", slots: [{ type: "page", routePath: "reports" }] },
    ]);
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("返回") === true);

    expect(container.textContent).toContain("返回");
    expect(container.textContent).toContain("Reports");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "插件", href: "/instance/settings/plugins" },
      { label: "Reports" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });
});

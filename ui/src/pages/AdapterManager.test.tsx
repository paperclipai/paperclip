// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterManager } from "./AdapterManager";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const listAdaptersMock = vi.fn();
const setBreadcrumbsMock = vi.fn();
const pushToastMock = vi.fn();

vi.mock("@/api/adapters", () => ({
  adaptersApi: {
    list: () => listAdaptersMock(),
    install: vi.fn(),
    remove: vi.fn(),
    setDisabled: vi.fn(),
    setOverridePaused: vi.fn(),
    reload: vi.fn(),
    reinstall: vi.fn(),
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
    adapters: { all: ["adapters", "all"] },
  },
}));

vi.mock("@/components/PathInstructionsModal", () => ({
  ChoosePathButton: () => <button type="button">Choose path</button>,
}));

vi.mock("@/adapters/dynamic-loader", () => ({
  invalidateDynamicParser: vi.fn(),
}));

vi.mock("@/adapters/schema-config-fields", () => ({
  invalidateConfigSchemaCache: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AdapterManager", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listAdaptersMock.mockResolvedValue([]);
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
            <AdapterManager />
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

    throw new Error("Timed out waiting for AdapterManager to settle");
  }

  it("renders localized adapter manager chrome and breadcrumbs", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("安装适配器") === true && container.textContent?.includes("内置适配器") === true);

    expect(container.textContent).toContain("适配器");
    expect(container.textContent).toContain("安装适配器");
    expect(container.textContent).toContain("外部适配器");
    expect(container.textContent).toContain("内置适配器");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "Company", href: "/dashboard" },
      { label: "设置", href: "/instance/settings/general" },
      { label: "适配器" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });
});

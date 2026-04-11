// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceExperimentalSettings } from "./InstanceExperimentalSettings";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const getExperimentalMock = vi.fn();
const updateExperimentalMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const setBreadcrumbsMock = vi.fn();

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getExperimental: () => getExperimentalMock(),
    updateExperimental: (payload: unknown) => updateExperimentalMock(payload),
  },
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    instance: { experimentalSettings: ["instance", "experimental-settings"] },
    health: ["health"],
  },
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

describe("InstanceExperimentalSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getExperimentalMock.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: true,
    });
    updateExperimentalMock.mockResolvedValue(undefined);
    invalidateQueriesMock.mockResolvedValue(undefined);
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
            <InstanceExperimentalSettings />
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

    throw new Error("Timed out waiting for InstanceExperimentalSettings to settle");
  }

  it("renders localized experimental copy and breadcrumbs", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("实验功能") === true);

    expect(container.textContent).toContain("实验功能");
    expect(container.textContent).toContain("启用隔离工作区");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "实例设置" },
      { label: "实验功能" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });
});

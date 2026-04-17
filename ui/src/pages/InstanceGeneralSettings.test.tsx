// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceGeneralSettings } from "./InstanceGeneralSettings";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const generalSettingsMock = vi.fn();
const updateGeneralMock = vi.fn();
const signOutMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const setBreadcrumbsMock = vi.fn();

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getGeneral: () => generalSettingsMock(),
    updateGeneral: (payload: unknown) => updateGeneralMock(payload),
  },
}));

vi.mock("@/api/auth", () => ({
  authApi: {
    signOut: () => signOutMock(),
  },
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    auth: { session: ["auth", "session"] },
    instance: { generalSettings: ["instance", "general-settings"] },
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

describe("InstanceGeneralSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    generalSettingsMock.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
      backupRetention: {
        dailyDays: 7,
        weeklyWeeks: 4,
        monthlyMonths: 6,
      },
    });
    updateGeneralMock.mockResolvedValue(undefined);
    signOutMock.mockResolvedValue(undefined);
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
            <InstanceGeneralSettings />
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

    throw new Error("Timed out waiting for InstanceGeneralSettings to settle");
  }

  it("renders English copy by default and updates breadcrumbs", async () => {
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("Language") === true);

    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "Instance Settings" },
      { label: "General" },
    ]);
    expect(container.textContent).toContain("General");
    expect(container.textContent).toContain("Language");

    await act(async () => {
      root.unmount();
    });
  });

  it("switches to Chinese and persists the locale", async () => {
    const root = await renderPage();

    await waitFor(() => container.querySelector("select") instanceof HTMLSelectElement);

    const select = container.querySelector("select");
    expect(select).not.toBeNull();

    await act(async () => {
      select?.dispatchEvent(new Event("focus", { bubbles: true }));
      if (select instanceof HTMLSelectElement) {
        select.value = "zh-CN";
      }
      select?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("通用");
    expect(container.textContent).toContain("语言");
    expect(localStorage.getItem(I18N_LOCALE_STORAGE_KEY)).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "实例设置" },
      { label: "通用" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });
});

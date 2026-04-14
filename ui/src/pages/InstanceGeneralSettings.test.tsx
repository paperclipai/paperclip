// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceGeneralSettings } from "./InstanceGeneralSettings";
import { I18nProvider } from "../context/I18nContext";

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

const getGeneralMock = vi.fn();
const updateGeneralMock = vi.fn();
const signOutMock = vi.fn();

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: {
    getGeneral: () => getGeneralMock(),
    updateGeneral: (patch: unknown) => updateGeneralMock(patch),
  },
}));

vi.mock("@/api/auth", () => ({
  authApi: {
    signOut: () => signOutMock(),
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

describe("InstanceGeneralSettings", () => {
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
    getGeneralMock.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: true,
      feedbackDataSharingPreference: "prompt",
      backupRetention: {
        dailyDays: 7,
        weeklyWeeks: 4,
        monthlyMonths: 6,
      },
    });
    updateGeneralMock.mockResolvedValue({});
    signOutMock.mockResolvedValue({});
  });

  afterEach(() => {
    localStorage.removeItem("paperclip.locale");
    getGeneralMock.mockReset();
    updateGeneralMock.mockReset();
    signOutMock.mockReset();
    container.remove();
  });

  it("renders zh-CN copy for the general settings page", async () => {
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
            <InstanceGeneralSettings />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    expect(container.textContent).toContain("常规");
    expect(container.textContent).toContain("隐藏日志中的用户名");
    expect(container.textContent).toContain("键盘快捷键");
    expect(container.textContent).toContain("备份保留策略");
    expect(container.textContent).toContain("每日");
    expect(container.textContent).toContain("每周");
    expect(container.textContent).toContain("每月");
    expect(container.textContent).toContain("AI 反馈分享");
    expect(container.textContent).toContain("始终允许");
    expect(container.textContent).toContain("不允许");
    expect(container.textContent).toContain("退出登录");
    expect(container.textContent).not.toContain("Keyboard shortcuts");
    expect(container.textContent).not.toContain("Backup retention");
    expect(container.textContent).not.toContain("Sign out");
    expect(container.querySelector('[aria-label="切换日志用户名隐藏"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="切换键盘快捷键"]')).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });
});

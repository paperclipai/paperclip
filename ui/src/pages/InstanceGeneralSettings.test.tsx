// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceGeneralSettings } from "./InstanceGeneralSettings";

const mockAuthApi = vi.hoisted(() => ({
  signOut: vi.fn(),
}));

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({
    locale: "en",
    t: (key: string) =>
      ({
        "settings.instance.language.title": "Default language",
        "settings.instance.language.description": "Choose the default language for the whole instance.",
        "settings.instance.language.english": "English",
        "settings.instance.language.simplified_chinese": "简体中文",
      })[key] ?? key,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("InstanceGeneralSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockAuthApi.signOut.mockResolvedValue(undefined);
    mockHealthApi.get.mockResolvedValue({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      locale: "en",
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
      backupRetention: {
        dailyDays: 7,
        weeklyWeeks: 4,
        monthlyMonths: 1,
      },
    });
    mockInstanceSettingsApi.updateGeneral.mockResolvedValue(undefined);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders language controls for the instance default locale", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Default language");
    expect(container.textContent).toContain("Choose the default language for the whole instance.");
    expect(container.textContent).toContain("English");
    expect(container.textContent).toContain("简体中文");

    await act(async () => {
      root.unmount();
    });
  });
});

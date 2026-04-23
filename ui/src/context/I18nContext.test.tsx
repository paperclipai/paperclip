// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "./I18nContext";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  selectedCompany: {
    id: "company-1",
    name: "Paperclip",
    issuePrefix: "PAP",
    localeOverride: "zh-CN" as const,
  },
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("./CompanyContext", () => ({
  useCompany: () => companyState,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function Probe() {
  const { locale, t } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="message">{t("settings.instance.language.title")}</span>
    </div>
  );
}

describe("I18nContext", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
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
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("prefers company locale overrides over the instance default", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <Probe />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const localeNode = container.querySelector('[data-testid="locale"]');
    const messageNode = container.querySelector('[data-testid="message"]');

    expect(localeNode?.textContent).toBe("zh-CN");
    expect(messageNode?.textContent).toBe("默认语言");
    expect(document.documentElement.lang).toBe("zh-CN");

    await act(async () => {
      root.unmount();
    });
  });
});

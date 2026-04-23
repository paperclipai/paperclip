// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettings } from "./CompanySettings";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  createOpenClawInvitePrompt: vi.fn(),
  getInviteOnboarding: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [],
    selectedCompanyId: "company-1",
    selectedCompany: {
      id: "company-1",
      name: "Paperclip",
      description: null,
      issuePrefix: "PAP",
      localeOverride: null,
      requireBoardApprovalForNewAgents: false,
      feedbackDataSharingEnabled: false,
      feedbackDataSharingConsentAt: null,
      feedbackDataSharingConsentByUserId: null,
      feedbackDataSharingTermsVersion: null,
      brandColor: null,
      logoUrl: null,
    },
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({
    locale: "en",
    t: (key: string) =>
      ({
        "settings.company.language.title": "Language override",
        "settings.company.language.follow_instance": "Follow instance default",
        "settings.company.language.hint": "Choose a company-specific language or inherit the instance default.",
        "settings.company.language.english": "English",
        "settings.company.language.simplified_chinese": "简体中文",
        "settings.company.language.effective_label": "Effective language: {language}",
      })[key] ?? key,
  }),
}));

vi.mock("../components/CompanyPatternIcon", () => ({
  CompanyPatternIcon: () => <div>Company icon</div>,
}));

vi.mock("../components/agent-config-primitives", () => ({
  Field: ({
    label,
    hint,
    children,
  }: {
    label: string;
    hint?: string;
    children: React.ReactNode;
  }) => (
    <label>
      <span>{label}</span>
      {hint ? <span>{hint}</span> : null}
      {children}
    </label>
  ),
  ToggleField: () => null,
  HintIcon: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanySettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCompaniesApi.update.mockResolvedValue(undefined);
    mockAccessApi.createOpenClawInvitePrompt.mockResolvedValue(undefined);
    mockAccessApi.getInviteOnboarding.mockResolvedValue(undefined);
    mockAssetsApi.uploadCompanyLogo.mockResolvedValue(undefined);
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

  it("renders language override controls for the selected company", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <CompanySettings />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Language override");
    expect(container.textContent).toContain("Follow instance default");
    expect(container.textContent).toContain("English");
    expect(container.textContent).toContain("简体中文");

    await act(async () => {
      root.unmount();
    });
  });
});

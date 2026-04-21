// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, Company } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CompanySettings } from "./CompanySettings";

const defaultCompany = vi.hoisted((): Company => ({
  id: "company-1",
  name: "Comandero",
  description: "Restaurant ops company",
  status: "active",
  pauseReason: null,
  pausedAt: null,
  issuePrefix: "COMA",
  issueCounter: 100,
  roadmapPath: null,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  requireBoardApprovalForNewAgents: false,
  feedbackDataSharingEnabled: false,
  feedbackDataSharingConsentAt: null,
  feedbackDataSharingConsentByUserId: null,
  feedbackDataSharingTermsVersion: null,
  dailyExecutiveSummaryEnabled: false,
  criticalBoardAlertsEmailEnabled: true,
  dailyExecutiveSummaryLastSentAt: null,
  dailyExecutiveSummaryLastStatus: null,
  dailyExecutiveSummaryLastError: null,
  defaultRootIssueDeliveryMode: "engineering",
  releaseGateQaAgentId: null,
  resolvedReleaseGateQaAgentId: null,
  releaseGateQaResolutionSource: "none",
  releaseGateQaBlockingReason: null,
  brandColor: null,
  logoAssetId: null,
  logoUrl: null,
  createdAt: new Date("2026-04-01T00:00:00.000Z"),
  updatedAt: new Date("2026-04-01T00:00:00.000Z"),
}));

const companyState = vi.hoisted(() => ({
  companies: [defaultCompany],
  selectedCompany: defaultCompany,
  selectedCompanyId: defaultCompany.id,
  setSelectedCompanyId: vi.fn(),
}));

const breadcrumbsState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(async (_companyId: string, data: Partial<Company>) => ({
    ...companyState.selectedCompany,
    ...data,
  })),
  archive: vi.fn(async () => ({ ...companyState.selectedCompany, status: "archived" as const })),
}));

const mockAccessApi = vi.hoisted(() => ({
  createOpenClawInvitePrompt: vi.fn(),
  getInviteOnboarding: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const defaultAgents = vi.hoisted((): Agent[] => ([
  {
    id: "agent-qa-release",
    companyId: "company-1",
    name: "QA and Release Engineer",
    urlKey: "qa-and-release-engineer",
    role: "qa",
    title: "QA and Release Engineer",
    icon: "bot",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  },
  {
    id: "agent-qa-runner",
    companyId: "company-1",
    name: "QA Runner",
    urlKey: "qa-runner",
    role: "qa",
    title: "Release Tester",
    icon: "bot",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  },
]));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(async () => defaultAgents),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbsState,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastState,
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  const previous = input.value;
  valueSetter?.call(input, value);
  const tracker = (input as HTMLInputElement & { _valueTracker?: { setValue: (nextValue: string) => void } })
    ._valueTracker;
  tracker?.setValue(previous);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setNativeSelectValue(select: HTMLSelectElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  valueSetter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderSettings(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <CompanySettings />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });

  return { root };
}

describe("CompanySettings roadmap path", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCompaniesApi.update.mockClear();
    mockAgentsApi.list.mockClear();
    mockAgentsApi.list.mockResolvedValue(defaultAgents);
    companyState.selectedCompany = { ...defaultCompany };
    companyState.companies = [companyState.selectedCompany];
  });

  afterEach(() => {
    container.remove();
  });

  it("saves trimmed roadmap path values", async () => {
    const { root } = renderSettings(container);

    const roadmapPathInput = container.querySelector(
      'input[placeholder="doc/company-roadmaps/acme-roadmap.md"]',
    ) as HTMLInputElement | null;
    expect(roadmapPathInput).toBeTruthy();

    act(() => {
      if (!roadmapPathInput) return;
      setNativeInputValue(roadmapPathInput, "  doc/company-roadmaps/comandero-roadmap.md  ");
    });

    const saveButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Save changes"));
    expect(saveButton).toBeTruthy();

    act(() => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockCompaniesApi.update).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          roadmapPath: "doc/company-roadmaps/comandero-roadmap.md",
        }),
      );
    });

    act(() => {
      root.unmount();
    });
  });

  it("normalizes blank roadmap path to null on save", async () => {
    companyState.selectedCompany = {
      ...defaultCompany,
      roadmapPath: "doc/company-roadmaps/comandero-roadmap.md",
    };
    companyState.companies = [companyState.selectedCompany];

    const { root } = renderSettings(container);

    const roadmapPathInput = container.querySelector(
      'input[placeholder="doc/company-roadmaps/acme-roadmap.md"]',
    ) as HTMLInputElement | null;
    expect(roadmapPathInput).toBeTruthy();

    act(() => {
      if (!roadmapPathInput) return;
      setNativeInputValue(roadmapPathInput, "   ");
    });

    const saveButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Save changes"));
    expect(saveButton).toBeTruthy();

    act(() => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockCompaniesApi.update).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ roadmapPath: null }),
      );
    });

    act(() => {
      root.unmount();
    });
  });

  it("saves an explicit release-gate QA owner selection", async () => {
    const { root } = renderSettings(container);

    await waitForAssertion(() => {
      expect(mockAgentsApi.list).toHaveBeenCalledWith("company-1");
    });

    const select = container.querySelector(
      '[data-testid="company-settings-release-gate-qa-select"]',
    ) as HTMLSelectElement | null;
    expect(select).toBeTruthy();

    await waitForAssertion(() => {
      expect(select?.querySelector('option[value="agent-qa-runner"]')).toBeTruthy();
    });

    act(() => {
      if (!select) return;
      setNativeSelectValue(select, "agent-qa-runner");
    });

    const saveButton = container.querySelector(
      '[data-testid="company-settings-release-gate-qa-save"]',
    ) as HTMLButtonElement | null;
    expect(saveButton).toBeTruthy();

    act(() => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockCompaniesApi.update).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          releaseGateQaAgentId: "agent-qa-runner",
        }),
      );
    });

    act(() => {
      root.unmount();
    });
  });

  it("saves the company default delivery mode", async () => {
    const { root } = renderSettings(container);

    const select = container.querySelector(
      '[data-testid="company-settings-delivery-mode-select"]',
    ) as HTMLSelectElement | null;
    expect(select).toBeTruthy();

    act(() => {
      if (!select) return;
      setNativeSelectValue(select, "simple");
    });

    const saveButton = container.querySelector(
      '[data-testid="company-settings-delivery-mode-save"]',
    ) as HTMLButtonElement | null;
    expect(saveButton).toBeTruthy();

    act(() => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockCompaniesApi.update).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          defaultRootIssueDeliveryMode: "simple",
        }),
      );
    });

    act(() => {
      root.unmount();
    });
  });

  it("disables release-gate QA owner options that cannot actually resolve the gate", async () => {
    mockAgentsApi.list.mockResolvedValue([
      ...defaultAgents,
      {
        id: "agent-qa-error",
        companyId: "company-1",
        name: "QA Error",
        urlKey: "qa-error",
        role: "qa",
        title: "Release Tester",
        icon: "bot",
        status: "error",
        reportsTo: null,
        capabilities: null,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        pauseReason: null,
        pausedAt: null,
        permissions: { canCreateAgents: false },
        lastHeartbeatAt: null,
        metadata: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const { root } = renderSettings(container);

    await waitForAssertion(() => {
      const select = container.querySelector(
        '[data-testid="company-settings-release-gate-qa-select"]',
      ) as HTMLSelectElement | null;
      const errorOption = select?.querySelector('option[value="agent-qa-error"]') as HTMLOptionElement | null;
      expect(errorOption).toBeTruthy();
      expect(errorOption?.disabled).toBe(true);
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows the release-gate QA blocking reason when no owner resolves", async () => {
    companyState.selectedCompany = {
      ...defaultCompany,
      releaseGateQaResolutionSource: "ambiguous",
      releaseGateQaBlockingReason: "Release-gate QA ownership is ambiguous and must be configured explicitly.",
    };
    companyState.companies = [companyState.selectedCompany];

    const { root } = renderSettings(container);

    await waitForAssertion(() => {
      const blockingReason = container.querySelector(
        '[data-testid="company-settings-release-gate-qa-blocking-reason"]',
      );
      expect(blockingReason?.textContent).toContain("must be configured explicitly");
    });

    const statusBadge = container.querySelector('[data-testid="company-settings-release-gate-qa-section"]');
    expect(statusBadge?.textContent).toContain("Needs explicit owner");
    expect(statusBadge?.textContent).toContain("No release-gate QA owner resolves right now.");

    act(() => {
      root.unmount();
    });
  });
});

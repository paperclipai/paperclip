// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Company } from "@paperclipai/shared";
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
});

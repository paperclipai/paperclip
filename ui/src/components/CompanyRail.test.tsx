// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "@paperclipai/shared";
import { CompanyRail } from "./CompanyRail";
import { TooltipProvider } from "@/components/ui/tooltip";

const setSelectedCompanyId = vi.fn();
const openOnboarding = vi.fn();

const companies: Company[] = [
  {
    id: "company-active",
    name: "Active Co",
    description: null,
    status: "active",
    issuePrefix: "ACT",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    pauseReason: null,
    pausedAt: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  },
  {
    id: "company-pausing",
    name: "Pausing Co",
    description: null,
    status: "pausing",
    issuePrefix: "PAU",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    pauseReason: null,
    pausedAt: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  },
  {
    id: "company-paused",
    name: "Paused Co",
    description: null,
    status: "paused",
    issuePrefix: "PSD",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    pauseReason: null,
    pausedAt: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  },
  {
    id: "company-archived",
    name: "Archived Co",
    description: null,
    status: "archived",
    issuePrefix: "ARC",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    pauseReason: null,
    pausedAt: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  },
];

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies,
    selectedCompanyId: "company-active",
    setSelectedCompanyId,
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openOnboarding,
  }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/ACT/dashboard" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("../hooks/useCompanyOrder", () => ({
  useCompanyOrder: ({ companies: orderedCompanies }: { companies: Company[] }) => ({
    orderedCompanies,
    persistOrder: vi.fn(),
  }),
}));

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: vi.fn(async () => ({ user: { id: "user-1" } })),
  },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForCompany: vi.fn(async () => []),
  },
}));

vi.mock("../api/sidebarBadges", () => ({
  sidebarBadgesApi: {
    get: vi.fn(async () => ({ inbox: 0 })),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CompanyRail", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("dims company icons for pausing and paused companies", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyRail />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const dimmed = container.querySelectorAll('[data-company-dimmed="true"]');
    const notDimmed = container.querySelectorAll('[data-company-dimmed="false"]');

    expect(dimmed.length).toBe(2);
    expect(notDimmed.length).toBe(1);
    expect(container.textContent).not.toContain("Archived Co");
  });
});

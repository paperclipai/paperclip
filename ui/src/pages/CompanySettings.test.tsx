// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettings } from "./CompanySettings";
import { TooltipProvider } from "@/components/ui/tooltip";

const pauseMock = vi.hoisted(() => vi.fn());
const resumeMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
const archiveMock = vi.hoisted(() => vi.fn());
const createInviteMock = vi.hoisted(() => vi.fn());
const getInviteOnboardingMock = vi.hoisted(() => vi.fn());
const uploadLogoMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const invalidateQueriesMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

const selectedCompany = {
  id: "company-1",
  name: "Paperclip",
  description: "AI control plane",
  status: "active" as const,
  pauseReason: null,
  pausedAt: null,
  issuePrefix: "PAP",
  issueCounter: 12,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  requireBoardApprovalForNewAgents: true,
  feedbackDataSharingEnabled: false,
  feedbackDataSharingConsentAt: null,
  feedbackDataSharingConsentByUserId: null,
  feedbackDataSharingTermsVersion: null,
  brandColor: "#123456",
  logoAssetId: null,
  logoUrl: null,
  createdAt: new Date("2026-04-10T00:00:00.000Z"),
  updatedAt: new Date("2026-04-10T00:00:00.000Z"),
};

vi.mock("../api/companies", () => ({
  companiesApi: {
    pause: (companyId: string) => pauseMock(companyId),
    resume: (companyId: string) => resumeMock(companyId),
    update: (companyId: string, data: unknown) => updateMock(companyId, data),
    archive: (companyId: string) => archiveMock(companyId),
  },
}));

vi.mock("../api/access", () => ({
  accessApi: {
    createOpenClawInvitePrompt: (companyId: string) => createInviteMock(companyId),
    getInviteOnboarding: (token: string) => getInviteOnboardingMock(token),
  },
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadCompanyLogo: (companyId: string, file: File) => uploadLogoMock(companyId, file),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [selectedCompany],
    selectedCompany,
    selectedCompanyId: selectedCompany.id,
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: invalidateQueriesMock,
    }),
  };
});

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
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({
        fillStyle: "",
        fillRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
      })),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
      configurable: true,
      value: vi.fn(() => "data:image/png;base64,stub"),
    });
    pauseMock.mockResolvedValue({ ...selectedCompany, status: "paused", pauseReason: "manual", pausedAt: new Date() });
    resumeMock.mockResolvedValue({ ...selectedCompany, status: "active", pauseReason: null, pausedAt: null });
    updateMock.mockResolvedValue(selectedCompany);
    archiveMock.mockResolvedValue(selectedCompany);
    createInviteMock.mockReset();
    getInviteOnboardingMock.mockReset();
    uploadLogoMock.mockReset();
    pushToastMock.mockReset();
    invalidateQueriesMock.mockClear();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders a pause action and calls the company pause API", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <TooltipProvider>
            <QueryClientProvider client={queryClient}>
              <CompanySettings />
            </QueryClientProvider>
          </TooltipProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Company execution");
    expect(container.textContent).toContain("Pause company");

    const pauseButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Pause company"),
    );
    expect(pauseButton).toBeTruthy();

    await act(async () => {
      pauseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(pauseMock).toHaveBeenCalledWith("company-1");
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Company paused",
        tone: "success",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });
});

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { CompanySettings } from "./CompanySettings";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
  archive: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockNavigateTopLevel = vi.hoisted(() => vi.fn());

const ARCHIVING_COMPANY = {
  id: "company-old",
  name: "Old Co",
  description: null,
  status: "active",
  issuePrefix: "OLD",
  brandColor: null,
  logoUrl: null,
  attachmentMaxBytes: null,
  requireBoardApprovalForNewAgents: false,
  interactionResolverGovernance: {},
};

const SIBLING_COMPANY = {
  ...ARCHIVING_COMPANY,
  id: "company-pap",
  name: "Paperclip",
  issuePrefix: "PAP",
};

// Mutable so each test shapes the portfolio the departure resolves against.
const companyState = vi.hoisted(() => ({
  companies: [] as unknown[],
}));

vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/ToastContext", () => ({
  useOptionalToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: companyState.companies,
    selectedCompany: ARCHIVING_COMPANY,
    selectedCompanyId: ARCHIVING_COMPANY.id,
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

vi.mock("@/lib/browserNavigation", () => ({
  navigateTopLevel: mockNavigateTopLevel,
}));

// Both panels below the danger zone own their own queries and are not part
// of what this test covers.
vi.mock("../components/InteractionGovernancePanel", () => ({
  InteractionGovernancePanel: () => null,
  applyGovernanceChange: (governance: unknown) => governance,
}));

vi.mock("./InstanceGeneralSettings", () => ({
  InstanceGeneralSettings: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CLOUD_HEALTH = {
  status: "ok" as const,
  cloud: {
    managed: true as const,
    managedBy: "paperclip-cloud" as const,
    stackSlug: "acme-labs",
    cloudBaseUrl: "https://cloud.example.test",
  },
};

const SELF_HOSTED_HEALTH = { status: "ok" as const, cloud: null };

let observedPath = "";

function LocationProbe() {
  const location = useLocation();
  observedPath = `${location.pathname}${location.search}`;
  return null;
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitForAssertion(assertion: () => void) {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("CompanySettings archive departure", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCompaniesApi.archive.mockResolvedValue({ id: ARCHIVING_COMPANY.id, status: "archived" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    observedPath = "";
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function render(health: unknown) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // CloudAccessGate owns the health fetch in the app; seeding the cache is
    // how useCloudInstance sees a managed instance under test.
    queryClient.setQueryData(queryKeys.health, health);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <MemoryRouter initialEntries={["/OLD/company/settings"]}>
              <LocationProbe />
              <CompanySettings />
            </MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    return root;
  }

  function clickArchive() {
    const button = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === "Archive organization",
    );
    expect(button).toBeDefined();
    flushSync(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("switches to another active company with a toast", async () => {
    companyState.companies = [ARCHIVING_COMPANY, SIBLING_COMPANY];
    const root = render(SELF_HOSTED_HEALTH);
    clickArchive();

    await waitForAssertion(() => {
      expect(mockCompaniesApi.archive).toHaveBeenCalledWith(ARCHIVING_COMPANY.id);
      expect(mockSetSelectedCompanyId).toHaveBeenCalledWith(SIBLING_COMPANY.id);
      expect(observedPath).toBe("/PAP/dashboard");
      expect(mockPushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Old Co is archived",
          body: "Switched to Paperclip.",
        }),
      );
      expect(mockNavigateTopLevel).not.toHaveBeenCalled();
    });
    flushSync(() => root.unmount());
  });

  it("leaves for the Cloud portfolio's manage view when no active company remains", async () => {
    companyState.companies = [ARCHIVING_COMPANY];
    const root = render(CLOUD_HEALTH);
    clickArchive();

    await waitForAssertion(() => {
      expect(mockNavigateTopLevel).toHaveBeenCalledWith(
        "https://cloud.example.test/orgs?manage=1",
      );
      // A full navigation replaces the document: no in-app route change and
      // no company switch.
      expect(observedPath).toBe("/OLD/company/settings");
      expect(mockSetSelectedCompanyId).not.toHaveBeenCalled();
    });
    flushSync(() => root.unmount());
  });

  it("falls back to the companies list on self-hosted with nothing active", async () => {
    companyState.companies = [ARCHIVING_COMPANY];
    const root = render(SELF_HOSTED_HEALTH);
    clickArchive();

    await waitForAssertion(() => {
      expect(observedPath).toBe("/OLD/companies");
      expect(mockPushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Old Co is archived",
          body: "You can unarchive it from this list.",
        }),
      );
      expect(mockNavigateTopLevel).not.toHaveBeenCalled();
    });
    flushSync(() => root.unmount());
  });
});

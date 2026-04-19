// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyRail } from "./CompanyRail";

const MISSION_CONTROL_URL = "https://robert-dawson-mini-s-1.tail3dddf6.ts.net/";

const companyState = vi.hoisted(() => ({
  companies: [
    {
      id: "company-1",
      name: "Paperclip",
      description: null,
      status: "active",
      pauseReason: null,
      pausedAt: null,
      issuePrefix: "PAP",
      issueCounter: 12,
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
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ],
  selectedCompanyId: "company-1",
  setSelectedCompanyId: vi.fn(),
}));

const dialogState = vi.hoisted(() => ({
  openOnboarding: vi.fn(),
}));

const sidebarState = vi.hoisted(() => ({
  isMobile: false,
  sidebarOpen: true,
  sidebarSide: "left",
  toggleSidebar: vi.fn(),
  toggleSidebarSide: vi.fn(),
}));

const routerState = vi.hoisted(() => ({
  location: { pathname: "/PAP/dashboard" },
  navigate: vi.fn(),
}));

const heartbeatsApiMock = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const sidebarBadgesApiMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => routerState.location,
  useNavigate: () => routerState.navigate,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: heartbeatsApiMock,
}));

vi.mock("../api/sidebarBadges", () => ({
  sidebarBadgesApi: sidebarBadgesApiMock,
}));

vi.mock("./CompanyPatternIcon", () => ({
  CompanyPatternIcon: ({ companyName }: { companyName: string }) => (
    <div data-testid="company-pattern-icon">{companyName.charAt(0)}</div>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderCompanyRail() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <CompanyRail />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  companyState.setSelectedCompanyId.mockReset();
  dialogState.openOnboarding.mockReset();
  sidebarState.toggleSidebar.mockReset();
  sidebarState.toggleSidebarSide.mockReset();
  routerState.navigate.mockReset();
  heartbeatsApiMock.liveRunsForCompany.mockReset();
  sidebarBadgesApiMock.get.mockReset();
  heartbeatsApiMock.liveRunsForCompany.mockResolvedValue([]);
  sidebarBadgesApiMock.get.mockResolvedValue({
    inbox: 0,
    blockers: 0,
    approvals: 0,
    failedRuns: 0,
    joinRequests: 0,
    taskDates: {
      today: 0,
      tomorrow: 0,
      next7Days: 0,
    },
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("CompanyRail Mission Control shortcut", () => {
  it("exposes an external Mission Control link from the rail header", async () => {
    await renderCompanyRail();

    const link = container?.querySelector(
      'a[aria-label="Open Mission Control"]',
    ) as HTMLAnchorElement | null;

    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(MISSION_CONTROL_URL);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(link?.getAttribute("title")).toBe("Open Mission Control");
    expect(link?.querySelector('[data-testid="mission-control-external-badge"]')).not.toBeNull();
  });
});

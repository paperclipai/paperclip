// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyRail } from "./CompanyRail";
import { ApiError } from "../api/client";

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

const agentsApiMock = vi.hoisted(() => ({
  instancePauseState: vi.fn(),
  pauseAllInstanceAgents: vi.fn(),
  resumeTokenPausedInstanceAgents: vi.fn(),
}));

const toastActionsMock = vi.hoisted(() => ({
  pushToast: vi.fn(),
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

vi.mock("../api/agents", () => ({
  agentsApi: agentsApiMock,
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => toastActionsMock,
}));

vi.mock("./CompanyPatternIcon", () => ({
  CompanyPatternIcon: ({ companyName }: { companyName: string }) => (
    <div data-testid="company-pattern-icon">{companyName.charAt(0)}</div>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onSelect?: (event: { preventDefault: () => void }) => void;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect?.({ preventDefault: vi.fn() })}
    >
      {children}
    </button>
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

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  agentsApiMock.instancePauseState.mockReset();
  agentsApiMock.pauseAllInstanceAgents.mockReset();
  agentsApiMock.resumeTokenPausedInstanceAgents.mockReset();
  toastActionsMock.pushToast.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
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
  agentsApiMock.instancePauseState.mockResolvedValue({
    counts: {
      totalAgents: 3,
      runnableAgents: 2,
      tokenPausedAgents: 1,
      manualPausedAgents: 0,
      budgetPausedAgents: 0,
      systemPausedAgents: 0,
      otherPausedAgents: 0,
      pendingApprovalAgents: 0,
      terminatedAgents: 0,
      scopedCompanyCount: 1,
      activeRunCount: 1,
    },
    scopedCompanyIds: ["company-1"],
  });
  agentsApiMock.pauseAllInstanceAgents.mockResolvedValue({
    counts: {
      totalAgents: 3,
      runnableAgents: 0,
      tokenPausedAgents: 3,
      manualPausedAgents: 0,
      budgetPausedAgents: 0,
      systemPausedAgents: 0,
      otherPausedAgents: 0,
      pendingApprovalAgents: 0,
      terminatedAgents: 0,
      scopedCompanyCount: 1,
      activeRunCount: 0,
    },
    scopedCompanyIds: ["company-1"],
    affectedCompanyIds: ["company-1"],
    pausedAgents: 2,
    resumedAgents: 0,
    cancelledRuns: 1,
  });
  agentsApiMock.resumeTokenPausedInstanceAgents.mockResolvedValue({
    counts: {
      totalAgents: 3,
      runnableAgents: 3,
      tokenPausedAgents: 0,
      manualPausedAgents: 0,
      budgetPausedAgents: 0,
      systemPausedAgents: 0,
      otherPausedAgents: 0,
      pendingApprovalAgents: 0,
      terminatedAgents: 0,
      scopedCompanyCount: 1,
      activeRunCount: 0,
    },
    scopedCompanyIds: ["company-1"],
    affectedCompanyIds: ["company-1"],
    pausedAgents: 0,
    resumedAgents: 1,
    cancelledRuns: 0,
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
  vi.restoreAllMocks();
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

describe("CompanyRail agent token switch", () => {
  it("renders the global token switch after loading instance pause state", async () => {
    await renderCompanyRail();

    await waitForAssertion(() => {
      expect(agentsApiMock.instancePauseState).toHaveBeenCalled();
      expect(container?.querySelector('button[aria-label="Agent token switch"]')).not.toBeNull();
    });
  });

  it("confirms and pauses all runnable agents", async () => {
    await renderCompanyRail();

    await waitForAssertion(() => {
      expect(container?.textContent).toContain("Pause all agents");
      const button = Array.from(container!.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes("Pause all agents"),
      );
      expect(button?.disabled).toBe(false);
    });

    const pauseButton = Array.from(container!.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Pause all agents"),
    );
    expect(pauseButton).not.toBeUndefined();

    await act(async () => {
      pauseButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Pause 2 runnable agents"));
      expect(agentsApiMock.pauseAllInstanceAgents).toHaveBeenCalled();
      expect(toastActionsMock.pushToast).toHaveBeenCalledWith(expect.objectContaining({
        title: "Agents paused",
      }));
    });
  });

  it("confirms and resumes only token-paused agents", async () => {
    await renderCompanyRail();

    await waitForAssertion(() => {
      expect(container?.textContent).toContain("Resume token-paused agents");
      const button = Array.from(container!.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes("Resume token-paused agents"),
      );
      expect(button?.disabled).toBe(false);
    });

    const resumeButton = Array.from(container!.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Resume token-paused agents"),
    );
    expect(resumeButton).not.toBeUndefined();

    await act(async () => {
      resumeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Manual and budget-paused agents will stay paused"));
      expect(agentsApiMock.resumeTokenPausedInstanceAgents).toHaveBeenCalled();
      expect(toastActionsMock.pushToast).toHaveBeenCalledWith(expect.objectContaining({
        title: "Agents resumed",
      }));
    });
  });

  it("hides the token switch for non-admin board sessions", async () => {
    agentsApiMock.instancePauseState.mockRejectedValue(new ApiError("Forbidden", 403, null));

    await renderCompanyRail();

    await waitForAssertion(() => {
      expect(agentsApiMock.instancePauseState).toHaveBeenCalled();
      expect(container?.querySelector('button[aria-label="Agent token switch"]')).toBeNull();
    });
  });
});

// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostByUserTable } from "@/components/CostByUserTable";
import { GrokBotSetupContent } from "@/components/new-agent/GrokBotSetupContent";
import { RoutineTable } from "@/components/RoutineTable";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { WorkspaceServiceControlBar } from "@/components/WorkspaceServiceControlBar";
import { Agents } from "./Agents";
import { Approvals } from "./Approvals";
import { AuditHub } from "./audit/AuditHub";
import { CompanyAccess } from "./CompanyAccess";
import { Dashboard } from "./Dashboard";
import { ProfileSettings } from "./ProfileSettings";

const mockState = vi.hoisted(() => ({
  isMobile: true,
  pathname: "/approvals/pending",
  searchParams: new URLSearchParams(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockApprovalsList = vi.hoisted(() => vi.fn());
const mockAgentsList = vi.hoisted(() => vi.fn());
const mockMembersList = vi.hoisted(() => vi.fn());
const mockDashboardSummary = vi.hoisted(() => vi.fn());
const mockActivityList = vi.hoisted(() => vi.fn());
const mockIssuesListCompact = vi.hoisted(() => vi.fn());
const mockAuthSession = vi.hoisted(() => vi.fn());

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: mockState.isMobile }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }],
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
  useToastActions: () => ({ pushToast: vi.fn() }),
  useOptionalToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({ openNewAgent: vi.fn(), openOnboarding: vi.fn(), openNewIssue: vi.fn() }),
}));

vi.mock("@/context/DesignSandboxContext", () => ({
  useDesignSandbox: () => false,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: mockState.pathname, search: "" }),
  useSearchParams: () => [
    mockState.searchParams,
    (updater: URLSearchParams | ((prev: URLSearchParams) => URLSearchParams)) => {
      mockState.searchParams = typeof updater === "function" ? updater(mockState.searchParams) : new URLSearchParams(updater);
    },
  ],
}));

vi.mock("@/api/approvals", () => ({
  approvalsApi: { list: (...args: unknown[]) => mockApprovalsList(...args), approve: vi.fn(), reject: vi.fn() },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (...args: unknown[]) => mockAgentsList(...args),
    org: vi.fn().mockResolvedValue([]),
    resume: vi.fn(),
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: {
    listMembers: (...args: unknown[]) => mockMembersList(...args),
    listJoinRequests: vi.fn().mockResolvedValue([]),
    listUserDirectory: vi.fn().mockResolvedValue({ users: [] }),
  },
}));

vi.mock("@/api/cloud", () => ({
  cloudApi: { listStacks: vi.fn().mockResolvedValue({ stacks: [] }) },
}));

vi.mock("@/api/dashboard", () => ({
  dashboardApi: { summary: (...args: unknown[]) => mockDashboardSummary(...args) },
}));

vi.mock("@/api/activity", () => ({
  activityApi: { list: (...args: unknown[]) => mockActivityList(...args) },
}));

vi.mock("@/api/issues", () => ({
  issuesApi: {
    listCompact: (...args: unknown[]) => mockIssuesListCompact(...args),
    summaries: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/api/companies-query", () => ({
  useAccountIdentity: () => ({ userId: "user-1", settled: true }),
}));

vi.mock("@/api/auth", () => ({
  authApi: { getSession: (...args: unknown[]) => mockAuthSession(...args), updateProfile: vi.fn() },
}));

vi.mock("@/api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { get: vi.fn().mockResolvedValue({ experimental: {} }) },
}));

vi.mock("@/api/builtInAgents", () => ({
  builtInAgentsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/api/environments", () => ({
  environmentsApi: { list: vi.fn().mockResolvedValue([]), capabilities: vi.fn().mockResolvedValue({}) },
}));

vi.mock("@/api/ai-connections", () => ({
  aiConnectionsApi: { list: vi.fn().mockResolvedValue({ connections: [], pools: [] }) },
}));

vi.mock("@/hooks/useCloudHarnessPolicy", () => ({
  useCloudHarnessPolicy: () => ({}),
}));

vi.mock("@/api/inbox-agent-policy", () => ({
  inboxAgentPolicyApi: {
    getMine: vi.fn().mockResolvedValue({ mode: "disabled", allowedAgentIds: [] }),
    updateMine: vi.fn(),
  },
}));

vi.mock("@/lib/company-projects-query", () => ({
  companyProjectsQuery: () => ({ queryKey: ["projects", "company-1"], queryFn: async () => [] }),
}));

vi.mock("@/hooks/useHiddenSettings", () => ({
  useHiddenSettings: () => ({ hidden: new Set<string>() }),
}));

vi.mock("@/hooks/useCloudInstance", () => ({
  useCloudInstance: () => null,
}));

vi.mock("@/hooks/useAgentChatEnabled", () => ({
  useAgentChatEnabled: () => ({ enabled: true }),
}));

vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => ({ enabled: true }),
}));

vi.mock("@/hooks/useAgentlessOnboardingAutoOpen", () => ({
  useAgentlessOnboardingAutoOpen: () => {},
}));

vi.mock("@/hooks/useSharedPolling", () => ({
  useSharedPollingQuery: () => ({ enabled: false, refetchInterval: false }),
  usePublishSharedQueryData: () => {},
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ slots: [], isLoading: false }),
  PluginSlotOutlet: () => null,
}));

vi.mock("@/components/ActiveAgentsPanel", () => ({
  ActiveAgentsPanel: () => null,
}));

vi.mock("@/components/SmokeLabDashboardCard", () => ({
  SmokeLabDashboardCard: () => null,
}));

vi.mock("@/components/ProductAnalyticsSetting", () => ({
  ProductAnalyticsSetting: () => null,
}));

vi.mock("@/components/primary-agent/PrimaryAgentPresentation", () => ({
  PrimaryAgentIndicator: () => null,
}));

vi.mock("@/components/AgentChatPin", () => ({
  AgentChatPin: () => null,
  useAgentChatPins: () => ({ isPinned: () => false, toggle: vi.fn() }),
}));

vi.mock("./audit/AuditFeed", () => ({
  AuditFeed: () => <div data-testid="audit-feed" />,
}));

vi.mock("./audit/AuditRuns", () => ({
  AuditRuns: () => <div data-testid="audit-runs" />,
}));

vi.mock("./audit/AgentCommentary", () => ({
  AgentCommentary: () => <div data-testid="agent-commentary" />,
}));

vi.mock("./audit/RoutineAuditActivity", () => ({
  RoutineAuditActivity: () => <div data-testid="routine-audit" />,
}));

vi.mock("./Costs", () => ({
  Costs: () => <div data-testid="costs-page" />,
}));

vi.mock("./Timeline", () => ({
  Timeline: () => <div data-testid="timeline-page" />,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("mobile collections, tables, popovers, and settings polish", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockState.isMobile = true;
    mockState.pathname = "/approvals/pending";
    mockState.searchParams = new URLSearchParams();
    mockNavigate.mockReset();
    mockApprovalsList.mockResolvedValue([]);
    mockAgentsList.mockResolvedValue([]);
    mockMembersList.mockResolvedValue({
      members: [
        {
          id: "m1",
          companyId: "company-1",
          principalType: "user",
          principalId: "u1",
          status: "active",
          membershipRole: "owner",
          user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com", image: null },
        },
      ],
      access: { currentUserRole: "owner", canManageMembers: true, canApproveJoinRequests: false },
    });
    mockDashboardSummary.mockResolvedValue({
      agents: { active: 2, running: 1, paused: 0, error: 0 },
      tasks: { open: 5, inProgress: 2, blocked: 1, done: 10 },
      costs: { monthSpendCents: 1250, monthBudgetCents: 5000, monthUtilizationPercent: 25 },
      pendingApprovals: 1,
      budgets: { activeIncidents: 0, pausedAgents: 0, pausedProjects: 0, pendingApprovals: 0 },
      runActivity: [],
    });
    mockActivityList.mockResolvedValue([]);
    mockIssuesListCompact.mockResolvedValue([]);
    mockAuthSession.mockResolvedValue({
      session: { userId: "u1" },
      user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com", image: null },
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
    queryClient.clear();
  });

  function renderWithClient(node: ReactNode) {
    root = createRoot(container);
    act(() => {
      root!.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
  }

  it("wires mobile PageTabBar section selection in AuditHub", async () => {
    renderWithClient(<AuditHub section="activity" />);
    await vi.waitFor(() => {
      expect(container.querySelector('select[aria-label="Page section"]')).not.toBeNull();
    });

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Page section"]')!;
    expect(select.value).toBe("activity");

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, "costs");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith("/activity/costs");
  });

  it("wires mobile PageTabBar status filter in Approvals", async () => {
    renderWithClient(<Approvals />);
    await vi.waitFor(() => {
      expect(container.querySelector('select[aria-label="Page section"]')).not.toBeNull();
    });

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Page section"]')!;
    expect(select.value).toBe("pending");

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, "all");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith("/approvals/all");
  });

  it("wraps RoutineTable, CostByUserTable, and CompanyAccess members table in constrained horizontal scrollers", async () => {
    renderWithClient(
      <>
        <RoutineTable columns={["project", "assignee"]} label="Routines">
          <div role="row">Row</div>
        </RoutineTable>
        <CostByUserTable
          report={{
            activeUserCount: 1,
            rows: [
              {
                userId: "u1",
                userName: "Ada",
                userImage: null,
                runCount: 4,
                inputTokens: 1000,
                cachedInputTokens: 200,
                outputTokens: 300,
                costCents: 150,
                costCentsExact: "150",
                eventCount: 4,
                estimatedEventCount: 0,
                unpricedEventCount: 0,
              },
            ],
          }}
        />
        <CompanyAccess />
      </>,
    );
    await vi.waitFor(() => {
      const membersTable = Array.from(container.querySelectorAll("table")).find((el) =>
        el.className.includes("min-w-(--sz-44rem)"),
      );
      expect(membersTable).toBeDefined();
    });

    const routineTable = container.querySelector(".routine-table");
    expect(routineTable?.parentElement?.className).toContain("overflow-x-auto");
    expect(routineTable?.parentElement?.className).toContain("max-w-full");

    const userCostTable = container.querySelector('table[aria-label="Costs by user"]');
    expect(userCostTable?.parentElement?.className).toContain("overflow-x-auto");
    expect(userCostTable?.parentElement?.className).toContain("max-w-full");
    expect(userCostTable?.closest('[data-slot="card"]')?.className).toContain("min-w-0");

    const membersTable = Array.from(container.querySelectorAll("table")).find((el) =>
      el.className.includes("min-w-(--sz-44rem)"),
    );
    expect(membersTable?.parentElement?.className).toContain("overflow-x-auto");
    expect(membersTable?.parentElement?.className).toContain("max-w-full");
    expect(membersTable?.closest('[data-slot="tabs-content"]')?.className).toContain("min-w-0");
  });

  it("stacks Dashboard charts into 1 column on mobile and aligns summary cards to uniform height", async () => {
    renderWithClient(<Dashboard />);
    await vi.waitFor(() => {
      const metricLabel = Array.from(container.querySelectorAll("p")).find((el) => el.textContent === "Agents Enabled");
      expect(metricLabel).toBeDefined();
    });

    const metricLabel = Array.from(container.querySelectorAll("p")).find((el) => el.textContent === "Agents Enabled");
    const metricGrid = metricLabel?.closest(".grid");
    expect(metricGrid?.className).toContain("auto-rows-fr");
    expect(metricGrid?.className).toContain("items-stretch");

    const chartHeading = Array.from(container.querySelectorAll("*")).find((el) => el.textContent === "Run Activity");
    const chartGrid = chartHeading?.closest(".grid");
    expect(chartGrid?.className).toContain("grid-cols-1");
    expect(chartGrid?.className).toContain("sm:grid-cols-2");
  });

  it("exposes the inline Chat button on touch devices in Agents list view", async () => {
    mockState.pathname = "/agents/all";
    mockAgentsList.mockResolvedValue([
      {
        id: "agent-1",
        companyId: "company-1",
        name: "Codie",
        urlKey: "codie",
        role: "engineer",
        title: "Staff Engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
      },
    ]);

    renderWithClient(<Agents />);
    await vi.waitFor(() => {
      expect(container.querySelector('button[aria-label="Chat with Codie"]')).not.toBeNull();
    });

    const chatButton = container.querySelector<HTMLButtonElement>('button[aria-label="Chat with Codie"]');
    expect(chatButton).not.toBeNull();
    expect(chatButton!.className).toContain("pointer-coarse:opacity-100");
  });

  it("uses responsive 2-column step grid in GrokBotSetupContent and constrains ProfileSettings", async () => {
    renderWithClient(
      <>
        <Dialog open>
          <DialogContent>
            <GrokBotSetupContent
              step={0}
              companyName="Paperclip"
              details={{ name: "Grok", botName: "Grok", role: "general" }}
              created={false}
              managers={[]}
              pairing={null}
              webhookUrl=""
              webhookKey=""
              onDetails={vi.fn()}
              onCredentials={vi.fn()}
              onBack={vi.fn()}
              onExit={vi.fn()}
              onNext={vi.fn()}
              onRetry={vi.fn()}
            />
          </DialogContent>
        </Dialog>
        <ProfileSettings />
      </>,
    );
    await vi.waitFor(() => {
      expect(container.querySelector('input[type="file"][accept="image/*"]')).not.toBeNull();
    });

    const stepsList = document.body.querySelector('ol[aria-label="Grok Bot setup"]');
    expect(stepsList?.className).toContain("grid-cols-2");
    expect(stepsList?.className).toContain("sm:grid-cols-4");

    const avatarInput = container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"]');
    expect(avatarInput?.closest("label")?.className).toContain("inline-block");
    expect(avatarInput?.closest("label")?.className).toContain("w-fit");
  });

  it("caps WorkspaceServiceControlBar popover width to the viewport token", async () => {
    renderWithClient(
      <WorkspaceServiceControlBar
        defaultServicesOpen
        services={[
          {
            key: "web",
            name: "web",
            state: "running",
            healthStatus: "healthy",
            url: "http://localhost:3100",
            command: "pnpm dev",
            managedServiceId: "svc-1",
            errorMessage: null,
          } as never,
          {
            key: "api",
            name: "api",
            state: "running",
            healthStatus: "healthy",
            url: "http://localhost:3101",
            command: "pnpm dev:server",
            managedServiceId: "svc-2",
            errorMessage: null,
          } as never,
        ]}
        onAction={vi.fn()}
      />,
    );
    await flush();

    const popover = document.body.querySelector('[data-slot="popover-content"]');
    expect(popover?.className).toContain("max-w-(--sz-calc-4)");
  });
});

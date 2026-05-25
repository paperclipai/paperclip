// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDetail as AgentDetailRecord } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDetail } from "./AgentDetail";

const mockParams = vi.hoisted(() => ({
  companyPrefix: "PAP" as string | undefined,
  agentId: "alpha" as string | undefined,
  tab: "dashboard" as string | undefined,
  runId: undefined as string | undefined,
}));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockClosePanel = vi.hoisted(() => vi.fn());
const mockOpenNewIssue = vi.hoisted(() => vi.fn());
const mockPluginSlotsResult = vi.hoisted(() => ({
  slots: [] as Array<Record<string, unknown>>,
  isLoading: false,
  errorMessage: null as string | null,
}));

const mockAgentsApi = vi.hoisted(() => ({
  get: vi.fn(),
  runtimeState: vi.fn(),
  list: vi.fn(),
  invoke: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  approve: vi.fn(),
  terminate: vi.fn(),
  update: vi.fn(),
  resetSession: vi.fn(),
  updatePermissions: vi.fn(),
  listConfigRevisions: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  adapterModels: vi.fn(),
  instructionsBundle: vi.fn(),
  instructionsFile: vi.fn(),
  updateInstructionsBundle: vi.fn(),
  saveInstructionsFile: vi.fn(),
  deleteInstructionsFile: vi.fn(),
  skills: vi.fn(),
  syncSkills: vi.fn(),
  wakeup: vi.fn(),
  loginWithClaude: vi.fn(),
  listKeys: vi.fn(),
  createKey: vi.fn(),
  revokeKey: vi.fn(),
}));
const mockBudgetsApi = vi.hoisted(() => ({
  overview: vi.fn(),
  upsertPolicy: vi.fn(),
}));
const mockHeartbeatsApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  workspaceOperations: vi.fn(),
  workspaceOperationLog: vi.fn(),
  events: vi.fn(),
  log: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockActivityApi = vi.hoisted(() => ({ issuesForRun: vi.fn() }));
const mockCompanySkillsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAssetsApi = vi.hoisted(() => ({ uploadImage: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getGeneral: vi.fn() }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children?: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => (
    <div data-testid="navigate" data-to={to} data-replace={String(Boolean(replace))} />
  ),
  useBeforeUnload: () => undefined,
  useNavigate: () => mockNavigate,
  useParams: () => mockParams,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" }],
    selectedCompanyId: "company-1",
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));
vi.mock("../context/PanelContext", () => ({ usePanel: () => ({ closePanel: mockClosePanel }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: mockOpenNewIssue }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/budgets", () => ({ budgetsApi: mockBudgetsApi }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/activity", () => ({ activityApi: mockActivityApi }));
vi.mock("../api/companySkills", () => ({ companySkillsApi: mockCompanySkillsApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../adapters", () => ({
  buildTranscript: vi.fn(() => []),
  getUIAdapter: vi.fn(() => null),
  onAdapterChange: vi.fn(),
}));
vi.mock("@/adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => vi.fn(() => null),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: ({
    slot,
    context,
  }: {
    slot: { displayName: string };
    context: { companyId?: string | null; entityId?: string | null; entityType?: string | null };
  }) => (
    <div
      data-testid="plugin-slot-mount"
      data-company-id={context.companyId ?? ""}
      data-entity-id={context.entityId ?? ""}
      data-entity-type={context.entityType ?? ""}
    >
      {slot.displayName}
    </div>
  ),
  usePluginSlots: () => mockPluginSlotsResult,
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({
    items,
    value,
  }: {
    items: Array<{ value: string; label: string }>;
    value: string;
  }) => (
    <div data-testid="page-tab-bar" data-value={value}>
      {items.map((item) => (
        <button key={item.value} data-value={item.value}>{item.label}</button>
      ))}
    </div>
  ),
}));
vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div data-testid="skeleton" /> }));
vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
  AgentIconPicker: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../components/AgentActionButtons", () => ({
  RunButton: ({ label }: { label: string }) => <button>{label}</button>,
  PauseResumeButton: () => <button>Pause</button>,
}));
vi.mock("../components/StatusBadge", () => ({ StatusBadge: ({ status }: { status: string }) => <span>{status}</span> }));
vi.mock("../components/AgentConfigForm", () => ({
  AgentConfigForm: () => <div data-testid="agent-config-form" />,
}));
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => <textarea aria-label="Markdown editor" />,
}));
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/transcript/RunTranscriptView", () => ({
  RunTranscriptView: () => <div data-testid="run-transcript-view" />,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeAgent(overrides: Partial<AgentDetailRecord> = {}): AgentDetailRecord {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
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
    chainOfCommand: [],
    access: {
      canAssignTasks: false,
      taskAssignSource: "none",
      membership: null,
      grants: [],
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function detailSlot(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-panel",
    type: "detailTab",
    displayName: "Knowledge",
    exportName: "AgentPanel",
    entityTypes: ["agent"],
    pluginId: "plugin-1",
    pluginKey: "paperclip.wiki",
    pluginDisplayName: "Wiki",
    pluginVersion: "0.1.0",
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderAgentDetail(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentDetail />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  await flushReact();
  return { root, queryClient };
}

describe("AgentDetail plugin detail tabs", () => {
  let root: Root | null = null;
  let queryClient: QueryClient | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockParams.companyPrefix = "PAP";
    mockParams.agentId = "alpha";
    mockParams.tab = "dashboard";
    mockParams.runId = undefined;
    mockPluginSlotsResult.slots = [];
    mockPluginSlotsResult.isLoading = false;
    mockPluginSlotsResult.errorMessage = null;
    mockAgentsApi.get.mockResolvedValue(makeAgent());
    mockAgentsApi.runtimeState.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockBudgetsApi.overview.mockResolvedValue({ policies: [] });
    mockHeartbeatsApi.list.mockResolvedValue([]);
    mockIssuesApi.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient?.clear();
    root = null;
    queryClient = null;
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders and mounts the active agent plugin detail tab", async () => {
    mockParams.tab = "plugin:paperclip.wiki:agent-panel";
    mockPluginSlotsResult.slots = [detailSlot()];

    ({ root, queryClient } = await renderAgentDetail(container));

    const tabBar = container.querySelector('[data-testid="page-tab-bar"]');
    expect(tabBar?.getAttribute("data-value")).toBe("plugin:paperclip.wiki:agent-panel");
    expect(tabBar?.textContent).toContain("Knowledge");
    const mount = container.querySelector('[data-testid="plugin-slot-mount"]');
    expect(mount?.textContent).toBe("Knowledge");
    expect(mount?.getAttribute("data-company-id")).toBe("company-1");
    expect(mount?.getAttribute("data-entity-id")).toBe("agent-1");
    expect(mount?.getAttribute("data-entity-type")).toBe("agent");
    expect(mockSetBreadcrumbs).toHaveBeenLastCalledWith([
      { label: "Agents", href: "/agents" },
      { label: "Alpha", href: "/agents/alpha/dashboard" },
      { label: "Knowledge" },
    ]);
  });

  it("redirects a stale plugin detail route once slots finish loading", async () => {
    mockParams.tab = "plugin:paperclip.wiki:missing";
    mockPluginSlotsResult.slots = [];
    mockPluginSlotsResult.isLoading = false;

    ({ root, queryClient } = await renderAgentDetail(container));

    const redirect = container.querySelector('[data-testid="navigate"]');
    expect(redirect?.getAttribute("data-to")).toBe("/agents/alpha/dashboard");
    expect(redirect?.getAttribute("data-replace")).toBe("true");
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')).toBeNull();
  });

  it("waits for plugin detail slots before redirecting an unmatched plugin route", async () => {
    mockParams.tab = "plugin:paperclip.wiki:missing";
    mockPluginSlotsResult.slots = [];
    mockPluginSlotsResult.isLoading = true;

    ({ root, queryClient } = await renderAgentDetail(container));

    expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')).toBeNull();
  });
});

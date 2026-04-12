// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDetail } from "./AgentDetail";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const getAgentMock = vi.fn();
const budgetsOverviewMock = vi.fn();
const heartbeatsListMock = vi.fn();
const issuesListMock = vi.fn();
const listKeysMock = vi.fn();
const configRevisionsMock = vi.fn();
const setBreadcrumbsMock = vi.fn();
const closePanelMock = vi.fn();
const openNewIssueMock = vi.fn();
const setSelectedCompanyIdMock = vi.fn();
const navigateMock = vi.fn();
const confirmMock = vi.fn(() => false);

vi.mock("../api/agents", () => ({
  agentsApi: {
    get: () => getAgentMock(),
    invoke: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    terminate: vi.fn(),
    update: vi.fn(),
    resetSession: vi.fn(),
    updatePermissions: vi.fn(),
    adapterModels: vi.fn().mockResolvedValue([]),
    instructionsBundle: vi.fn().mockResolvedValue({
      mode: "external",
      rootPath: "/agent/prompts",
      managedRootPath: "",
      entryFile: "AGENTS.md",
      files: [
        { path: "AGENTS.md", size: 42, language: "markdown", isEntryFile: true, deprecated: false },
        { path: "legacy.md", size: 12, language: "markdown", isEntryFile: false, deprecated: true },
        { path: "notes.txt", size: 7, language: "text", isEntryFile: false, deprecated: false },
      ],
      warnings: [],
    }),
    instructionsFile: vi.fn().mockResolvedValue({ path: "AGENTS.md", content: "", language: "markdown" }),
    listConfigRevisions: () => configRevisionsMock(),
    listKeys: () => listKeysMock(),
    createKey: vi.fn(),
    revokeKey: vi.fn(),
    saveInstructionsFile: vi.fn(),
    deleteInstructionsFile: vi.fn(),
    updateInstructionsBundle: vi.fn(),
  },
}));

vi.mock("../api/budgets", () => ({
  budgetsApi: {
    overview: () => budgetsOverviewMock(),
    upsertPolicy: vi.fn(),
  },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { list: () => heartbeatsListMock() },
}));

vi.mock("../api/issues", () => ({
  issuesApi: { list: () => issuesListMock() },
}));

vi.mock("../api/companySkills", () => ({
  companySkillsApi: { list: vi.fn() },
}));

vi.mock("../api/assets", () => ({
  assetsApi: { upload: vi.fn() },
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: { get: vi.fn(), update: vi.fn() },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [],
    selectedCompanyId: "company-1",
    setSelectedCompanyId: setSelectedCompanyIdMock,
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({ closePanel: closePanelMock }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewIssue: openNewIssueMock }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    agents: {
      detail: (agentId: string) => ["agents", "detail", agentId],
      runtimeState: (agentId: string) => ["agents", "runtime-state", agentId],
      taskSessions: (agentId: string) => ["agents", "task-sessions", agentId],
      list: (companyId: string) => ["agents", "list", companyId],
      configRevisions: (agentId: string) => ["agents", "config-revisions", agentId],
      keys: (agentId: string) => ["agents", "keys", agentId],
      adapterModels: (companyId: string, adapterType: string) => ["agents", "adapter-models", companyId, adapterType],
      instructionsBundle: (agentId: string) => ["agents", "instructions-bundle", agentId],
      instructionsFile: (agentId: string, filePath: string) => ["agents", "instructions-file", agentId, filePath],
    },
    heartbeats: (companyId: string, agentId?: string) => ["heartbeats", companyId, agentId],
    issues: {
      list: (companyId: string) => ["issues", "list", companyId],
    },
    budgets: {
      overview: (companyId: string) => ["budgets", "overview", companyId],
    },
    dashboard: (companyId: string) => ["dashboard", companyId],
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className }: { children: unknown; to: string; className?: string }) => (
    <a href={to} className={className}>{children as never}</a>
  ),
  Navigate: () => <div>navigate</div>,
  useParams: () => ({ agentId: "agent-one", tab: "instructions", runId: undefined, companyPrefix: undefined }),
  useNavigate: () => navigateMock,
  useBeforeUnload: vi.fn(),
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ label: string }> }) => (
    <div>{items.map((item) => item.label).join(", ")}</div>
  ),
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => <div>markdown-editor</div>,
}));

vi.mock("../components/AgentConfigForm", () => ({
  AgentConfigForm: () => <div>agent-config-form</div>,
}));

vi.mock("../components/AgentActionButtons", () => ({
  RunButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
  PauseResumeButton: () => <button type="button">pause-resume</button>,
}));

vi.mock("../components/ActivityCharts", () => ({
  ChartCard: ({ title, subtitle, children }: { title: string; subtitle: string; children: unknown }) => <div>{title} {subtitle}{children as never}</div>,
  RunActivityChart: () => <div>run-activity-chart</div>,
  PriorityChart: () => <div>priority-chart</div>,
  IssueStatusChart: () => <div>issue-status-chart</div>,
  SuccessRateChart: () => <div>success-rate-chart</div>,
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIconPicker: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  AgentIcon: () => <div>agent-icon</div>,
}));

vi.mock("../components/BudgetPolicyCard", () => ({
  BudgetPolicyCard: () => <div>budget-policy-card</div>,
}));

vi.mock("../components/PackageFileTree", () => ({
  PackageFileTree: () => <div>package-file-tree</div>,
  buildFileTree: vi.fn(),
}));

vi.mock("../components/transcript/RunTranscriptView", () => ({
  RunTranscriptView: () => <div>run-transcript-view</div>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  PopoverTrigger: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  PopoverContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

vi.mock("../adapters", () => ({
  getUIAdapter: vi.fn(),
  buildTranscript: vi.fn(),
  onAdapterChange: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentDetail", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getAgentMock.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      urlKey: "agent-one",
      name: "Budget Bot",
      role: "engineer",
      title: null,
      status: "pending_approval",
      reportsTo: null,
      capabilities: null,
      adapterType: "claude_local",
      adapterConfig: {},
      contextMode: "thin",
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
      icon: "code",
      metadata: null,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      pauseReason: null,
      pausedAt: null,
      permissions: null,
    });
    budgetsOverviewMock.mockResolvedValue({ policies: [] });
    heartbeatsListMock.mockResolvedValue([
      {
        id: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        invocationSource: "assignment",
        triggerDetail: null,
        status: "queued",
        error: null,
        wakeupRequestId: null,
        exitCode: null,
        signal: null,
        usageJson: null,
        resultJson: null,
        sessionIdBefore: null,
        sessionIdAfter: null,
        logStore: null,
        logRef: null,
        logBytes: null,
        logSha256: null,
        logCompressed: false,
        errorCode: null,
        externalRunId: null,
        processPid: null,
        processGroupId: null,
        processStartedAt: null,
        retryOfRunId: null,
        processLossRetryCount: 0,
        stdoutExcerpt: null,
        stderrExcerpt: null,
        contextSnapshot: null,
        startedAt: new Date("2026-04-02T00:00:00.000Z"),
        finishedAt: null,
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
        updatedAt: new Date("2026-04-02T00:00:00.000Z"),
      },
    ]);
    issuesListMock.mockResolvedValue([]);
    listKeysMock.mockResolvedValue([]);
    configRevisionsMock.mockResolvedValue([]);
    setBreadcrumbsMock.mockReset();
    closePanelMock.mockReset();
    openNewIssueMock.mockReset();
    setSelectedCompanyIdMock.mockReset();
    navigateMock.mockReset();
    localStorage.clear();
    vi.stubGlobal("confirm", confirmMock);
    confirmMock.mockReset();
    confirmMock.mockReturnValue(false);
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function renderPage() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <AgentDetail />
          </I18nProvider>
        </QueryClientProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    return root;
  }

  async function waitFor(condition: () => boolean, attempts = 20) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (condition()) return;
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    throw new Error("Timed out waiting for AgentDetail to settle");
  }

  it("renders localized prompts chrome for the instructions tab", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("高级选项") === true && container.textContent?.includes("文件") === true);

    expect(container.textContent).toContain("分配任务");
    expect(container.textContent).toContain("运行心跳");
    expect(container.textContent).toContain("指令");
    expect(container.textContent).toContain("复制 Agent ID");
    expect(container.textContent).toContain("重置会话");
    expect(container.textContent).toContain("终止");
    expect(container.textContent).toContain("高级选项");
    expect(container.textContent).toContain("模式");
    expect(container.textContent).toContain("托管");
    expect(container.textContent).toContain("外部");
    expect(container.textContent).toContain("根路径");
    expect(container.textContent).toContain("入口文件");
    expect(container.textContent).toContain("文件");
    expect(container.textContent).not.toContain("Delete notes.txt?");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "智能体", href: "/agents" },
      { label: "Budget Bot", href: "/agents/agent-one/dashboard" },
      { label: "指令" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });
});

// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Issue } from "@paperclipai/shared";
import { BreadcrumbBar } from "../components/BreadcrumbBar";
import { BreadcrumbProvider } from "../context/BreadcrumbContext";
import { PanelProvider } from "../context/PanelContext";
import { ThemeProvider } from "../context/ThemeContext";
import { ToastProvider } from "../context/ToastContext";
import { DialogProvider } from "../context/DialogContext";
import { IssueDetail, TaskDetailSurface } from "./IssueDetail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY_ID = "company-1";
const AGENT: Agent = {
  id: "agent-cos",
  companyId: COMPANY_ID,
  name: "Chief of Staff",
  urlKey: "chief-of-staff",
  role: "ceo",
  title: "Chief of Staff",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-08-01T10:00:00Z"),
  updatedAt: new Date("2026-08-01T10:00:00Z"),
};

const BASE_ISSUE: Issue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  projectId: null,
  projectWorkspaceId: null,
  goalId: null,
  parentId: null,
  title: "Streamlined mobile task detail test",
  description: "Verify mobile Properties sheet and More task actions menu.",
  status: "in_progress",
  priority: "medium",
  reviewPolicy: null,
  assigneeAgentId: AGENT.id,
  assigneeUserId: null,
  responsibleUserId: null,
  checkoutRunId: null,
  executionRunId: null,
  executionAgentNameKey: null,
  executionLockedAt: null,
  createdByAgentId: null,
  createdByUserId: "user-1",
  issueNumber: 6794,
  identifier: "PAP-6794",
  originKind: "manual",
  originId: null,
  originRunId: null,
  requestDepth: 0,
  billingCode: null,
  assigneeAdapterOverrides: null,
  executionPolicy: null,
  executionState: null,
  executionWorkspaceId: null,
  executionWorkspacePreference: null,
  executionWorkspaceSettings: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  hiddenAt: null,
  project: null,
  goal: null,
  currentExecutionWorkspace: null,
  workProducts: [],
  mentionedProjects: [],
  myLastTouchAt: null,
  lastExternalCommentAt: null,
  lastActivityAt: null,
  isUnreadForMe: false,
  workMode: "standard",
  createdAt: new Date("2026-08-01T10:00:00Z"),
  updatedAt: new Date("2026-08-01T10:00:00Z"),
};

const CHAT_ISSUE: Issue = {
  ...BASE_ISSUE,
  id: "22222222-2222-4222-8222-222222222222",
  identifier: "PAP-9001",
  title: "Chat with Chief of Staff",
  conversationAgentId: AGENT.id,
};

const testState = vi.hoisted(() => ({
  issue: null as Issue | null,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: true,
    sidebarOpen: false,
    setSidebarOpen: vi.fn(),
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: COMPANY_ID,
    selectedCompany: { id: COMPANY_ID, name: "Paperclip", issuePrefix: "PAP" },
    companies: [{ id: COMPANY_ID, name: "Paperclip", issuePrefix: "PAP" }],
    setSelectedCompanyId: vi.fn(),
  }),
  useOptionalCompany: () => ({
    selectedCompanyId: COMPANY_ID,
    selectedCompany: { id: COMPANY_ID, name: "Paperclip", issuePrefix: "PAP" },
    companies: [{ id: COMPANY_ID, name: "Paperclip", issuePrefix: "PAP" }],
  }),
}));

vi.mock("../context/LiveUpdatesProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../context/LiveUpdatesProvider")>();
  return {
    ...actual,
    useTaskRunLiveUpdates: () => ({
      subscribe: () => () => undefined,
    }),
    useTranscriptLiveStream: () => ({
      events: [],
      connected: false,
    }),
  };
});

vi.mock("../context/DesignSandboxContext", () => ({
  useDesignSandbox: () => false,
}));

vi.mock("../hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }),
}));

vi.mock("../hooks/useClassicTaskInterfaceEnabled", () => ({
  useClassicTaskInterfaceEnabled: () => ({ enabled: false, loaded: true }),
}));

vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: false, loaded: true, userId: "user-1" }),
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ slots: [] }),
  PluginSlotOutlet: () => null,
  PluginSlotMount: () => null,
}));

vi.mock("@/plugins/launchers", () => ({
  usePluginLaunchers: () => ({ launchers: [] }),
  PluginLauncherOutlet: () => null,
}));

vi.mock("../components/task-side-panel", () => ({
  TaskSidePanel: ({ issue, onRequestClose }: { issue: Issue; onRequestClose?: () => void }) => (
    <div data-testid="task-side-panel-sentinel">
      <span>Side panel for {issue.identifier}</span>
      {onRequestClose ? <button type="button" onClick={onRequestClose}>Close panel</button> : null}
    </div>
  ),
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: ReactNode } & React.ComponentProps<"a">) => (
      <a href={to} {...props}>{children}</a>
    ),
  };
});

function installMockFetch() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const pathname = new URL(rawUrl, "http://localhost").pathname;
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (pathname === "/api/auth/get-session") {
      return json({ session: { userId: "user-1" }, user: { id: "user-1", name: "Riley Board" } });
    }
    if (pathname === "/api/instance/settings/experimental") {
      return json({ enableStreamlinedUi: true, enableAgentChat: true });
    }
    if (pathname === "/api/workspace-preferences/me") {
      return json({ userId: "user-1", coordinatorWorkspaceEnabled: false, updatedAt: null });
    }
    if (pathname === "/api/cli-auth/me") {
      return json({ source: "local_implicit", isInstanceAdmin: true, companyIds: [COMPANY_ID], memberships: [] });
    }
    if (pathname === `/api/companies/${COMPANY_ID}/agents`) {
      return json([AGENT]);
    }
    if (pathname === `/api/companies/${COMPANY_ID}/access/user-directory`) {
      return json({ users: [{ principalId: "user-1", status: "active", user: { name: "Riley Board" } }] });
    }
    if (/^\/api\/issues\/[^/]+$/.test(pathname)) {
      return json(testState.issue ?? BASE_ISSUE);
    }
    if (/^\/api\/issues\/[^/]+\/recent-comments$/.test(pathname)) {
      return json({ comments: [], hasMore: false, latestCommentId: null });
    }
    if (/^\/api\/issues\/[^/]+\/queued-comments$/.test(pathname)) {
      return json({ queues: [], items: [], revision: "rev-1" });
    }
    if (/^\/api\/issues\/[^/]+\/tree-control\/state$/.test(pathname)) {
      return json({ activePauseHold: null });
    }
    if (/^\/api\/issues\/[^/]+\/documents\/plan$/.test(pathname)) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (/^\/api\/issues\/[^/]+\/(active-run|runner-goal)$/.test(pathname)) {
      return json(null);
    }
    if (/^\/api\/companies\/[^/]+\/email\/tasks\/[^/]+$/.test(pathname)) {
      return json(null);
    }
    return json([]);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe("IssueDetail & AgentChat mobile parity", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let restoreFetch: () => void;

  beforeEach(() => {
    testState.issue = BASE_ISSUE;
    restoreFetch = installMockFetch();
    if (!globalThis.ResizeObserver) {
      globalThis.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    restoreFetch();
  });

  async function flush() {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  function Harness({ children, initialEntry }: { children: ReactNode; initialEntry: string }) {
    return (
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <ToastProvider>
            <DialogProvider>
              <PanelProvider>
                <BreadcrumbProvider>
                  <MemoryRouter initialEntries={[initialEntry]}>
                    {children}
                  </MemoryRouter>
                </BreadcrumbProvider>
              </PanelProvider>
            </DialogProvider>
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
  }

  it("exposes mobile Properties sheet trigger, BreadcrumbBar properties toggle, and More task actions menu on Streamlined IssueDetail", async () => {
    await act(async () => {
      root.render(
        <Harness initialEntry="/PAP/issues/PAP-6794">
          <BreadcrumbBar showPropertiesToggle={false} />
          <Routes>
            <Route path="/:companyPrefix/issues/:issueId" element={<IssueDetail />} />
          </Routes>
        </Harness>,
      );
    });
    await flush();

    const moreButton = container.querySelector<HTMLButtonElement>('button[aria-label="More task actions"]');
    expect(moreButton).not.toBeNull();
    expect(moreButton!.closest(".hidden")).toBeNull();

    await act(async () => {
      moreButton!.click();
    });
    await flush();
    expect(document.body.textContent).toContain("Add subtask");
    expect(document.body.textContent).toContain("Copy as markdown");
    expect(document.body.textContent).toContain("Hide this task");

    const mobilePropsBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Properties"]');
    expect(mobilePropsBtn).not.toBeNull();
    expect(document.querySelector('[data-testid="mobile-task-side-panel"]')).toBeNull();

    await act(async () => {
      mobilePropsBtn!.click();
    });
    await flush();
    expect(document.querySelector('[data-testid="mobile-task-side-panel"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="task-side-panel-sentinel"]')?.textContent).toContain("PAP-6794");

    const hideToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Hide properties"]');
    expect(hideToggle).not.toBeNull();
    await act(async () => {
      hideToggle!.click();
    });
    await flush();
    expect(document.querySelector('[data-testid="mobile-task-side-panel"]')).toBeNull();

    const showToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Show properties"]');
    expect(showToggle).not.toBeNull();
    await act(async () => {
      showToggle!.click();
    });
    await flush();
    expect(document.querySelector('[data-testid="mobile-task-side-panel"]')).not.toBeNull();
  });

  it("opens the mobile properties Sheet when clicking Show properties on mobile AgentChat", async () => {
    testState.issue = CHAT_ISSUE;

    await act(async () => {
      root.render(
        <Harness initialEntry="/PAP/chats/chief-of-staff">
          <BreadcrumbBar showPropertiesToggle />
          <TaskDetailSurface
            conversation={{
              agent: AGENT,
              issue: CHAT_ISSUE,
              ensureIssue: async () => CHAT_ISSUE,
            }}
          />
        </Harness>,
      );
    });
    await flush();

    const showToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Show properties"]');
    expect(showToggle).not.toBeNull();
    expect(document.querySelector('[data-testid="mobile-task-side-panel"]')).toBeNull();

    await act(async () => {
      showToggle!.click();
    });
    await flush();

    expect(document.querySelector('[data-testid="mobile-task-side-panel"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="task-side-panel-sentinel"]')?.textContent).toContain("PAP-9001");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Hide properties"]')).not.toBeNull();
  });
});

// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueDocument } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  taskPanelAgentTasksTab,
  taskPanelArtifactsTab,
  taskPanelDocumentTab,
  taskPanelPropertiesTab,
  readTaskSidePanelState,
  writeTaskSidePanelState,
} from "@/lib/task-side-panel-state";
import type { TaskPluginPanel } from "@/hooks/useTaskPluginPanels";
import { TaskSidePanel } from "./TaskSidePanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: ({ context }: { context: { entityId: string } }) => <div>Plugin viewer {context.entityId}</div>,
}));
vi.mock("@/hooks/useTaskPluginPanels", () => ({
  taskPluginPanelId: (panel: TaskPluginPanel) => `plugin:${panel.slot.pluginKey}:${panel.slot.id}:${panel.entityId}`,
}));
const pluginPanel = { entityId: "33333333-3333-4333-8333-333333333333", runId: "run-1", slot: { pluginKey: "example.live-view", id: "screen", displayName: "Live view" } } as TaskPluginPanel;
const browserFixture = vi.hoisted(() => ({ data: [] as import("@paperclipai/shared").TaskBrowser[], viewer: vi.fn(async () => ({ url: "https://live.browser-use.com/test-viewer" })), control: vi.fn(async () => ({})) }));
vi.mock("@/hooks/useTaskBrowsers", () => ({ useTaskBrowsers: () => ({ data: browserFixture.data, isError: false }) }));
vi.mock("@/api/browser-use", () => ({ browserUseApi: { viewer: browserFixture.viewer, control: browserFixture.control, presence: vi.fn(async () => ({ accepted: true })) } }));
const fixture = vi.hoisted(() => ({
  documents: [] as IssueDocument[] | undefined,
  plan: null as IssueDocument | null | undefined,
}));

const routeFixture = vi.hoisted(() => ({
  location: {
    pathname: "/issues/PAP-1",
    search: "",
    hash: "",
    state: null as unknown,
  },
  navigate: vi.fn(),
}));

vi.mock("@/hooks/useIssueDocuments", () => ({
  useIssueDocuments: () => ({ data: fixture.documents }),
}));

vi.mock("@/hooks/useIssuePlanDocument", () => ({
  useIssuePlanDocument: () => ({ data: fixture.plan }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => routeFixture.location,
  useNavigate: () => routeFixture.navigate,
}));

vi.mock("@/components/IssueProperties", () => ({
  IssueProperties: () => <div>Properties content</div>,
}));

vi.mock("@/components/issue-properties/IssuePropertiesArtifactsTab", () => ({
  IssuePropertiesArtifactsTab: () => <div>Artifacts content</div>,
}));

vi.mock("@/components/issue-properties/IssuePropertiesPlansTab", () => ({
  IssuePropertiesPlansTab: () => <div>Plan content</div>,
}));

vi.mock("@/components/task-detail/TaskDetailRelationsPanel", () => ({
  TaskDetailSubtasksPanel: ({ items }: { items: Issue[] }) => (
    <div>{`Subtasks content: ${items.length}`}</div>
  ),
}));

const agentChat = vi.hoisted(() => ({ enabled: true }));
const coordinator = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: coordinator.enabled, loaded: true }),
}));
vi.mock("@/hooks/useAgentChatEnabled", () => ({
  useAgentChatEnabled: () => ({ enabled: agentChat.enabled, loaded: true }),
}));

vi.mock("@/components/chat/AgentWorkPanels", () => ({
  AgentTasksPanel: ({ agentId, excludeIssueId }: { agentId: string; excludeIssueId?: string }) => (
    <div>{`Agent tasks ${agentId} excluding ${excludeIssueId}`}</div>
  ),
  AgentArtifactsPanel: ({ agentId }: { agentId: string }) => <div>{`Agent artifacts ${agentId}`}</div>,
}));

vi.mock("@/components/WorkspaceFileBrowser", () => ({
  WorkspaceFileBrowser: () => <div>Files browser</div>,
}));

vi.mock("./TaskAttachmentPanel", () => ({ TaskAttachmentPanel: ({ attachmentId }: { attachmentId: string }) => <div>Text file {attachmentId}</div> }));

vi.mock("./TaskDocumentPanel", () => ({
  TaskDocumentPanel: ({ documentKey, issueId, revisionId, documentIssueId, currentIssueId, initialDocument }: { documentKey: string; issueId: string; revisionId?: string; documentIssueId?: string; currentIssueId?: string; initialDocument?: IssueDocument }) => <div data-document-owner={issueId} data-gallery-owner={documentIssueId} data-current-task={currentIssueId} data-revision-id={revisionId} data-initial-document={initialDocument?.id}>{`Document ${documentKey}`}</div>,
}));

vi.mock("./TaskWorkspaceFilePanel", () => ({
  TaskWorkspaceFilePanel: () => <div>Workspace file</div>,
}));

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "task-1",
    companyId: "company-1",
    title: "Portable tabs",
    workMode: "agent",
    ...overrides,
  } as Issue;
}

function issueDocument(key: string, title: string): IssueDocument {
  return {
    id: `document-${key}`,
    issueId: "task-1",
    key,
    title,
    body: `# ${title}`,
    latestRevisionNumber: 1,
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
  } as unknown as IssueDocument;
}

describe("TaskSidePanel", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    coordinator.enabled = false;
    window.localStorage.clear();
    browserFixture.data = [];
    browserFixture.control.mockClear();
    fixture.documents = [];
    fixture.plan = null;
    routeFixture.location.search = "";
    routeFixture.location.hash = "";
    window.history.replaceState(null, "", routeFixture.location.pathname);
    routeFixture.navigate.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    Element.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(node: ReactNode) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>{node}</TooltipProvider>
        </QueryClientProvider>,
      );
    });
  }

  function panel(props: Partial<Parameters<typeof TaskSidePanel>[0]> = {}) {
    return (
      <TaskSidePanel
        issue={issue()}
        accountScope="user-1"
        onUpdate={() => {}}
        fileTabsEnabled={false}
        inline
        {...props}
      />
    );
  }

  it("adds the active plugin panel, preserves manual dismissal, and removes inactive plugin panels", async () => {
    await render(panel({ pluginPanels: [pluginPanel] }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Live view");
    expect(container.textContent).toContain(`Plugin viewer ${pluginPanel.entityId}`);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close Live view"]')?.click());
    await render(panel({ pluginPanels: [pluginPanel] }));
    expect(container.querySelector('[data-side-panel-tab-target^="plugin:"]')).toBeNull();
    await render(panel({ pluginPanels: [] }));
    await render(panel({ pluginPanels: [pluginPanel] }));
    expect(container.querySelector('[data-side-panel-tab-target^="plugin:"]')).toBeNull();
    // An already handled panel remains available in the launcher without reopening.
    expect(container.textContent).not.toContain("Plugin viewer");
    await render(panel({ pluginPanels: [] }));
    expect(container.querySelector('[data-side-panel-tab-target^="plugin:"]')).toBeNull();
    expect(container.textContent).not.toContain("Plugin viewer");
  });

  it("restores an automatically removed panel without taking focus after availability recovers", async () => {
    await render(panel({ pluginPanels: [pluginPanel] }));
    await act(async () => container.querySelector<HTMLButtonElement>('#side-panel-tab-properties')?.click());
    await render(panel({ pluginPanels: [] }));
    expect(container.querySelector('[data-side-panel-tab-target^="plugin:"]')).toBeNull();
    await render(panel({ pluginPanels: [pluginPanel] }));
    expect(container.querySelector('[data-side-panel-tab-target^="plugin:"]')).not.toBeNull();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
    expect(container.textContent).not.toContain("Plugin viewer");
  });

  it("preserves dismissal and saved selection when the mobile drawer remounts", async () => {
    const openedPluginPanelKeys = new Set<string>();
    const dismissedPluginPanelKeys = new Set<string>();
    await render(panel({ pluginPanels: [pluginPanel], openedPluginPanelKeys, dismissedPluginPanelKeys, mobile: true }));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="Switch tabs"]')?.click());
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close Live view"]');
    expect(close).not.toBeNull();
    await act(async () => close!.click());
    const selected = container.querySelector('[id^="side-panel-tab-"]')?.id;
    expect(container.querySelector('button[aria-label^="Switch tabs"]')?.getAttribute("aria-label")).toBe("Switch tabs, 1 open");
    expect(container.textContent).not.toContain("Plugin viewer");
    await render(null);
    await render(panel({ pluginPanels: [pluginPanel], openedPluginPanelKeys, dismissedPluginPanelKeys, mobile: true }));
    expect(container.querySelector('[id^="side-panel-tab-"]')?.id).toBe(selected);
    expect(container.querySelector('button[aria-label^="Switch tabs"]')?.getAttribute("aria-label")).toBe("Switch tabs, 1 open");
    expect(container.textContent).not.toContain("Plugin viewer");
  });

  it("replaces a previous agent's plugin panel when the task's running agent changes", async () => {
    await render(panel({ pluginPanels: [pluginPanel] }));
    const next = { ...pluginPanel, entityId: "44444444-4444-4444-8444-444444444444", runId: "run-2" };
    await render(panel({ pluginPanels: [next] }));
    expect(container.querySelectorAll('[data-side-panel-tab-target^="plugin:"]')).toHaveLength(1);
    expect(container.textContent).toContain(`Plugin viewer ${next.entityId}`);
    expect(container.textContent).not.toContain(`Plugin viewer ${pluginPanel.entityId}`);
  });

  it("keeps the upload slot mounted and inert when switching away from Artifacts", async () => {
    await render(panel({ streamlinedTabs: true, artifactsOpenRequestId: 1 }));
    const slot = container.querySelector<HTMLElement>("[data-artifact-upload-slot]");
    expect(slot).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>("#side-panel-tab-artifacts")?.click());
    expect(slot?.getAttribute("aria-hidden")).toBe("false");
    expect(slot?.hasAttribute("inert")).toBe(false);
    expect(slot?.className).not.toContain("invisible");

    await act(async () => container.querySelector<HTMLButtonElement>("#side-panel-tab-properties")?.click());
    expect(container.querySelector("[data-artifact-upload-slot]")).toBe(slot);
    expect(slot?.getAttribute("aria-hidden")).toBe("true");
    expect(slot?.hasAttribute("inert")).toBe(true);
    expect(slot?.className).toContain("invisible");

    await act(async () => container.querySelector<HTMLButtonElement>("#side-panel-tab-artifacts")?.click());
    expect(container.querySelector("[data-artifact-upload-slot]")).toBe(slot);
    expect(slot?.hasAttribute("inert")).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close Artifacts"]')?.click());
    expect(container.querySelector("[data-artifact-upload-slot]")).toBeNull();
  });

  it("opens only the requested Coordinator document despite background plans, subtasks and artifacts", async () => {
    coordinator.enabled = true;
    fixture.plan = issueDocument("plan", "Unrequested plan");
    fixture.documents = [fixture.plan, issueDocument("report", "Reviewed report")];
    routeFixture.location.hash = "#document-report&revision=reviewed-version&interaction=decision-1";
    const onArtifactsOpened = vi.fn();
    await render(panel({
      documentDeepLink: { requestId: 1, documentKey: "report" },
      artifactsOpenRequestId: 1, onArtifactsOpened,
      showSubtasksTab: true, childIssues: [issue({ id: "child-1" })],
    }));
    expect([...container.querySelectorAll('[role="tab"]')].map(tab => tab.getAttribute("data-side-panel-tab-target")))
      .toEqual(["document:report:reviewed-version"]);
    expect(onArtifactsOpened).toHaveBeenCalledWith(1);
  });

  it("opens another task's exact plan without requiring an origin plan or reusing origin document data", async () => {
    coordinator.enabled = true;
    fixture.plan = null;
    fixture.documents = [issueDocument("plan", "Origin task document must not leak")];
    routeFixture.location.hash = "#document-plan&revision=b-v1&interaction=review-on-a&documentIssue=task-b";
    await render(panel({ documentDeepLink: { requestId: 1, documentKey: "plan" } }));
    const document = container.querySelector("[data-document-owner]");
    expect(document?.getAttribute("data-document-owner")).toBe("task-b");
    expect(document?.getAttribute("data-gallery-owner")).toBe("task-b");
    expect(document?.getAttribute("data-current-task")).toBe("task-1");
    expect(document?.getAttribute("data-revision-id")).toBe("b-v1");
    expect(document?.hasAttribute("data-initial-document")).toBe(false);
    expect(container.textContent).not.toContain("Origin task document must not leak");
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-side-panel-tab-target")).toBe("document:task-b:plan:b-v1");
    routeFixture.location.hash = "#document-local";
    await render(panel());
    expect(container.querySelector("[data-gallery-owner]")?.getAttribute("data-gallery-owner")).toBe("task-b");
  });

  it("preserves explicitly saved Coordinator tabs when a decision link adds its document", async () => {
    coordinator.enabled = true;
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: { tabs: [taskPanelPropertiesTab(), taskPanelArtifactsTab()], activeTabId: "properties" },
      launcherOpen: false, userInteracted: true, autoPlanHandled: false, updatedAt: Date.now(),
    });
    fixture.documents = [issueDocument("report", "Report")];
    await render(panel({ documentDeepLink: { requestId: 1, documentKey: "report" } }));
    expect([...container.querySelectorAll('[role="tab"]')].map(tab => tab.getAttribute("data-side-panel-tab-target")))
      .toEqual(["properties", "artifacts", "document:report"]);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Report");
  });

  it("opens, deduplicates, switches and closes text attachment tabs", async () => {
    const onAttachmentOpened = vi.fn();
    await render(panel({ openAttachment: { id: "file-1", title: "AGENTS.md", requestId: 1 }, onAttachmentOpened }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("AGENTS.md");
    expect(container.textContent).toContain("Text file file-1");
    expect(onAttachmentOpened).toHaveBeenCalledOnce();
    await render(panel({ openAttachment: { id: "file-2", title: "summary.txt", requestId: 2 } }));
    await render(panel({ openAttachment: { id: "file-1", title: "AGENTS.md", requestId: 3 } }));
    expect(container.querySelectorAll('[data-side-panel-tab-target="attachment:file-1"]')).toHaveLength(1);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("AGENTS.md");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close AGENTS.md"]')?.click());
    expect(container.querySelector('[data-side-panel-tab-target="attachment:file-1"]')).toBeNull();
  });

  it("lets an attachment request take focus from a workspace-file route", async () => {
    routeFixture.location.search = "?file=README.md&workspace=project";
    window.history.replaceState(null, "", `${routeFixture.location.pathname}${routeFixture.location.search}`);
    await render(panel({ fileTabsEnabled: true, openAttachment: { id: "file-1", title: "notes.txt", requestId: 1 } }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("notes.txt");
    expect(routeFixture.navigate).toHaveBeenCalledWith(expect.objectContaining({ search: "" }), expect.anything());
  });

  it("keeps a live browser mounted across tab switches and only hides it on close", async () => {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    browserFixture.data = [{ id, sessionId: id, issueId: "task-1", status: "running", runStatus: "running", progress: null, error: null, costCents: 0, idleDeadline: null, expiresAt: null, createdAt: new Date().toISOString() }];
    await render(panel({ openBrowserId: id }));
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe?.getAttribute("src")).toContain("test-viewer");
    await render(panel());
    await act(async () => container.querySelector<HTMLButtonElement>("#side-panel-tab-properties")?.click());
    expect(container.querySelector("iframe")).toBe(iframe);
    expect(iframe?.closest("[hidden]")).toBeTruthy();
    expect(localStorage.getItem("paperclip:task-side-panel:v1:user-1:company-1")).not.toContain("test-viewer");
    await act(async () => container.querySelector<HTMLButtonElement>(`[id="side-panel-tab-browser:${id}"]`)?.click());
    const close = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b => b.getAttribute("aria-label")?.startsWith("Close Browser"));
    expect(close).toBeTruthy();
    await act(async () => close?.click());
    expect(container.querySelector("iframe")).toBeNull();
    expect(browserFixture.control).not.toHaveBeenCalled();
  });

  it("commits a follow-up browser before acknowledging the open request", async () => {
    const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const next = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const acknowledged = vi.fn(() => {
      expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe(`side-panel-tab-browser:${next}`);
      expect(localStorage.getItem("paperclip:task-side-panel:v1:user-1:company-1")).toContain(next);
    });
    await render(panel({ openBrowserId: first }));
    await render(panel({ openBrowserId: next, onBrowserOpened: acknowledged }));
    expect(acknowledged).toHaveBeenCalledTimes(1);
    await render(panel());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe(`side-panel-tab-browser:${next}`);
  });

  it("opens an agent chat on the agent's tasks, not the conversation's artifacts", async () => {
    await render(panel({ issue: issue({ conversationAgentId: "agent-1" }) }));
    const selected = container.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.getAttribute("data-side-panel-tab-target")).toBe("agent-tasks");
    expect(selected?.textContent).toContain("Tasks");
    expect(container.textContent).toContain("Agent tasks agent-1 excluding task-1");
    expect(container.textContent).not.toContain("Artifacts content");
  });

  it("keeps an Artifacts-only layout the user chose", async () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: { tabs: [taskPanelArtifactsTab()], activeTabId: "artifacts" },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: false,
      updatedAt: 1,
    });
    await render(panel({ issue: issue({ conversationAgentId: "agent-1" }) }));
    expect(Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.getAttribute("data-side-panel-tab-target")))
      .toEqual(["artifacts"]);
  });

  it("falls back to Artifacts when Agent Chat is off and only the Tasks tab was saved", async () => {
    agentChat.enabled = false;
    try {
      writeTaskSidePanelState("user-1", "company-1", "task-1", {
        state: { tabs: [taskPanelAgentTasksTab()], activeTabId: "agent-tasks" },
        launcherOpen: false,
        userInteracted: true,
        autoPlanHandled: false,
        updatedAt: 1,
      });
      await render(panel({ issue: issue({ conversationAgentId: "agent-1" }) }));
      expect(container.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-side-panel-tab-target")).toBe("artifacts");
      expect(container.textContent).toContain("Artifacts content");
    } finally {
      agentChat.enabled = true;
    }
  });

  it("moves a chat's stored Artifacts-only default onto the agent's tasks", async () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: { tabs: [taskPanelArtifactsTab()], activeTabId: "artifacts" },
      launcherOpen: false,
      userInteracted: false,
      autoPlanHandled: false,
      updatedAt: 1,
    });
    await render(panel({ issue: issue({ conversationAgentId: "agent-1" }) }));
    expect(Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.getAttribute("data-side-panel-tab-target")))
      .toEqual(["agent-tasks"]);
  });

  it("offers the agent's artifacts from the + launcher in an agent chat", async () => {
    await render(panel({ issue: issue({ conversationAgentId: "agent-1" }), streamlinedTabs: true }));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open a new tab"]')?.click());
    const artifactsItem = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((item) => item.textContent?.includes("Artifacts"));
    await act(async () => artifactsItem?.click());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-side-panel-tab-target")).toBe("artifacts");
    expect(container.textContent).toContain("Agent artifacts agent-1");
    expect(container.textContent).not.toContain("Artifacts content");
  });

  it("keeps a chat on the conversation's own Artifacts while Agent Chat is off", async () => {
    agentChat.enabled = false;
    try {
      await render(panel({ issue: issue({ conversationAgentId: "agent-1" }) }));
      expect(container.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-side-panel-tab-target")).toBe("artifacts");
      expect(container.textContent).toContain("Artifacts content");
      expect(container.textContent).not.toContain("Agent tasks");
    } finally {
      agentChat.enabled = true;
    }
  });

  it("opens Properties on first visit", async () => {
    await render(panel());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
    expect(container.textContent).toContain("Properties content");
  });

  it("does not acknowledge a browser selection that could not be persisted", async () => {
    const acknowledged = vi.fn();
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    const storage = window.localStorage;
    const write = vi.fn(() => { throw new Error("storage full"); });
    // jsdom Storage instances ignore an own-method spy. Replace the surface
    // explicitly so this failure injection also works with native Storage.
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: storage.getItem.bind(storage), setItem: write },
    });
    try {
      await render(panel({ openBrowserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", onBrowserOpened: acknowledged }));
      expect(write).toHaveBeenCalled();
      expect(acknowledged).not.toHaveBeenCalled();
    } finally { Object.defineProperty(window, "localStorage", descriptor); }
  });

  it("offers the existing live browser from a closed tab and distinguishes session tabs", async () => {
    const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const next = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const shared = { issueId: "task-1", runStatus: "completed" as const, progress: null, error: null, costCents: 0, idleDeadline: null, expiresAt: null, createdAt: new Date().toISOString() };
    browserFixture.data = [
      { ...shared, id: first, sessionId: first, status: "closed" },
      { ...shared, id: next, sessionId: next, status: "idle" },
    ];
    await render(panel({ openBrowserId: first }));
    await render(panel());
    expect(container.textContent).toContain("Another browser is still open");
    expect(container.textContent).not.toContain("Send a task message");
    const recovery = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Open active browser')!;
    await act(async () => recovery.click());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Browser 2");
    expect(container.querySelector('[role="tab"][aria-selected="false"]')?.textContent).toBe("Properties");
    expect(container.querySelector('iframe')).toBeTruthy();
    expect(browserFixture.control).not.toHaveBeenCalled();
  });

  it("adds Artifacts on arrival while preserving the selected tab", async () => {
    await render(panel());
    await act(async () => container.querySelector<HTMLButtonElement>("#side-panel-tab-properties")?.click());
    await render(panel({ artifactsOpenRequestId: 1 }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");

    await act(async () => container.querySelector<HTMLButtonElement>("#side-panel-tab-properties")?.click());
    fixture.documents = [issueDocument("report", "Updated report")];
    await render(panel({ artifactsOpenRequestId: 1 }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");

    await render(panel({ artifactsOpenRequestId: 2 }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
    expect(container.querySelectorAll('[data-side-panel-tab-target="artifacts"]')).toHaveLength(1);
  });

  it("reopens a dismissed Artifacts tab only for a new arrival", async () => {
    await render(panel({ artifactsOpenRequestId: 1 }));
    await act(async () => container.querySelector<HTMLButtonElement>("#side-panel-tab-artifacts")?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close Artifacts"]')?.click());
    await render(panel({ artifactsOpenRequestId: 1 }));
    expect(container.querySelector('[data-side-panel-tab-target="artifacts"]')).toBeNull();
    await render(panel({ artifactsOpenRequestId: 2 }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
  });

  it("acknowledges an arrival so remounting the panel preserves a later manual selection", async () => {
    const onArtifactsOpened = vi.fn();
    await render(panel({ artifactsOpenRequestId: 1, onArtifactsOpened }));
    expect(onArtifactsOpened).toHaveBeenCalledExactlyOnceWith(1);
    await render(panel({ onArtifactsOpened }));
    await act(async () => container.querySelector<HTMLButtonElement>("#side-panel-tab-properties")?.click());
    await render(null);
    await render(panel({ onArtifactsOpened }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
    expect(onArtifactsOpened).toHaveBeenCalledTimes(1);
  });

  it("keeps the workspace-file route and selection when an artifact arrives", async () => {
    routeFixture.location.search = "?file=ui%2Fsrc%2FApp.tsx&workspace=project";
    window.history.replaceState(null, "", `${routeFixture.location.pathname}${routeFixture.location.search}`);
    await render(panel({ fileTabsEnabled: true }));
    await render(panel({ fileTabsEnabled: true, artifactsOpenRequestId: 1 }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("App.tsx");
    expect(container.querySelectorAll('[data-side-panel-tab-target="artifacts"]')).toHaveLength(1);
    expect(routeFixture.navigate).not.toHaveBeenCalled();
  });

  it("preserves an explicitly linked document when artifacts arrive", async () => {
    fixture.documents = [issueDocument("agents", "AGENTS.md")];
    const documentDeepLink = { requestId: 1, documentKey: "agents" };
    await render(panel({ documentDeepLink, artifactsOpenRequestId: 1 }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("AGENTS.md");
    expect(container.querySelectorAll('[data-side-panel-tab-target="artifacts"]')).toHaveLength(1);
  });

  it("handles each document link once without overriding later manual selection", async () => {
    fixture.documents = [issueDocument("agents", "AGENTS.md")];
    const documentDeepLink = { requestId: 1, documentKey: "agents" };
    await render(panel({ documentDeepLink }));
    await act(async () => container.querySelector<HTMLButtonElement>("#side-panel-tab-properties")?.click());
    fixture.documents = [...fixture.documents, issueDocument("skill", "SKILL.md")];
    await render(panel({ documentDeepLink: { ...documentDeepLink }, artifactsOpenRequestId: 1 }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
    expect(container.querySelectorAll('[data-side-panel-tab-target="artifacts"]')).toHaveLength(1);

    await render(panel({ documentDeepLink: { ...documentDeepLink, requestId: 2 } }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("AGENTS.md");
  });

  it("keeps a document selected when an artifact arrives", async () => {
    fixture.documents = [issueDocument("report", "Report")];
    const documentDeepLink = { documentKey: "report", requestId: 1 };
    await render(panel({ documentDeepLink }));
    await render(panel({ documentDeepLink, artifactsOpenRequestId: 1 }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Report");
    expect(container.querySelectorAll('[data-side-panel-tab-target="artifacts"]')).toHaveLength(1);
    expect(container.textContent).toContain("Document report");
  });

  it("uses the approved pre-rebase tab appearance for Streamlined UI", async () => {
    await render(panel({ streamlinedTabs: true }));
    const propertiesTab = container.querySelector<HTMLElement>('[data-side-panel-tab-target="properties"]');
    expect(propertiesTab?.className).toContain("text-sm");
    expect(propertiesTab?.querySelector("svg")).toBeNull();
    expect(container.querySelector('[data-side-panel-tab-wrapper="properties"]')?.parentElement?.className).toContain("mx-0.75");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Close Properties"]')?.className)
      .toContain("opacity-100");
    const addButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open a new tab"]');
    expect(addButton?.className).toContain("h-(--side-panel-tab-height)");
    expect(addButton?.className).toContain("w-(--side-panel-tab-height)");
    expect(addButton?.className).toContain("hover:bg-accent");
  });

  it("shows an uncounted Subtasks tab only when Streamlined UI has child tasks", async () => {
    const children = [
      issue({ id: "child-1", title: "First child" }),
      issue({ id: "child-2", title: "Second child" }),
    ];
    await render(panel({ childIssues: children, showSubtasksTab: true, streamlinedTabs: true }));

    const propertiesTab = container.querySelector<HTMLElement>('[data-side-panel-tab-target="properties"]');
    const subtasksTab = container.querySelector<HTMLButtonElement>('[data-side-panel-tab-target="subtasks"]');
    expect(propertiesTab?.getAttribute("aria-selected")).toBe("true");
    expect(subtasksTab?.textContent?.trim()).toBe("Subtasks");
    expect(subtasksTab?.getAttribute("aria-label")).toBe("Subtasks");

    await act(async () => subtasksTab?.click());
    expect(container.textContent).toContain("Subtasks content: 2");
  });

  it("adds related tasks without children and preserves the selected plan", async () => {
    fixture.plan = issueDocument("plan", "Plan");
    fixture.documents = [fixture.plan];
    await render(panel({
      showSubtasksTab: true,
      tasksTab: { count: 0, content: <div>No tasks yet</div> },
    }));
    expect(container.querySelector('[data-side-panel-tab-target="subtasks"]')).toBeNull();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Plan");

    await render(panel({
      showSubtasksTab: true,
      tasksTab: { count: 1, content: <div>Cross-project follow-up</div> },
    }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Plan");
    const tasks = container.querySelector<HTMLButtonElement>('[data-side-panel-tab-target="subtasks"]');
    expect(tasks?.textContent?.trim()).toBe("Tasks");
    await act(async () => tasks?.click());
    expect(container.textContent).toContain("Cross-project follow-up");
    expect(container.textContent).not.toContain("Subtasks content");
  });

  it("exposes failed task loading even when no task count is available", async () => {
    await render(panel({ showSubtasksTab: true, tasksTab: { count: 0, hasError: true, content: <div role="alert">Could not load all tasks.</div> } }));
    const tasks = container.querySelector<HTMLButtonElement>('[data-side-panel-tab-target="subtasks"]');
    expect(tasks?.textContent?.trim()).toBe("Tasks");
    await act(async () => tasks?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load all tasks");
  });

  it("inserts Subtasks after Properties when child tasks load later", async () => {
    await render(panel({ childIssues: [], showSubtasksTab: true, streamlinedTabs: true }));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open a new tab"]')?.click());
    const artifactsItem = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((item) => item.textContent?.includes("Artifacts"));
    await act(async () => artifactsItem?.click());

    await render(panel({
      childIssues: [issue({ id: "child-1" })],
      showSubtasksTab: true,
      streamlinedTabs: true,
    }));

    expect(Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.getAttribute("data-side-panel-tab-target")))
      .toEqual(["properties", "subtasks", "artifacts"]);
  });

  it("hides Subtasks for tasks without children and when Streamlined UI is off", async () => {
    await render(panel({ childIssues: [], showSubtasksTab: true }));
    expect(container.querySelector('[data-side-panel-tab-target="subtasks"]')).toBeNull();

    await render(panel({ childIssues: [issue({ id: "child-1" })], showSubtasksTab: false }));
    expect(container.querySelector('[data-side-panel-tab-target="subtasks"]')).toBeNull();
  });

  it("reopens a closed Subtasks tab from the launcher", async () => {
    await render(panel({
      childIssues: [issue({ id: "child-1" })],
      showSubtasksTab: true,
      streamlinedTabs: true,
    }));

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close Subtasks"]')?.click());
    expect(container.querySelector('[data-side-panel-tab-target="subtasks"]')).toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open a new tab"]')?.click());
    const launcherItem = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((item) => item.textContent?.includes("Subtasks"));
    expect(launcherItem).not.toBeUndefined();
    await act(async () => launcherItem?.click());
    expect(container.querySelector('[data-side-panel-tab-target="subtasks"]')).not.toBeNull();
  });

  it("does not create a Plan tab for planning mode before a plan exists", async () => {
    await render(panel({ issue: issue({ workMode: "planning" }) }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
    expect(container.querySelector('[data-side-panel-tab-target="document:plan"]')).toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open a new tab"]')?.click());
    expect(Array.from(container.querySelectorAll('[role="option"]')).some((item) => item.textContent?.includes("Plan"))).toBe(false);
  });

  it("opens a newly materialized plan until the user has interacted", async () => {
    await render(panel());
    fixture.plan = issueDocument("plan", "Plan");
    fixture.documents = [fixture.plan];
    await render(panel());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Plan");
  });

  it("opens a plan deep link without looping while document metadata loads", async () => {
    fixture.documents = undefined;
    fixture.plan = undefined;

    await render(panel({
      issue: issue({ workMode: "planning" }),
      documentDeepLink: { requestId: 1, documentKey: "plan" },
    }));

    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Plan");
  });

  it("does not auto-open a plan after manual tab interaction", async () => {
    await render(panel());
    await act(async () => container.querySelector<HTMLButtonElement>('#side-panel-tab-properties')?.click());
    fixture.plan = issueDocument("plan", "Plan");
    fixture.documents = [fixture.plan];
    await render(panel());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
    expect(container.querySelector('[data-side-panel-tab-target="document:plan"]')).toBeNull();
  });

  it("lets a persisted intentionally empty state win over defaults", async () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: { tabs: [], activeTabId: null },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: true,
      updatedAt: 1,
    });
    await render(panel({ issue: issue({ workMode: "planning" }) }));
    expect(container.querySelector('[role="tab"]')).toBeNull();
    expect(container.getElementsByTagName("input")[0]?.getAttribute("aria-label")).toBe("Search tabs and resources…");
  });

  it("removes a Plan tab persisted before a plan document existed", async () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: {
        tabs: [taskPanelPropertiesTab(), taskPanelDocumentTab("plan", "Plan")],
        activeTabId: "document:plan",
      },
      launcherOpen: false,
      userInteracted: false,
      autoPlanHandled: false,
      updatedAt: 1,
    });

    await render(panel({ issue: issue({ workMode: "planning" }) }));

    expect(container.querySelector('[data-side-panel-tab-target="document:plan"]')).toBeNull();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
  });

  it("opens an ordinary document deep link in a deduplicated document tab", async () => {
    fixture.documents = [issueDocument("brief", "Implementation brief")];
    await render(panel({ documentDeepLink: { requestId: 1, documentKey: "brief" } }));
    expect(container.querySelectorAll('[data-side-panel-tab-target="document:brief"]')).toHaveLength(1);
    expect(container.textContent).toContain("Document brief");
    await render(panel({ documentDeepLink: { requestId: 2, documentKey: "brief" } }));
    expect(container.querySelectorAll('[data-side-panel-tab-target="document:brief"]')).toHaveLength(1);
  });

  it("keeps Files out of the launcher when the experiment is disabled", async () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: { tabs: [], activeTabId: null },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: true,
      updatedAt: 1,
    });
    await render(panel());
    expect(Array.from(container.querySelectorAll('[role="option"]')).some((item) => item.textContent?.includes("Files"))).toBe(false);
  });

  it("restores a persisted Properties tab", async () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: { tabs: [taskPanelPropertiesTab()], activeTabId: "properties" },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: true,
      updatedAt: 1,
    });
    await render(panel({ issue: issue({ workMode: "planning" }) }));
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(container.textContent).toContain("Properties content");
  });

  it.each([false, true])("restores each workspace before persisting a same-task scope switch (mobile=%s)", async (mobile) => {
    const classic = { tabs: [taskPanelPropertiesTab()], activeTabId: "properties" };
    const experiment = { tabs: [taskPanelArtifactsTab()], activeTabId: "artifacts" };
    for (const [scope, state] of [["user-1", classic], ["coordinator:user-1", experiment]] as const) {
      writeTaskSidePanelState(scope, "company-1", "task-1", {
        state, launcherOpen: false, userInteracted: true, autoPlanHandled: true, updatedAt: 1,
      });
    }
    await render(panel({ accountScope: "user-1", mobile }));
    expect(container.textContent).toContain("Properties content");
    // A preference refreshed from another window can change scope without
    // changing the task or remounting the public TaskSidePanel component.
    coordinator.enabled = true;
    await render(panel({ accountScope: "coordinator:user-1", mobile }));
    expect(container.textContent).toContain("Artifacts content");
    expect(container.textContent).not.toContain("Properties content");
    expect(readTaskSidePanelState("user-1", "company-1", "task-1", false)?.state).toEqual(classic);
    expect(readTaskSidePanelState("coordinator:user-1", "company-1", "task-1", false)?.state).toEqual(experiment);
    coordinator.enabled = false;
    await render(panel({ accountScope: "user-1", mobile }));
    expect(container.textContent).toContain("Properties content");
    expect(readTaskSidePanelState("coordinator:user-1", "company-1", "task-1", false)?.state).toEqual(experiment);
  });

  it("opens a URL-backed workspace file tab outside file-viewer provider ancestry", async () => {
    routeFixture.location.search = "?file=ui%2Fsrc%2FApp.tsx&line=7&workspace=project";
    window.history.replaceState(null, "", `${routeFixture.location.pathname}${routeFixture.location.search}`);
    await render(panel({ fileTabsEnabled: true }));

    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("App.tsx");
    expect(container.textContent).toContain("Workspace file");
  });

  it("clears file-viewer URL state when switching to a non-file tab", async () => {
    routeFixture.location.search = "?file=ui%2Fsrc%2FApp.tsx&line=7&workspace=project";
    window.history.replaceState(null, "", `${routeFixture.location.pathname}${routeFixture.location.search}`);
    await render(panel({ fileTabsEnabled: true }));

    await act(async () => container.querySelector<HTMLButtonElement>("#side-panel-tab-properties")?.click());

    expect(routeFixture.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/issues/PAP-1", search: "" }),
      expect.objectContaining({ replace: false }),
    );
  });
});

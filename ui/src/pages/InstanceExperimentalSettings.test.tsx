// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  InstanceExperimentalSettings as InstanceExperimentalSettingsPayload,
  InstanceExperimentalSettingsWithManaged,
  IssueGraphLivenessAutoRecoveryPreview,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceExperimentalSettings } from "./InstanceExperimentalSettings";
import { queryKeys } from "../lib/queryKeys";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
  updateExperimental: vi.fn(),
  previewIssueGraphLivenessAutoRecovery: vi.fn(),
  runIssueGraphLivenessAutoRecovery: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

const CONFERENCE_TOGGLE_SELECTOR =
  'button[aria-label="Toggle conference room chat experimental setting"]';
const STREAMLINED_TOGGLE_SELECTOR =
  'button[aria-label="Toggle streamlined left navigation experimental setting"]';
const TASK_WATCHDOGS_TOGGLE_SELECTOR =
  'button[aria-label="Toggle task watchdogs experimental setting"]';
const GOALS_SIDEBAR_LINK_TOGGLE_SELECTOR =
  'button[aria-label="Toggle goals sidebar link experimental setting"]';
const DECISIONS_TOGGLE_SELECTOR =
  'button[aria-label="Toggle decisions experimental setting"]';
const SERVER_INFO_TOGGLE_SELECTOR =
  'button[aria-label="Toggle server info debug view experimental setting"]';
const BUILT_IN_AGENTS_TOGGLE_SELECTOR =
  'button[aria-label="Toggle built-in agents experimental setting"]';
const APPS_TOGGLE_SELECTOR = 'button[aria-label="Toggle apps experimental setting"]';
const SUMMARIES_TOGGLE_SELECTOR =
  'button[aria-label="Toggle summaries experimental setting"]';
const AUTO_RECOVERY_TOGGLE_SELECTOR =
  'button[aria-label="Toggle task graph liveness auto-recovery"]';

function defaultExperimentalSettings(): InstanceExperimentalSettingsPayload {
  return {
    enableEnvironments: false,
    enableIsolatedWorkspaces: false,
    enableStreamlinedLeftNavigation: true,
    enableApps: false,
    enablePipelines: false,
    enableCases: false,
    enableConferenceRoomChat: false,
    enableIssuePlanDecompositions: false,
    enableExperimentalFileViewer: false,
    enableExternalObjects: false,
    enableBuiltInAgents: false,
    enableSummaries: false,
    enableDecisions: false,
    enableGoalsSidebarLink: false,
    enableTaskWatchdogs: false,
    enableCloudSync: false,
    enableServerInfoDebugView: false,
    enableSmokeLab: false,
    autoRestartDevServerWhenIdle: false,
    enableIssueGraphLivenessAutoRecovery: false,
    issueGraphLivenessAutoRecoveryLookbackHours: 24,
    enableWorkspaceBranchReconcileForward: true,
    enableWorkspaceDirtyQuarantineRepair: true,
    enableWorktreeRunExecution: false,
    worktreeRunExecutionActivatedAt: null,
    worktreeRunExecutionActivationInstanceId: null,
  };
}

function emptyRecoveryPreview(): IssueGraphLivenessAutoRecoveryPreview {
  return {
    lookbackHours: 24,
    cutoff: "2026-07-12T16:00:00.000Z",
    generatedAt: "2026-07-13T16:00:00.000Z",
    findings: 0,
    recoverableFindings: 0,
    skippedOutsideLookback: 0,
    items: [],
  };
}

const WORKTREE_RUN_EXECUTION_TOGGLE_SELECTOR =
  'button[aria-label="Toggle worktree run execution setting"]';

function setWorktreeRuntimeMeta(enabled: boolean) {
  const name = "paperclip-worktree-enabled";
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (enabled) {
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", name);
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", "true");
  } else if (meta) {
    meta.remove();
  }
}

function setWorktreeInstanceIdMeta(instanceId: string | null) {
  const name = "paperclip-instance-id";
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (instanceId) {
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", name);
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", instanceId);
  } else if (meta) {
    meta.remove();
  }
}

describe("InstanceExperimentalSettings — Conference Room Chat card (PAP-11233)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let currentExperimentalSettings: InstanceExperimentalSettingsPayload;

  async function renderPage() {
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <InstanceExperimentalSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentExperimentalSettings = defaultExperimentalSettings();
    mockInstanceSettingsApi.getExperimental.mockImplementation(async () => ({
      ...currentExperimentalSettings,
    }));
    mockInstanceSettingsApi.updateExperimental.mockImplementation(async (patch) => {
      currentExperimentalSettings = { ...currentExperimentalSettings, ...patch };
      return { ...currentExperimentalSettings };
    });
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    setWorktreeRuntimeMeta(false);
    setWorktreeInstanceIdMeta(null);
    vi.clearAllMocks();
  });

  it("renders a page-level warning about instability and lack of guarantees", async () => {
    await renderPage();

    const warning = [...container.querySelectorAll('[role="alert"]')].find((alert) =>
      alert.textContent?.includes("Experimental features may break at any time."),
    );
    expect(warning?.textContent).toContain("Experimental features may break at any time.");
    expect(warning?.textContent).toContain("no compatibility guarantees");
  });

  it("enables the Apps UI from experimental settings", async () => {
    await renderPage();

    const toggle = container.querySelector<HTMLButtonElement>(APPS_TOGGLE_SELECTOR);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await act(() => toggle?.click());
    await flushReact();

    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({ enableApps: true });
    expect(container.querySelector(APPS_TOGGLE_SELECTOR)?.getAttribute("aria-checked")).toBe("true");
  });

  it("does not render the Conference Room Chat experimental setting for now", async () => {
    await renderPage();

    const headings = [...container.querySelectorAll("section h2")].map((h) => h.textContent);
    expect(headings).not.toContain("Conference Room Chat");
    expect(container.querySelector(CONFERENCE_TOGGLE_SELECTOR)).toBeNull();
  });

  it("does not render the Pipelines experimental setting for now", async () => {
    await renderPage();

    const headings = [...container.querySelectorAll("section h2")].map((h) => h.textContent);
    expect(headings).not.toContain("Pipelines");
    expect(container.querySelector('button[aria-label="Toggle pipelines experimental setting"]')).toBeNull();
  });

  it("does not render the toggle even when the stored flag is currently enabled", async () => {
    currentExperimentalSettings = {
      ...currentExperimentalSettings,
      enableConferenceRoomChat: true,
    };
    await renderPage();

    const toggle = container.querySelector(CONFERENCE_TOGGLE_SELECTOR);
    expect(toggle).toBeNull();
    expect(mockInstanceSettingsApi.updateExperimental).not.toHaveBeenCalled();
  });

  it("no longer renders the Streamlined Left Navigation toggle (opt-out retired, PAP-12472)", async () => {
    await renderPage();

    const headings = [...container.querySelectorAll("section h2")].map((h) => h.textContent);
    expect(headings).not.toContain("Streamlined Left Navigation Bar");
    expect(container.querySelector(STREAMLINED_TOGGLE_SELECTOR)).toBeNull();
    expect(mockInstanceSettingsApi.updateExperimental).not.toHaveBeenCalled();
  });

  it("renders and patches the Task Watchdogs experimental toggle on and off", async () => {
    await renderPage();

    expect(container.textContent).toContain("Task Watchdogs");
    expect(container.textContent).toContain(
      "Show task detail controls for configuring watchdog agents that verify stopped task subtrees and restore live paths when work should continue.",
    );

    const toggle = container.querySelector<HTMLButtonElement>(TASK_WATCHDOGS_TOGGLE_SELECTOR);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle?.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({
      enableTaskWatchdogs: true,
    });
    expect(toggle?.getAttribute("aria-checked")).toBe("true");

    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.textContent = "";
    await renderPage();

    const enabledToggle = container.querySelector<HTMLButtonElement>(TASK_WATCHDOGS_TOGGLE_SELECTOR);
    expect(enabledToggle?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      enabledToggle?.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenLastCalledWith({
      enableTaskWatchdogs: false,
    });
  });

  it("renders and patches the Decisions experimental toggle", async () => {
    await renderPage();

    expect(container.textContent).toContain("Decisions");
    expect(container.textContent).toContain(
      "Show the Decisions item in the main sidebar",
    );

    const toggle = container.querySelector<HTMLButtonElement>(DECISIONS_TOGGLE_SELECTOR);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle?.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({
      enableDecisions: true,
    });
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("renders and patches the Goals Sidebar Link experimental toggle", async () => {
    await renderPage();

    expect(container.textContent).toContain("Goals Sidebar Link");
    expect(container.textContent).toContain(
      "Restore the Goals item in the main sidebar while the goals surface is being evaluated.",
    );

    const toggle = container.querySelector<HTMLButtonElement>(GOALS_SIDEBAR_LINK_TOGGLE_SELECTOR);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle?.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({
      enableGoalsSidebarLink: true,
    });
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("hides the worktree run-execution toggle when not running in a worktree", async () => {
    setWorktreeRuntimeMeta(false);
    await renderPage();

    const headings = [...container.querySelectorAll("section h2")].map((h) => h.textContent);
    expect(headings).not.toContain("Run tasks in this worktree");
    expect(container.querySelector(WORKTREE_RUN_EXECUTION_TOGGLE_SELECTOR)).toBeNull();
  });

  it("renders and patches the worktree run-execution toggle when in a worktree", async () => {
    setWorktreeRuntimeMeta(true);
    await renderPage();

    expect(container.textContent).toContain("Run tasks in this worktree");
    expect(container.textContent).toContain(
      "isolated git-worktree preview instance",
    );

    const toggle = container.querySelector<HTMLButtonElement>(WORKTREE_RUN_EXECUTION_TOGGLE_SELECTOR);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle?.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({
      enableWorktreeRunExecution: true,
    });
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("shows the cutoff-copy for the worktree run-execution toggle when off", async () => {
    setWorktreeRuntimeMeta(true);
    await renderPage();

    expect(container.textContent).toContain(
      "Only tasks created after enabling will run automatically",
    );
    expect(container.textContent).toContain("Toggling off and on resets the cutoff.");
    // Off => no armed banner and no fail-closed hint.
    expect(container.textContent).not.toContain("Running tasks created after");
    expect(container.textContent).not.toContain("Execution is suppressed");
  });

  it("shows the armed timestamp when the flag matches the current instance", async () => {
    setWorktreeRuntimeMeta(true);
    setWorktreeInstanceIdMeta("inst-current");
    currentExperimentalSettings = {
      ...currentExperimentalSettings,
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: "2026-07-10T18:34:00.000Z",
      worktreeRunExecutionActivationInstanceId: "inst-current",
    };
    await renderPage();

    expect(container.textContent).toContain("Running tasks created after");
    expect(container.textContent).not.toContain("Execution is suppressed");
    const toggle = container.querySelector<HTMLButtonElement>(WORKTREE_RUN_EXECUTION_TOGGLE_SELECTOR);
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("fails closed with a re-enable hint when the flag was armed in another instance", async () => {
    setWorktreeRuntimeMeta(true);
    setWorktreeInstanceIdMeta("inst-current");
    currentExperimentalSettings = {
      ...currentExperimentalSettings,
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: "2026-07-10T18:34:00.000Z",
      worktreeRunExecutionActivationInstanceId: "inst-other",
    };
    await renderPage();

    expect(container.textContent).toContain("Execution is suppressed");
    expect(container.textContent).toContain("armed in a different instance");
    expect(container.textContent).toContain("Toggle it off and back on");
    expect(container.textContent).not.toContain("Running tasks created after");
  });

  it("fails closed with a re-enable hint when the activation cutoff is missing", async () => {
    setWorktreeRuntimeMeta(true);
    setWorktreeInstanceIdMeta("inst-current");
    currentExperimentalSettings = {
      ...currentExperimentalSettings,
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
    };
    await renderPage();

    expect(container.textContent).toContain("Execution is suppressed");
    expect(container.textContent).toContain("missing its activation cutoff");
    expect(container.textContent).not.toContain("Running tasks created after");
  });

  it("renders and patches the Built-in Agents experimental toggle", async () => {
    await renderPage();

    expect(container.textContent).toContain("Built-in Agents");
    expect(container.textContent).toContain("Show Paperclip-managed built-in agent surfaces");

    const toggle = container.querySelector<HTMLButtonElement>(BUILT_IN_AGENTS_TOGGLE_SELECTOR);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle?.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({
      enableBuiltInAgents: true,
    });
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("renders and patches the Summaries experimental toggle", async () => {
    await renderPage();

    expect(container.textContent).toContain("Summaries");
    expect(container.textContent).toContain("Show Summarizer-generated status slots");

    const toggle = container.querySelector<HTMLButtonElement>(SUMMARIES_TOGGLE_SELECTOR);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle?.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({
      enableSummaries: true,
    });
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("renders and patches the Server Info Debug View experimental toggle", async () => {
    await renderPage();

    expect(container.textContent).toContain("Server Info Debug View");
    expect(container.textContent).toContain(
      'Show a "Server" section in the account drawer with the current server restart time and running commit.',
    );

    const toggle = container.querySelector<HTMLButtonElement>(SERVER_INFO_TOGGLE_SELECTOR);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle?.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({
      enableServerInfoDebugView: true,
    });
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("removes the auto-recovery confirmation overlay after enabling only", async () => {
    mockInstanceSettingsApi.previewIssueGraphLivenessAutoRecovery.mockResolvedValue(emptyRecoveryPreview());
    await renderPage();

    const toggle = container.querySelector<HTMLButtonElement>(AUTO_RECOVERY_TOGGLE_SELECTOR);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle?.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.previewIssueGraphLivenessAutoRecovery).toHaveBeenCalledWith({
      lookbackHours: 24,
    });
    expect(document.body.textContent).toContain("Confirm auto-recovery");
    expect(document.body.querySelector('[data-slot="dialog-overlay"]')).not.toBeNull();

    const enableOnlyButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Enable only",
    );

    await act(async () => {
      enableOnlyButton?.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });
    expect(document.body.textContent).not.toContain("Confirm auto-recovery");
    expect(document.body.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    const enabledToggle = container.querySelector<HTMLButtonElement>(AUTO_RECOVERY_TOGGLE_SELECTOR);
    expect(enabledToggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("removes the auto-recovery confirmation overlay after enabling and running", async () => {
    mockInstanceSettingsApi.previewIssueGraphLivenessAutoRecovery.mockResolvedValue(emptyRecoveryPreview());
    mockInstanceSettingsApi.runIssueGraphLivenessAutoRecovery.mockResolvedValue({
      findings: 0,
      autoRecoveryEnabled: true,
      lookbackHours: 24,
      cutoff: "2026-07-12T16:00:00.000Z",
      escalationsCreated: 0,
      existingEscalations: 0,
      skipped: 0,
      skippedAutoRecoveryDisabled: 0,
    });
    await renderPage();

    const toggle = container.querySelector<HTMLButtonElement>(AUTO_RECOVERY_TOGGLE_SELECTOR);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle?.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("Confirm auto-recovery");
    expect(document.body.querySelector('[data-slot="dialog-overlay"]')).not.toBeNull();

    const enableAndRunButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Enable",
    );

    await act(async () => {
      enableAndRunButton?.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });
    expect(mockInstanceSettingsApi.runIssueGraphLivenessAutoRecovery).toHaveBeenCalledWith({
      lookbackHours: 24,
    });
    expect(document.body.textContent).not.toContain("Confirm auto-recovery");
    expect(document.body.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    const enabledToggle = container.querySelector<HTMLButtonElement>(AUTO_RECOVERY_TOGGLE_SELECTOR);
    expect(enabledToggle?.getAttribute("aria-checked")).toBe("true");
  });
});

describe("InstanceExperimentalSettings — cloud-managed keys", () => {
  const MANAGED_BADGE_TEXT = "Managed by Paperclip Cloud";

  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  async function renderPage(settings: InstanceExperimentalSettingsWithManaged) {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ ...settings });
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <InstanceExperimentalSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockInstanceSettingsApi.updateExperimental.mockImplementation(async (patch) => ({
      ...defaultExperimentalSettings(),
      ...patch,
    }));
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders a managed key locked with the badge while unmanaged keys stay editable", async () => {
    await renderPage({
      ...defaultExperimentalSettings(),
      enableApps: true,
      managedKeys: {
        enableApps: { managed: true, managedBy: "paperclip-cloud" },
      },
    });

    expect(container.textContent).toContain(MANAGED_BADGE_TEXT);

    const appsToggle = container.querySelector<HTMLButtonElement>(APPS_TOGGLE_SELECTOR);
    expect(appsToggle?.getAttribute("aria-checked")).toBe("true");
    expect(appsToggle?.disabled).toBe(true);

    await act(() => appsToggle?.click());
    await flushReact();
    expect(mockInstanceSettingsApi.updateExperimental).not.toHaveBeenCalled();

    const summariesToggle = container.querySelector<HTMLButtonElement>(SUMMARIES_TOGGLE_SELECTOR);
    expect(summariesToggle?.disabled).toBe(false);

    await act(() => summariesToggle?.click());
    await flushReact();
    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({
      enableSummaries: true,
    });
  });

  it("locks the managed auto-recovery toggle without opening the preview dialog", async () => {
    await renderPage({
      ...defaultExperimentalSettings(),
      managedKeys: {
        enableIssueGraphLivenessAutoRecovery: { managed: true, managedBy: "paperclip-cloud" },
      },
    });

    const toggle = container.querySelector<HTMLButtonElement>(AUTO_RECOVERY_TOGGLE_SELECTOR);
    expect(toggle?.disabled).toBe(true);

    await act(() => toggle?.click());
    await flushReact();

    expect(mockInstanceSettingsApi.previewIssueGraphLivenessAutoRecovery).not.toHaveBeenCalled();
    expect(mockInstanceSettingsApi.updateExperimental).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Confirm auto-recovery");
  });

  it("closes an open recovery preview when a refresh marks auto-recovery as managed", async () => {
    mockInstanceSettingsApi.previewIssueGraphLivenessAutoRecovery.mockResolvedValue(
      emptyRecoveryPreview(),
    );
    const settings = defaultExperimentalSettings();
    await renderPage(settings);

    const toggle = container.querySelector<HTMLButtonElement>(AUTO_RECOVERY_TOGGLE_SELECTOR);
    await act(() => toggle?.click());
    await flushReact();
    expect(document.body.textContent).toContain("Confirm auto-recovery");

    const managedSettings: InstanceExperimentalSettingsWithManaged = {
      ...settings,
      enableIssueGraphLivenessAutoRecovery: true,
      managedKeys: {
        enableIssueGraphLivenessAutoRecovery: { managed: true, managedBy: "paperclip-cloud" },
      },
    };
    await act(() => {
      queryClient.setQueryData(queryKeys.instance.experimentalSettings, managedSettings);
    });
    await flushReact();

    expect(document.body.textContent).not.toContain("Confirm auto-recovery");
    expect(document.body.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(mockInstanceSettingsApi.updateExperimental).not.toHaveBeenCalled();
    expect(mockInstanceSettingsApi.runIssueGraphLivenessAutoRecovery).not.toHaveBeenCalled();

    const lockedToggle = container.querySelector<HTMLButtonElement>(AUTO_RECOVERY_TOGGLE_SELECTOR);
    expect(lockedToggle?.disabled).toBe(true);
  });

  it("renders no managed badge and keeps toggles editable without managedKeys (self-hosted)", async () => {
    await renderPage(defaultExperimentalSettings());

    expect(container.textContent).not.toContain(MANAGED_BADGE_TEXT);

    const appsToggle = container.querySelector<HTMLButtonElement>(APPS_TOGGLE_SELECTOR);
    expect(appsToggle?.disabled).toBe(false);

    await act(() => appsToggle?.click());
    await flushReact();
    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({ enableApps: true });
  });
});

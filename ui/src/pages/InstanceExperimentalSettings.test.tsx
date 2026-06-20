// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstanceExperimentalSettings as InstanceExperimentalSettingsPayload } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceExperimentalSettings } from "./InstanceExperimentalSettings";

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
const TASK_WATCHDOGS_TOGGLE_SELECTOR =
  'button[aria-label="Toggle task watchdogs experimental setting"]';

function defaultExperimentalSettings(): InstanceExperimentalSettingsPayload {
  return {
    enableEnvironments: false,
    enableIsolatedWorkspaces: false,
    enableStreamlinedLeftNavigation: false,
    enableConferenceRoomChat: false,
    enableIssuePlanDecompositions: false,
    enableExperimentalFileViewer: false,
    enableTaskWatchdogs: false,
    enablePrLinks: false,
    enableCloudSync: false,
    autoRestartDevServerWhenIdle: false,
    enableIssueGraphLivenessAutoRecovery: false,
    issueGraphLivenessAutoRecoveryLookbackHours: 24,
  };
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
    vi.clearAllMocks();
  });

  it("does not render the Conference Room Chat experimental setting for now", async () => {
    await renderPage();

    const headings = [...container.querySelectorAll("section h2")].map((h) => h.textContent);
    expect(headings).toContain("Streamlined Left Navigation Bar");
    expect(headings).not.toContain("Conference Room Chat");
    expect(container.querySelector(CONFERENCE_TOGGLE_SELECTOR)).toBeNull();
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
});

// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

const CONFERENCE_TOGGLE_SELECTOR =
  'button[aria-label="Toggle conference room chat experimental setting"]';

describe("InstanceExperimentalSettings — Conference Room Chat card (PAP-137)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

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
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableConferenceRoomChat: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });
    mockInstanceSettingsApi.updateExperimental.mockResolvedValue({});
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the card with the approved copy, placed right after Streamlined Left Navigation Bar", async () => {
    await renderPage();

    expect(container.textContent).toContain("Conference Room Chat");
    expect(container.textContent).toContain(
      "Adds a Conference Room — one chat where you and your whole team work together — plus the live activity feed and the redesigned onboarding. Also restyles task threads as chat bubbles. Turn off anytime to restore the classic UI.",
    );

    const headings = [...container.querySelectorAll("section h2")].map((h) => h.textContent);
    const streamlinedIndex = headings.indexOf("Streamlined Left Navigation Bar");
    const conferenceIndex = headings.indexOf("Conference Room Chat");
    expect(streamlinedIndex).toBeGreaterThanOrEqual(0);
    expect(conferenceIndex).toBe(streamlinedIndex + 1);
  });

  it("toggle reflects the loaded flag value", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableConferenceRoomChat: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });
    await renderPage();

    const toggle = container.querySelector(CONFERENCE_TOGGLE_SELECTOR);
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("clicking the toggle patches enableConferenceRoomChat on", async () => {
    await renderPage();

    const toggle = container.querySelector<HTMLButtonElement>(CONFERENCE_TOGGLE_SELECTOR);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle?.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({
      enableConferenceRoomChat: true,
    });
  });

  it("clicking the toggle patches enableConferenceRoomChat off when currently on", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableConferenceRoomChat: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });
    await renderPage();

    const toggle = container.querySelector<HTMLButtonElement>(CONFERENCE_TOGGLE_SELECTOR);
    await act(async () => {
      toggle?.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({
      enableConferenceRoomChat: false,
    });
  });
});

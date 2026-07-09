// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarServerInfo } from "./SidebarServerInfo";

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

async function flushReact() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function mockEnabledSettings(enabled: boolean) {
  mockInstanceSettingsApi.getExperimental.mockResolvedValue({
    enableServerInfoDebugView: enabled,
  });
}

describe("SidebarServerInfo", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <SidebarServerInfo />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHealthApi.get.mockReset();
    mockInstanceSettingsApi.getExperimental.mockReset();
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it("renders nothing while the experimental flag is disabled", async () => {
    mockEnabledSettings(false);

    await render();

    expect(container.textContent).toBe("");
    expect(mockHealthApi.get).not.toHaveBeenCalled();
  });

  it("shows restart and commit rows from health data when enabled", async () => {
    mockEnabledSettings(true);
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      devServer: {
        enabled: true,
        restartRequired: false,
        reason: null,
        lastChangedAt: null,
        changedPathCount: 0,
        changedPathsSample: [],
        pendingMigrations: [],
        autoRestartEnabled: false,
        activeRunCount: 0,
        waitingForIdle: false,
        lastRestartAt: "2026-06-26T01:15:00.000Z",
      },
      serverInfo: {
        processStartedAt: "2026-06-26T00:00:00.000Z",
        git: {
          available: true,
          fullSha: "abcdef1234567890abcdef1234567890abcdef12",
          shortSha: "abcdef1",
          subject: "Add server info debug view",
          committedAt: "2026-06-25T23:00:00.000Z",
        },
      },
    });

    await render();

    expect(container.textContent).toContain("Last restarted");
    expect(container.textContent).toContain("Running commit");
    expect(container.querySelector('time[dateTime="2026-06-26T01:15:00.000Z"]')).not.toBeNull();
    expect(container.textContent).toContain("abcdef1");
    expect(container.textContent).toContain("Add server info debug view");
  });

  it("falls back to process start and unavailable commit copy", async () => {
    mockEnabledSettings(true);
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      serverInfo: {
        processStartedAt: "2026-06-26T00:00:00.000Z",
        git: {
          available: false,
          unavailableReason: "git_unavailable",
        },
      },
    });

    await render();

    expect(container.querySelector('time[dateTime="2026-06-26T00:00:00.000Z"]')).not.toBeNull();
    expect(container.textContent).toContain("Commit unavailable");
  });
});

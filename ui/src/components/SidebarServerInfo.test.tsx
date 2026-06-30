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

async function flushReactMicrotasks() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
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
    vi.useRealTimers();
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
          localChanges: {
            available: true,
            hasLocalChanges: false,
            stagedFileCount: 0,
            unstagedFileCount: 0,
            untrackedFileCount: 0,
          },
        },
      },
    });

    await render();

    expect(container.textContent).toContain("Last restarted");
    expect(container.textContent).toContain("Running commit");
    expect(container.textContent).toContain("Checkout state");
    expect(container.querySelector('time[dateTime="2026-06-26T01:15:00.000Z"]')).not.toBeNull();
    expect(container.textContent).toContain("abcdef1");
    expect(container.textContent).toContain("Add server info debug view");
    expect(container.textContent).toContain("Clean checkout");
  });

  it("polls health while the drawer is open and the dev server is active", async () => {
    vi.useFakeTimers();
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
          localChanges: {
            available: true,
            hasLocalChanges: false,
            stagedFileCount: 0,
            unstagedFileCount: 0,
            untrackedFileCount: 0,
          },
        },
      },
    });

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
    await flushReactMicrotasks();

    expect(mockHealthApi.get).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    await flushReactMicrotasks();

    expect(mockHealthApi.get).toHaveBeenCalledTimes(2);
  });

  it("shows path-free local change counts from health data", async () => {
    mockEnabledSettings(true);
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      serverInfo: {
        processStartedAt: "2026-06-26T00:00:00.000Z",
        git: {
          available: true,
          fullSha: "abcdef1234567890abcdef1234567890abcdef12",
          shortSha: "abcdef1",
          subject: "Add server info debug view",
          committedAt: "2026-06-25T23:00:00.000Z",
          localChanges: {
            available: true,
            hasLocalChanges: true,
            stagedFileCount: 3,
            unstagedFileCount: 2,
            untrackedFileCount: 1,
          },
        },
      },
    });

    await render();

    expect(container.textContent).toContain("Local changes present (3 staged, 2 unstaged, 1 untracked)");
    expect(container.textContent).not.toContain("server-info.ts");
  });

  it("refetches fresh health each time the drawer reopens, even within staleTime", async () => {
    mockEnabledSettings(true);
    const baseHealth = {
      status: "ok" as const,
      serverInfo: {
        processStartedAt: "2026-06-26T00:00:00.000Z",
        git: {
          available: true,
          fullSha: "1111111111111111111111111111111111111111",
          shortSha: "1111111",
          subject: "First boot",
          committedAt: "2026-06-25T23:00:00.000Z",
          localChanges: {
            available: true,
            hasLocalChanges: false,
            stagedFileCount: 0,
            unstagedFileCount: 0,
            untrackedFileCount: 0,
          },
        },
      },
    };
    mockHealthApi.get.mockResolvedValue(baseHealth);

    // A long staleTime mirrors the production QueryClient: without
    // refetchOnMount "always", reopening the drawer would show cached data.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });

    async function mountDrawer() {
      const drawerRoot = createRoot(container);
      flushSync(() => {
        drawerRoot.render(
          <QueryClientProvider client={queryClient}>
            <SidebarServerInfo />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      return drawerRoot;
    }

    const firstOpen = await mountDrawer();
    expect(container.textContent).toContain("First boot");
    flushSync(() => firstOpen.unmount());

    // Server restarted: a fresh commit and process start should appear on reopen.
    mockHealthApi.get.mockResolvedValue({
      ...baseHealth,
      serverInfo: {
        processStartedAt: "2026-06-26T02:00:00.000Z",
        git: {
          available: true,
          fullSha: "2222222222222222222222222222222222222222",
          shortSha: "2222222",
          subject: "After restart",
          committedAt: "2026-06-26T01:30:00.000Z",
          localChanges: {
            available: true,
            hasLocalChanges: true,
            stagedFileCount: 1,
            unstagedFileCount: 0,
            untrackedFileCount: 0,
          },
        },
      },
    });

    const secondOpen = await mountDrawer();
    expect(container.textContent).toContain("After restart");
    expect(container.textContent).toContain("Local changes present (1 staged)");
    expect(container.textContent).not.toContain("First boot");
    flushSync(() => secondOpen.unmount());
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

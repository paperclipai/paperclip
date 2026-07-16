// @vitest-environment jsdom

import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevRestartBanner } from "./DevRestartBanner";
import type { DevServerHealthStatus } from "../api/health";

const mockHealthApi = vi.hoisted(() => ({
  requestDevServerRestart: vi.fn(),
}));

vi.mock("../api/health", () => ({
  healthApi: mockHealthApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

const devServer: DevServerHealthStatus = {
  enabled: true as const,
  restartRequired: true,
  reason: "backend_changes" as const,
  lastChangedAt: "2026-03-20T12:00:00.000Z",
  changedPathCount: 1,
  changedPathsSample: ["server/src/routes/health.ts"],
  pendingMigrations: [],
  autoRestartEnabled: true,
  activeRunCount: 1,
  waitingForIdle: true,
  lastRestartAt: "2026-03-20T11:30:00.000Z",
  hotRestartEnabled: false,
  eligibleLiveRunCount: 0,
  adoptionReport: null,
};

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "alert").mockImplementation(() => undefined);
  mockHealthApi.requestDevServerRestart.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  mockHealthApi.requestDevServerRestart.mockReset();
});

function render(overrides: Partial<DevServerHealthStatus> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<DevRestartBanner devServer={{ ...devServer, ...overrides }} />));
  return container;
}

describe("DevRestartBanner", () => {
  it("confirms and requests an immediate restart while waiting for live runs", async () => {
    const node = render();
    const button = [...node.querySelectorAll("button")]
      .find((entry) => entry.textContent?.includes("Restart now"));

    expect(node.textContent).toContain("Waiting for 1 live run to finish");
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(window.confirm).toHaveBeenCalledWith("Restart Paperclip now? This may interrupt 1 live run.");
    expect(mockHealthApi.requestDevServerRestart).toHaveBeenCalledTimes(1);
    expect(node.textContent).toContain("Restart requested");
  });

  it("does not request restart when confirmation is declined", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const node = render();
    const button = [...node.querySelectorAll("button")]
      .find((entry) => entry.textContent?.includes("Restart now"));

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockHealthApi.requestDevServerRestart).not.toHaveBeenCalled();
  });

  it("re-enables the manual restart action when a request does not refresh the page", async () => {
    vi.useFakeTimers();
    const node = render();
    const button = [...node.querySelectorAll("button")]
      .find((entry) => entry.textContent?.includes("Restart now")) as HTMLButtonElement | undefined;

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(button?.disabled).toBe(true);
    expect(node.textContent).toContain("Restart requested");

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(button?.disabled).toBe(false);
    expect(node.textContent).toContain("Restart now");
  });

  it("hides the hot restart action when the setting is off", () => {
    const node = render({ hotRestartEnabled: false });
    const hotButton = [...node.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Hot restart"),
    );
    expect(hotButton).toBeUndefined();
    // Default restart action is always present and unchanged.
    expect([...node.querySelectorAll("button")].some((b) => b.textContent?.includes("Restart now"))).toBe(true);
  });

  it("shows the hot restart action with the eligible run count and requests a hot restart", async () => {
    const node = render({ hotRestartEnabled: true, eligibleLiveRunCount: 3 });
    const hotButton = [...node.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Hot restart"),
    );
    expect(hotButton?.textContent).toContain("Hot restart (keeps 3 live runs)");

    await act(async () => {
      hotButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(window.confirm).toHaveBeenCalledWith(
      "Hot restart Paperclip now? Your 3 live runs keep running and will be adopted by the new server.",
    );
    expect(mockHealthApi.requestDevServerRestart).toHaveBeenCalledWith({ hot: true });
    expect(node.textContent).toContain("Hot restart requested");
  });

  it("surfaces the adoption report after a fresh boot with no restart pending", () => {
    const node = render({
      restartRequired: false,
      adoptionReport: {
        completedAt: "2026-03-20T12:05:00.000Z",
        newServerVersion: "abc1234",
        adopted: 2,
        finalizedWhileDown: 1,
        lost: 0,
      },
    });
    expect(node.textContent).toContain("Hot restart complete");
    expect(node.textContent).toContain("2");
    expect(node.textContent).toContain("adopted");
    expect(node.textContent).toContain("finalized while down");
    expect(node.textContent).toContain("abc1234");

    const dismiss = [...node.querySelectorAll("button")].find((entry) =>
      entry.getAttribute("aria-label") === "Dismiss hot restart report",
    );
    act(() => dismiss?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(node.textContent).not.toContain("Hot restart complete");
  });
});

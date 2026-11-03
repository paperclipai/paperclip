// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevRestartBanner } from "./DevRestartBanner";
import { setLocale } from "@/i18n";

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

const devServer = {
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
};

beforeEach(() => {
  setLocale("en");
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
  setLocale("en");
});

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<DevRestartBanner devServer={devServer} />));
  return container;
}

describe("DevRestartBanner", () => {
  it.each([[1, "текущий запуск"], [2, "текущих запуска"], [5, "текущих запусков"], [21, "текущий запуск"], [22, "текущих запуска"], [25, "текущих запусков"]])("keeps the restart warning and raw file paths while switching locale (%i)", async (count, word) => {
    const node = render();
    await act(async () => root?.render(<DevRestartBanner devServer={{ ...devServer, activeRunCount: Number(count) }} />));
    await act(async () => setLocale("ru"));
    expect(node.textContent).toContain("Требуется перезапуск");
    expect(node.textContent).toContain("server/src/routes/health.ts");
    expect(mockHealthApi.requestDevServerRestart).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    await act(async () => node.querySelector("button")?.click());
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith(`Перезапустить Paperclip сейчас? Это может прервать ${count} ${word}.`);
    expect(mockHealthApi.requestDevServerRestart).toHaveBeenCalledTimes(1);
    await act(async () => setLocale("en"));
    expect(node.textContent).toContain("Restart requested");
    expect(node.querySelector("button")?.disabled).toBe(true);
  });

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
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevServerHealthStatus } from "../api/health";
import { DevRestartBanner } from "./DevRestartBanner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createDevServer(overrides: Partial<DevServerHealthStatus> = {}): DevServerHealthStatus {
  return {
    enabled: true,
    restartRequired: true,
    reason: "backend_changes",
    lastChangedAt: "2026-04-20T12:00:00.000Z",
    changedPathCount: 1,
    changedPathsSample: ["server/src/app.ts"],
    pendingMigrations: [],
    autoRestartEnabled: false,
    activeRunCount: 0,
    waitingForIdle: false,
    lastRestartAt: "2026-04-20T11:55:00.000Z",
    ...overrides,
  };
}

describe("DevRestartBanner", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders a restart button and invokes the callback", () => {
    const root = createRoot(container);
    const onRestart = vi.fn();

    act(() => {
      root.render(<DevRestartBanner devServer={createDevServer()} onRestart={onRestart} />);
    });

    const button = container.querySelector("button");
    expect(button?.textContent).toContain("Restart now");

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRestart).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("shows the requested state while a restart is pending", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <DevRestartBanner
          devServer={createDevServer({ waitingForIdle: true, activeRunCount: 2 })}
          onRestart={() => undefined}
          restartRequested
        />,
      );
    });

    expect(container.textContent).toContain("Restart requested");
    expect(container.textContent).toContain("interrupt 2 live runs");

    const button = container.querySelector("button");
    expect(button?.getAttribute("disabled")).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceServiceControlBar } from "./WorkspaceServiceControlBar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("WorkspaceServiceControlBar", () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(async () => {
    await act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function renderRunningService() {
    await act(() => {
      root.render(
        <WorkspaceServiceControlBar
          services={[{
            key: "web",
            name: "Web",
            state: "running",
            healthStatus: "healthy",
            url: "http://127.0.0.1:3100",
          }]}
          onAction={() => {}}
        />,
      );
    });
    return container.querySelector<HTMLButtonElement>('button[aria-label="Copy URL"]')!;
  }

  it("shows success only after the URL reaches the clipboard", async () => {
    const copyButton = await renderRunningService();

    await act(async () => {
      copyButton.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:3100");
    expect(copyButton.getAttribute("aria-label")).toBe("URL copied");
  });

  it("shows failure when the clipboard rejects the write", async () => {
    writeText.mockRejectedValueOnce(new Error("permission denied"));
    const copyButton = await renderRunningService();

    await act(async () => {
      copyButton.click();
      await Promise.resolve();
    });

    expect(copyButton.getAttribute("aria-label")).toBe("Copy failed");
    expect(copyButton.querySelector(".text-destructive")).not.toBeNull();
  });

  it("reserves the desktop URL segment across service states", async () => {
    const renderService = async (state: "stopped" | "running", url: string | null) => {
      await act(() => {
        root.render(
          <WorkspaceServiceControlBar
            services={[{
              key: "web",
              name: "Web",
              state,
              healthStatus: state === "running" ? "healthy" : null,
              url,
              port: 3100,
            }]}
            onAction={() => {}}
          />,
        );
      });

      return container.querySelector<HTMLElement>("[data-service-endpoint-segment]");
    };

    const stoppedSegment = await renderService("stopped", null);
    expect(stoppedSegment).not.toBeNull();
    expect(stoppedSegment?.classList.contains("w-56")).toBe(true);
    expect(stoppedSegment?.classList.contains("shrink-0")).toBe(true);

    const runningSegment = await renderService("running", "http://127.0.0.1:3100");
    expect(runningSegment).not.toBeNull();
    expect(runningSegment?.className).toBe(stoppedSegment?.className);
  });

  it("shows inherited desired and actual state with one safe recovery action", async () => {
    const onAction = vi.fn();
    const onViewOperation = vi.fn();
    await act(() => {
      root.render(
        <WorkspaceServiceControlBar
          services={[{
            key: "web",
            name: "Web",
            state: "failed",
            actualState: "failed",
            desiredState: "running",
            configSource: { type: "project_workspace", id: "project-workspace-1" },
            healthStatus: "unknown",
            port: 4310,
            url: null,
            latestFailure: {
              operationId: "operation-1",
              operationLogPath: "runtime-operations/operation-1.log",
              code: "PORT_COLLISION",
              message: "Port 4310 is already allocated to another managed workspace.",
              remediation: "Choose another port or stop that workspace first.",
              details: { port: 4310 },
              failedAt: new Date("2026-08-12T14:00:00.000Z"),
            },
          }]}
          onAction={onAction}
          onViewOperation={onViewOperation}
        />,
      );
    });

    expect(container.textContent).toContain("Inherited from project workspace");
    expect(container.textContent).toContain("Actual: Failed");
    expect(container.textContent).toContain("Desired: Running");
    expect(container.textContent).toContain("Health: Not reporting");
    expect(container.textContent).toContain("Couldn’t start Web on port 4310");
    expect(container.textContent).toContain("Choose another port or stop that workspace first.");
    expect(container.textContent).toContain("Paperclip will not stop another workspace.");
    expect(container.querySelectorAll('button[aria-label="Retry"]')).toHaveLength(1);
    expect(container.querySelector('button[aria-label="Retry"]')?.getAttribute("data-size")).toBe("sm");
    expect(container.querySelector('button[aria-label="Start"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Restart"]')).toBeNull();

    await act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Retry"]')!.click();
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "View operation")!
        .click();
    });
    expect(onAction).toHaveBeenCalledWith("start", "web");
    expect(onViewOperation).toHaveBeenCalledWith("operation-1");
  });

  it("keeps Retry on the same labeled control while recovery is pending", async () => {
    await act(() => {
      root.render(
        <WorkspaceServiceControlBar
          services={[{
            key: "web",
            name: "Web",
            state: "retrying",
            actualState: "failed",
            desiredState: "running",
            port: 4310,
          }]}
          onAction={() => {}}
        />,
      );
    });

    const retryingButton = container.querySelector<HTMLButtonElement>('button[aria-label="Retrying…"]');
    expect(retryingButton).not.toBeNull();
    expect(retryingButton?.disabled).toBe(true);
    expect(retryingButton?.getAttribute("data-size")).toBe("sm");
    expect(retryingButton?.getAttribute("aria-live")).toBe("polite");
    expect(retryingButton?.getAttribute("aria-busy")).toBe("true");
    expect(container.textContent).toContain("Actual: Failed");
  });

  it("keeps failed services visible in the multi-service summary", async () => {
    await act(() => {
      root.render(
        <WorkspaceServiceControlBar
          services={[
            {
              key: "web",
              name: "Web",
              state: "running",
              actualState: "running",
              desiredState: "running",
              url: "http://127.0.0.1:4310",
              port: 4310,
            },
            {
              key: "worker",
              name: "Worker",
              state: "failed",
              actualState: "failed",
              desiredState: "running",
            },
          ]}
          onAction={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("1/2 running · 1 failed");
  });
});

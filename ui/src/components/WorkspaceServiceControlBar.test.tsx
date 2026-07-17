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

      const urlText = state === "running"
        ? container.querySelector<HTMLAnchorElement>('a[href="http://127.0.0.1:3100"]')
        : Array.from(container.querySelectorAll("span")).find((element) => element.textContent === ":3100");
      return urlText?.parentElement;
    };

    const stoppedSegment = await renderService("stopped", null);
    expect(stoppedSegment).not.toBeNull();
    expect(stoppedSegment?.classList.contains("w-56")).toBe(true);
    expect(stoppedSegment?.classList.contains("shrink-0")).toBe(true);

    const runningSegment = await renderService("running", "http://127.0.0.1:3100");
    expect(runningSegment).not.toBeNull();
    expect(runningSegment?.className).toBe(stoppedSegment?.className);
  });
});

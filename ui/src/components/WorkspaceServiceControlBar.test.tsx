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
});

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceServiceControlBar } from "./WorkspaceServiceControlBar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let pending: void | Promise<void>;
  flushSync(() => {
    pending = callback();
  });
  await pending!;
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

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

  it("links a managed HTTPS runtime at its tailnet URL and offers no link before it is verified", async () => {
    // PAP-17158: this bar renders the launch link on the workspace, project, and
    // issue surfaces. The href must be the verified tailnet HTTPS URL including
    // its non-standard port, and an unverified exposure must render no anchor at
    // all — an `http://` fallback link is the failure this feature prevents.
    const httpsUrl = "https://paperclip-dev.tail29c1aa.ts.net:42010";
    const renderExposed = async (url: string | null, exposureState: "ready" | "pending") => {
      await act(() => {
        root.render(
          <WorkspaceServiceControlBar
            services={[{
              key: "paperclip-dev",
              name: "paperclip-dev",
              state: "running",
              healthStatus: "healthy",
              url,
              port: 42_010,
              exposureState,
            }]}
            onAction={() => {}}
          />,
        );
      });
    };

    await renderExposed(httpsUrl, "ready");
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]"));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.getAttribute("href")).toBe(httpsUrl);
    // The port is what makes a preview reachable, so it must stay visible.
    expect(container.textContent).toContain("paperclip-dev.tail29c1aa.ts.net:42010");
    // Scoped to hrefs, titles, and text: an SVG `xmlns` is not a launch link.
    const advertisedUrls = () => [
      ...Array.from(container.querySelectorAll("a[href]"), (el) => el.getAttribute("href")),
      ...Array.from(container.querySelectorAll("[title]"), (el) => el.getAttribute("title")),
      container.textContent,
    ].join(" ");
    expect(advertisedUrls()).not.toContain("http://");

    const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy URL"]')!;
    await act(async () => {
      copyButton.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(httpsUrl);

    // Exposure still pending: the backend is up but has no publishable URL yet.
    await renderExposed(null, "pending");
    expect(container.querySelectorAll("a[href]")).toHaveLength(0);
    expect(advertisedUrls()).not.toContain("http://");
    expect(container.textContent).toContain(":42010");
  });

  it("renders HTTPS cleanup separately from process running state", async () => {
    await act(() => {
      root.render(
        <WorkspaceServiceControlBar
          services={[{
            key: "web",
            name: "Web",
            state: "running",
            healthStatus: "healthy",
            exposureState: "cleanup_pending",
            exposureDetail: "HTTPS cleanup pending · Restart the host broker before reusing this port.",
          }]}
          onAction={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("HTTPS cleanup pending");
    expect(container.querySelector(".text-destructive")).not.toBeNull();
  });

  it.each([
    ["failed", "HTTPS unavailable · Check the Tailscale broker and node HTTPS configuration."],
    ["cleanup_pending", "HTTPS cleanup pending · Restart the host broker before reusing this port."],
  ] as const)("keeps the full %s remediation visible in the multi-service popover", async (exposureState, exposureDetail) => {
    await act(() => {
      root.render(
        <WorkspaceServiceControlBar
          services={[
            {
              key: "web",
              name: "Web",
              state: "running",
              healthStatus: "healthy",
              exposureState,
              exposureDetail,
            },
            {
              key: "api",
              name: "API",
              state: "stopped",
              port: 42001,
            },
          ]}
          defaultServicesOpen
          onAction={() => {}}
        />,
      );
    });

    const detail = Array.from(document.body.querySelectorAll("span"))
      .find((element) => element.textContent === exposureDetail);
    expect(detail).toBeDefined();
    expect(detail?.classList.contains("text-destructive")).toBe(true);
    expect(detail?.classList.contains("truncate")).toBe(false);
    expect(detail?.classList.contains("whitespace-normal")).toBe(true);
  });
});

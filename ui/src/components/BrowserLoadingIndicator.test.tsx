// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "./ui/button";
import { BrowserLoadingIndicator, buildFaviconSpinnerFrames } from "./BrowserLoadingIndicator";
import { RouteContentLoading } from "./AnimatedPaperclipIcon";

let currentLocation = { pathname: "/APP/dashboard", search: "", hash: "" };

vi.mock("@/lib/router", () => ({
  useLocation: () => currentLocation,
}));

describe("Button loading feedback", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("sets data-loading and aria-busy while an async onClick promise is pending", async () => {
    let resolveClick!: () => void;
    const onClick = vi.fn(() => new Promise<void>((resolve) => {
      resolveClick = resolve;
    }));

    const root = createRoot(container);
    flushSync(() => {
      root.render(<Button onClick={onClick}>Save changes</Button>);
    });

    const button = container.querySelector("button")!;
    expect(button.getAttribute("data-loading")).toBeNull();

    flushSync(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("data-loading")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");

    flushSync(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);

    resolveClick();
    await Promise.resolve();
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(button.getAttribute("data-loading")).toBeNull();
    });
    flushSync(() => {
      root.unmount();
    });
  });

  it("blocks form submission when loading is true without an onClick handler", () => {
    const onSubmit = vi.fn((event: React.FormEvent) => {
      event.preventDefault();
    });
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <form onSubmit={onSubmit}>
          <Button type="submit" loading>
            Submit
          </Button>
        </form>,
      );
    });

    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("data-loading")).toBe("true");
    flushSync(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();

    flushSync(() => {
      root.unmount();
    });
  });
});

describe("BrowserLoadingIndicator and RouteContentLoading", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    currentLocation = { pathname: "/APP/dashboard", search: "", hash: "" };
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.remove("paperclip-browser-loading");
    document.documentElement.style.removeProperty("--primary");
    document.documentElement.style.removeProperty("--muted-foreground");
    document.body.innerHTML = "";
  });

  it("shows and clears bar, pill, and root loading class when route suspense mounts and unmounts", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BrowserLoadingIndicator />
          <RouteContentLoading />
        </QueryClientProvider>,
      );
    });

    const bar = container.querySelector('[data-testid="browser-loading-bar"]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(container.textContent).toContain("Loading page…");

    await vi.waitFor(() => {
      expect(bar.style.opacity).toBe("1");
      expect(container.querySelector('[data-testid="browser-loading-pill"]')).toBeTruthy();
      expect(document.documentElement.classList.contains("paperclip-browser-loading")).toBe(true);
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BrowserLoadingIndicator />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(bar.style.opacity).toBe("0");
      expect(container.querySelector('[data-testid="browser-loading-pill"]')).toBeNull();
      expect(document.documentElement.classList.contains("paperclip-browser-loading")).toBe(false);
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("triggers loading sweep on route change and settles back to idle", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BrowserLoadingIndicator />
        </QueryClientProvider>,
      );
    });

    const bar = container.querySelector('[data-testid="browser-loading-bar"]') as HTMLElement;
    expect(bar.style.opacity).toBe("0");

    currentLocation = { pathname: "/APP/issues", search: "", hash: "" };
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BrowserLoadingIndicator />
        </QueryClientProvider>,
      );
    });
    expect(bar.style.opacity).toBe("1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(bar.style.opacity).toBe("0");

    flushSync(() => {
      root.unmount();
    });
  });

  it("rebuilds cached favicon spinner frames when theme tokens change", () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () =>
        ({
          clearRect: vi.fn(),
          save: vi.fn(),
          restore: vi.fn(),
          beginPath: vi.fn(),
          arc: vi.fn(),
          stroke: vi.fn(),
          globalAlpha: 1,
          strokeStyle: "",
          lineWidth: 1,
          lineCap: "butt",
        }) as unknown as CanvasRenderingContext2D,
    );
    const toDataUrl = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
      () => `data:image/png;base64,${document.documentElement.style.getPropertyValue("--primary")}`,
    );

    document.documentElement.style.setProperty("--primary", "CanvasText");
    const first = buildFaviconSpinnerFrames();
    const second = buildFaviconSpinnerFrames();
    expect(first).toBe(second);

    document.documentElement.style.setProperty("--primary", "Highlight");
    const third = buildFaviconSpinnerFrames();
    expect(third).not.toBe(first);

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("renders safely when mounted without a QueryClientProvider", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(<BrowserLoadingIndicator />);
    });

    const bar = container.querySelector('[data-testid="browser-loading-bar"]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.style.opacity).toBe("0");

    flushSync(() => {
      root.unmount();
    });
  });
});

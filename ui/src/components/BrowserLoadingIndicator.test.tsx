// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "./ui/button";
import { BrowserLoadingIndicator } from "./BrowserLoadingIndicator";
import { RouteContentLoading } from "./AnimatedPaperclipIcon";

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/APP/dashboard", search: "", hash: "" }),
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
});

describe("BrowserLoadingIndicator and RouteContentLoading", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders loading bar and pill when route suspense mounts", async () => {
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

    expect(container.querySelector('[data-testid="browser-loading-bar"]')).toBeTruthy();
    expect(container.textContent).toContain("Loading page…");

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="browser-loading-pill"]')).toBeTruthy();
    });

    flushSync(() => {
      root.unmount();
    });
  });
});

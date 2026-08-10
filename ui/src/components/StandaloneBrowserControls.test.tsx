// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import { StandaloneBrowserControls } from "./StandaloneBrowserControls";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function installMatchMedia(initialMatches: Record<string, boolean> = {}) {
  type Listener = (event: MediaQueryListEvent) => void;
  const queries = new Map<string, { matches: boolean; listeners: Set<Listener> }>();

  function getQuery(query: string) {
    let entry = queries.get(query);
    if (!entry) {
      entry = { matches: initialMatches[query] ?? false, listeners: new Set<Listener>() };
      queries.set(query, entry);
    }

    return {
      get matches() {
        return entry.matches;
      },
      media: query,
      addEventListener: (_type: "change", listener: Listener) => {
        entry.listeners.add(listener);
      },
      removeEventListener: (_type: "change", listener: Listener) => {
        entry.listeners.delete(listener);
      },
      addListener: (listener: Listener) => {
        entry.listeners.add(listener);
      },
      removeListener: (listener: Listener) => {
        entry.listeners.delete(listener);
      },
    } as unknown as MediaQueryList;
  }

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => getQuery(query),
  });

  return {
    setMatches(query: string, matches: boolean) {
      const entry = queries.get(query) ?? { matches: false, listeners: new Set<Listener>() };
      entry.matches = matches;
      queries.set(query, entry);
      entry.listeners.forEach((listener) => listener({ matches, media: query } as MediaQueryListEvent));
    },
  };
}

describe("StandaloneBrowserControls", () => {
  let container: HTMLDivElement;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
  });

  afterEach(() => {
    delete (navigator as Navigator & { standalone?: boolean }).standalone;
    if (originalMatchMedia) {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
    } else {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
    }
    container.remove();
    document.body.innerHTML = "";
  });

  it("shows refresh, share, and open-in-browser controls in mobile standalone mode", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TooltipProvider>
          <ToastProvider>
            <StandaloneBrowserControls mobile />
          </ToastProvider>
        </TooltipProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('[aria-label="Refresh"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Share"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Open in Browser"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("hides controls in normal mobile browser mode", async () => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: false });
    installMatchMedia();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TooltipProvider>
          <ToastProvider>
            <StandaloneBrowserControls mobile />
          </ToastProvider>
        </TooltipProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('[aria-label="Refresh"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("responds to all chromeless display-mode media query changes", async () => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: false });
    const media = installMatchMedia();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TooltipProvider>
          <ToastProvider>
            <StandaloneBrowserControls mobile />
          </ToastProvider>
        </TooltipProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('[aria-label="Refresh"]')).toBeNull();

    await act(() => {
      media.setMatches("(display-mode: fullscreen)", true);
    });
    await flushReact();

    expect(container.querySelector('[aria-label="Refresh"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});

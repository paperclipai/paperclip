// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeContext";

const THEME_STORAGE_KEY = "paperclip.theme";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MediaListener = (event: MediaQueryListEvent) => void;

interface FakeMediaQueryList {
  matches: boolean;
  addEventListener: (type: "change", listener: MediaListener) => void;
  removeEventListener: (type: "change", listener: MediaListener) => void;
  dispatch: (matches: boolean) => void;
  listenerCount: () => number;
}

function installMatchMedia(initialMatches: boolean): FakeMediaQueryList {
  const listeners = new Set<MediaListener>();
  const mql: FakeMediaQueryList = {
    matches: initialMatches,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    dispatch: (matches) => {
      mql.matches = matches;
      const event = { matches } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
    listenerCount: () => listeners.size,
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      if (query !== "(prefers-color-scheme: dark)") {
        throw new Error(`unexpected media query: ${query}`);
      }
      return mql as unknown as MediaQueryList;
    },
  });
  return mql;
}

describe("ThemeContext", () => {
  let container: HTMLDivElement;
  let observedTheme: "light" | "dark" | null = null;
  let setTheme: ((theme: "light" | "dark") => void) | null = null;
  let toggleTheme: (() => void) | null = null;

  function Probe() {
    const ctx = useTheme();
    observedTheme = ctx.theme;
    setTheme = ctx.setTheme;
    toggleTheme = ctx.toggleTheme;
    return null;
  }

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
    observedTheme = null;
    setTheme = null;
    toggleTheme = null;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("follows OS prefers-color-scheme changes while no explicit choice has been made", () => {
    document.documentElement.classList.add("dark");
    const mql = installMatchMedia(true);

    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });

    expect(observedTheme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mql.listenerCount()).toBe(1);

    act(() => {
      mql.dispatch(false);
    });
    expect(observedTheme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("stops listening to OS changes after the user makes an explicit choice", () => {
    document.documentElement.classList.add("dark");
    const mql = installMatchMedia(true);

    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });

    expect(mql.listenerCount()).toBe(1);

    act(() => {
      setTheme?.("light");
    });
    expect(observedTheme).toBe("light");
    expect(mql.listenerCount()).toBe(0);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).toBe("light");

    act(() => {
      toggleTheme?.();
    });
    expect(observedTheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    act(() => {
      root.unmount();
    });
  });

  it("does not attach the OS listener when a stored choice already exists", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const mql = installMatchMedia(true);

    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });

    expect(mql.listenerCount()).toBe(0);

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).not.toBe("dark");

    act(() => {
      root.unmount();
    });
  });
});

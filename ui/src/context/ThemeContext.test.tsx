// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme, type ThemePreference } from "./ThemeContext";

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
  let observedPreference: ThemePreference | null = null;
  let setTheme: ((theme: ThemePreference) => void) | null = null;
  let toggleTheme: (() => void) | null = null;

  function Probe() {
    const ctx = useTheme();
    observedTheme = ctx.theme;
    observedPreference = ctx.themePreference;
    setTheme = ctx.setTheme;
    toggleTheme = ctx.toggleTheme;
    return null;
  }

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
    observedTheme = null;
    observedPreference = null;
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
    expect(observedPreference).toBe("light");

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).not.toBe("dark");

    act(() => {
      root.unmount();
    });
  });

  it("returns to following the OS when the system preference is chosen", () => {
    const mql = installMatchMedia(true);

    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });

    act(() => {
      setTheme?.("light");
    });
    expect(observedPreference).toBe("light");
    expect(mql.listenerCount()).toBe(0);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    act(() => {
      setTheme?.("system");
    });
    expect(observedPreference).toBe("system");
    expect(observedTheme).toBe("dark");
    expect(mql.listenerCount()).toBe(1);
    // No stored value is what "follow the OS" means, so a reload keeps it.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    act(() => {
      mql.dispatch(false);
    });
    expect(observedTheme).toBe("light");

    act(() => {
      root.unmount();
    });
  });

  it("cycles light, dark and system through the single toggle control", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    installMatchMedia(true);

    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });

    act(() => {
      toggleTheme?.();
    });
    expect(observedPreference).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    act(() => {
      toggleTheme?.();
    });
    expect(observedPreference).toBe("system");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    act(() => {
      toggleTheme?.();
    });
    expect(observedPreference).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    act(() => {
      root.unmount();
    });
  });

  it("adopts the current OS value when switching to the system preference", () => {
    // The OS flips to light while an explicit dark theme is selected, so no
    // listener is attached and nothing in the provider has observed it yet.
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
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
    expect(mql.listenerCount()).toBe(0);

    act(() => {
      mql.matches = false;
    });

    act(() => {
      setTheme?.("system");
    });
    // Not one frame of the stale dark value: the switch reads the OS itself.
    expect(observedTheme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(mql.listenerCount()).toBe(1);

    act(() => {
      root.unmount();
    });
  });

  it("follows the OS when local storage cannot be read", async () => {
    const mql = installMatchMedia(false);
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage denied");
      });

    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });

    // index.html treats an unreadable preference the same way, so first paint
    // and this provider agree instead of fighting over the initial class.
    expect(observedPreference).toBe("system");
    expect(observedTheme).toBe("light");
    expect(mql.listenerCount()).toBe(1);

    getItem.mockRestore();

    act(() => {
      root.unmount();
    });
  });
});

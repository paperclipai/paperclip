// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme, type ThemePreference } from "./ThemeContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MatchMediaListener = (event: MediaQueryListEvent) => void;

function installMatchMedia(matches: boolean) {
  const listeners = new Set<MatchMediaListener>();
  let currentMatches = matches;
  const query = {
    get matches() {
      return currentMatches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn((_event: string, listener: MatchMediaListener) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_event: string, listener: MatchMediaListener) => {
      listeners.delete(listener);
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => query),
  });

  return {
    setMatches(nextMatches: boolean) {
      currentMatches = nextMatches;
      const event = { matches: nextMatches, media: query.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

function ThemeProbe() {
  const { effectiveTheme, setThemePreference, themePreference } = useTheme();
  return (
    <div>
      <span data-testid="preference">{themePreference}</span>
      <span data-testid="effective">{effectiveTheme}</span>
      {(["light", "dark", "system"] as ThemePreference[]).map((preference) => (
        <button key={preference} type="button" onClick={() => setThemePreference(preference)}>
          {preference}
        </button>
      ))}
    </div>
  );
}

function renderThemeProbe(container: HTMLDivElement): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
  });
  return root;
}

function clickButton(container: HTMLDivElement, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ThemeContext", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
    window.localStorage.clear();
    installMatchMedia(false);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.localStorage.clear();
  });

  it("persists explicit light and dark preferences", () => {
    const root = renderThemeProbe(container);

    clickButton(container, "light");
    expect(container.querySelector('[data-testid="preference"]')?.textContent).toBe("light");
    expect(container.querySelector('[data-testid="effective"]')?.textContent).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem("paperclip.theme")).toBe("light");

    clickButton(container, "dark");
    expect(container.querySelector('[data-testid="preference"]')?.textContent).toBe("dark");
    expect(container.querySelector('[data-testid="effective"]')?.textContent).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem("paperclip.theme")).toBe("dark");

    act(() => root.unmount());
  });

  it("follows system preference changes", () => {
    const system = installMatchMedia(false);
    const root = renderThemeProbe(container);

    clickButton(container, "system");
    expect(container.querySelector('[data-testid="preference"]')?.textContent).toBe("system");
    expect(container.querySelector('[data-testid="effective"]')?.textContent).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    act(() => {
      system.setMatches(true);
    });

    expect(container.querySelector('[data-testid="effective"]')?.textContent).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem("paperclip.theme")).toBe("system");

    act(() => root.unmount());
  });
});

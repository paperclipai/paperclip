// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../../index.html?raw";

type ChangeListener = () => void;

function mockColorScheme(initialDark: boolean) {
  const listeners: ChangeListener[] = [];
  const query = {
    matches: initialDark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, listener: ChangeListener) => listeners.push(listener),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return {
    setDark(dark: boolean) {
      query.matches = dark;
      for (const listener of listeners) listener();
    },
  };
}

function loadHead() {
  const doc = new DOMParser().parseFromString(indexHtml, "text/html");
  document.head.innerHTML = doc.head.innerHTML;
  // Scripts inserted through innerHTML do not run, so run the inline head scripts directly.
  for (const script of Array.from(document.head.querySelectorAll("script"))) {
    window.eval(script.textContent ?? "");
  }
}

function faviconHrefs() {
  return Array.from(document.head.querySelectorAll('link[rel="icon"]')).map((link) =>
    link.getAttribute("href"),
  );
}

describe("favicon colour-scheme swap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    window.localStorage.clear();
  });

  it("points every icon at the light assets when the browser scheme is light", () => {
    mockColorScheme(false);
    loadHead();
    expect(faviconHrefs()).toEqual([
      "/favicon.ico",
      "/favicon-light.svg",
      "/favicon-32x32.png",
      "/favicon-16x16.png",
    ]);
  });

  it("points every icon at the dark assets when the browser scheme is dark", () => {
    mockColorScheme(true);
    loadHead();
    expect(faviconHrefs()).toEqual([
      "/favicon-dark.ico",
      "/favicon-dark.svg",
      "/favicon-dark-32x32.png",
      "/favicon-dark-16x16.png",
    ]);
  });

  it("follows the browser scheme, not the stored in-app theme", () => {
    window.localStorage.setItem("paperclip.theme", "dark");
    mockColorScheme(false);
    loadHead();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(faviconHrefs()).toContain("/favicon-light.svg");
  });

  it("swaps the icons when the browser scheme changes on an open page", () => {
    const scheme = mockColorScheme(false);
    loadHead();
    expect(faviconHrefs()).toContain("/favicon-light.svg");

    scheme.setDark(true);
    expect(faviconHrefs()).toContain("/favicon-dark.svg");
    expect(faviconHrefs()).toContain("/favicon-dark.ico");

    scheme.setDark(false);
    expect(faviconHrefs()).toContain("/favicon-light.svg");
    expect(faviconHrefs()).toContain("/favicon.ico");
  });
});

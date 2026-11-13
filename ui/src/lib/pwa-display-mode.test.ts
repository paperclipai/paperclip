import { describe, expect, it } from "vitest";
import { isChromelessDisplayMode } from "./pwa-display-mode";

function matchMode(activeMode: string | null) {
  return (query: string) => ({ matches: query === `(display-mode: ${activeMode})` });
}

describe("isChromelessDisplayMode", () => {
  it("detects standalone display mode from media queries", () => {
    expect(isChromelessDisplayMode(matchMode("standalone"), false)).toBe(true);
  });

  it("detects fullscreen display mode from media queries", () => {
    expect(isChromelessDisplayMode(matchMode("fullscreen"), false)).toBe(true);
  });

  it("detects window-controls-overlay display mode from media queries", () => {
    expect(isChromelessDisplayMode(matchMode("window-controls-overlay"), false)).toBe(true);
  });

  it("detects iOS home-screen standalone launches", () => {
    expect(isChromelessDisplayMode(matchMode(null), true)).toBe(true);
  });

  it("ignores normal browser launches", () => {
    expect(isChromelessDisplayMode(matchMode("browser"), false)).toBe(false);
  });
});

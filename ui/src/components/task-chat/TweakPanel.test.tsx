// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TweakPanel } from "./TweakPanel";
import { MOTION_TOKENS } from "./motion-tokens";

describe("TweakPanel", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(<TweakPanel />));
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    document.documentElement.removeAttribute("style");
    sessionStorage.clear();
  });

  it("lists a control for every motion token in the catalog", () => {
    const rendered = new Set(
      Array.from(container.querySelectorAll("[data-token]")).map((el) => el.getAttribute("data-token")),
    );
    for (const t of MOTION_TOKENS) {
      expect(rendered.has(t.name), `panel is missing a control for ${t.name}`).toBe(true);
    }
    expect(rendered.size).toBe(MOTION_TOKENS.length);
  });

  it("writes a token change live to the CSS custom property", () => {
    const token = MOTION_TOKENS.find((t) => t.kind === "time")!;
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${token.name}"]`);
    expect(input).not.toBeNull();

    // Use the native value setter so React's value tracker registers the change
    // and fires onChange (setting `.value` directly is swallowed by React).
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    flushSync(() => {
      nativeSetter.call(input, "500");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(document.documentElement.style.getPropertyValue(token.name)).toBe("500ms");
  });
});

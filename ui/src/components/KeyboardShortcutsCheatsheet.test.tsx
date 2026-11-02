// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyboardShortcutsCheatsheetContent } from "./KeyboardShortcutsCheatsheet";
import { i18n } from "@/i18n";
import { act } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("KeyboardShortcutsCheatsheet", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("does not advertise the retired sidebar collapse shortcut", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(<KeyboardShortcutsCheatsheetContent />);
    });

    const row = [...container.querySelectorAll("span")].find(
      (node) => node.textContent?.trim() === "Collapse or expand sidebar",
    )?.parentElement;
    expect(row).toBeUndefined();

    flushSync(() => {
      root.unmount();
    });
  });

  it("updates labels live without changing keyboard chords", async () => {
    const root = createRoot(container);
    try {
      await act(async () => {
        await i18n.changeLanguage("en");
        root.render(<KeyboardShortcutsCheatsheetContent />);
      });
      const chords = [...container.querySelectorAll("kbd")].map((node) => node.textContent);
      expect(chords).toContain("Esc");
      expect(container.textContent).toContain("Move down");
      await act(async () => { await i18n.changeLanguage("ru"); });
      expect(container.textContent).not.toContain("Move down");
      expect(container.textContent).toContain("Перейти вниз");
      expect([...container.querySelectorAll("kbd")].map((node) => node.textContent)).toEqual(chords);
      await act(async () => { await i18n.changeLanguage("en"); });
      expect(container.textContent).toContain("Move down");
    } finally {
      await act(async () => { root.unmount(); await i18n.changeLanguage("en"); });
    }
  });
});

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyboardShortcutsCheatsheetContent } from "./KeyboardShortcutsCheatsheet";

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

  it("lists the re-pointed Cmd/Ctrl+B sidebar collapse shortcut as a chord", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(<KeyboardShortcutsCheatsheetContent />);
    });

    // The collapse/expand row exists with its label.
    const row = [...container.querySelectorAll("span")].find(
      (node) => node.textContent?.trim() === "Collapse or expand sidebar",
    )?.parentElement;
    expect(row).toBeTruthy();

    // Rendered as a "+" chord (B + a Cmd/Ctrl cap), not a "then" sequence.
    const caps = [...(row?.querySelectorAll("kbd") ?? [])].map((kbd) => kbd.textContent);
    expect(caps).toContain("B");
    expect(caps.some((cap) => cap === "⌘" || cap === "Ctrl")).toBe(true);
    expect(row?.textContent).toContain("+");
    expect(row?.textContent).not.toContain("then");

    flushSync(() => {
      root.unmount();
    });
  });
});

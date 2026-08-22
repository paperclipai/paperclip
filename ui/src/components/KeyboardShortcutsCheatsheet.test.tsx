// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The settings link is the only routing dependency; stub it so this stays a unit
// test of the sheet's content instead of dragging in Router + CompanyProvider.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const generalSettingsMock = { keyboardShortcutsEnabled: true };
vi.mock("../context/GeneralSettingsContext", () => ({
  useGeneralSettings: () => generalSettingsMock,
}));

const { KeyboardShortcutsCheatsheetContent } = await import("./KeyboardShortcutsCheatsheet");

describe("KeyboardShortcutsCheatsheet", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    generalSettingsMock.keyboardShortcutsEnabled = true;
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

  // `?` is the only way into this sheet, and it used to be gated on the same
  // setting it documents — so when shortcuts were off there was no trace in the
  // app that they existed or where to turn them on.
  it("points at the setting when shortcuts are turned off", () => {
    generalSettingsMock.keyboardShortcutsEnabled = false;
    const root = createRoot(container);
    flushSync(() => {
      root.render(<KeyboardShortcutsCheatsheetContent />);
    });

    expect(container.textContent).toContain("Keyboard shortcuts are currently");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/company/settings/instance/general");

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows no setting callout while shortcuts are enabled", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(<KeyboardShortcutsCheatsheetContent />);
    });

    expect(container.textContent).not.toContain("Keyboard shortcuts are currently");
    expect(container.querySelector("a")).toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });
});

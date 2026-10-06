// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { Command, CommandInput, CommandItem, CommandList } from "./command";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("command list localization", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
    vi.unstubAllGlobals();
  });

  it.each([undefined, "Raw custom list name"])("preserves data and explicit labels (%s) across EN/RU/EN", async (label) => {
    const selected = vi.fn();
    await act(async () => root.render(
      <Command value="raw-repository-id">
        <CommandInput value="Raw" onValueChange={vi.fn()} />
        <CommandList label={label}>
          <CommandItem value="raw-repository-id" onSelect={selected}>Raw repository name</CommandItem>
        </CommandList>
      </Command>,
    ));
    for (const locale of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.querySelector('[role="listbox"]')?.getAttribute("aria-label"))
        .toBe(label ?? (locale === "ru" ? "Варианты выбора" : "Suggestions"));
      expect(container.querySelector("input")?.value).toBe("Raw");
      expect(container.querySelector('[role="option"]')?.getAttribute("data-value")).toBe("raw-repository-id");
      expect(container.textContent).toContain("Raw repository name");
      expect(selected).not.toHaveBeenCalled();
    }
  });
});

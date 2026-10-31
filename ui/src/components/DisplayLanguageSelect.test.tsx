// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISPLAY_LOCALE_STORAGE_KEY } from "@/i18n/display-text";
import { DisplayLanguageSelect } from "./DisplayLanguageSelect";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DisplayLanguageSelect", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(DISPLAY_LOCALE_STORAGE_KEY);
  });

  it("lists the display languages by their own names and stores the choice", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onLocaleChange = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(<DisplayLanguageSelect onLocaleChange={onLocaleChange} />);
    });

    const select = container.querySelector("select");
    expect(container.querySelector("label")?.textContent).toContain("Language");
    expect(select?.value).toBe("en");
    expect(select?.hasAttribute("data-no-translate")).toBe(true);
    expect(Array.from(select?.options ?? [], (option) => [option.value, option.textContent])).toEqual([
      ["en", "English"],
      ["fr", "Français"],
    ]);

    await act(async () => {
      if (!select) return;
      select.value = "fr";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(localStorage.getItem(DISPLAY_LOCALE_STORAGE_KEY)).toBe("fr");
    expect(onLocaleChange).toHaveBeenCalledWith("fr");
    await act(async () => root.unmount());
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LanguageToggle } from "./LanguageToggle";
import { getCurrentLanguage, i18n, setLanguage } from "../i18n";
import { LANGUAGE_STORAGE_KEY } from "../i18n/language";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("LanguageToggle", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    // Reset the shared i18n singleton + persisted choice so tests stay isolated.
    await act(async () => {
      await setLanguage("en");
    });
    window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders the menu-action row with the active language as its description", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<LanguageToggle variant="menu-action" />);
    });
    await flushReact();

    expect(container.textContent).toContain("Language");
    expect(container.textContent).toContain("English");

    await act(async () => root.unmount());
  });

  it("renders an icon button by default labelled with the language affordance", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<LanguageToggle />);
    });
    await flushReact();

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Language");

    await act(async () => root.unmount());
  });

  it("persists the chosen language and re-renders chrome in that language", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<LanguageToggle variant="menu-action" />);
    });
    await flushReact();

    await act(async () => {
      await setLanguage("zh-CN");
    });
    await flushReact();

    expect(getCurrentLanguage()).toBe("zh-CN");
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
    // Label + active-language description reflect the new locale.
    expect(container.textContent).toContain("语言");
    expect(container.textContent).toContain("简体中文");

    await act(async () => root.unmount());
  });

  it("reflects the language onto <html lang>", async () => {
    await act(async () => {
      await setLanguage("zh-CN");
    });
    expect(document.documentElement.getAttribute("lang")).toBe("zh-CN");

    await act(async () => {
      await setLanguage("en");
    });
    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(i18n.resolvedLanguage).toBe("en");
  });
});

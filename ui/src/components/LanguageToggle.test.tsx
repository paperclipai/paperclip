// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale-preference";
import { LanguageToggle, nextLocale } from "./LanguageToggle";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("LanguageToggle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    await i18n.changeLanguage("en");
  });

  it("cycles through the selectable locales", () => {
    expect(nextLocale("en", ["en", "pt-BR"])).toBe("pt-BR");
    expect(nextLocale("pt-BR", ["en", "pt-BR"])).toBe("en");
    expect(nextLocale("en", ["en"])).toBeNull();
  });

  it("switches to the next locale, persists it, and updates the document language", async () => {
    let afterToggleCalls = 0;
    act(() => {
      root.render(<LanguageToggle locales={["en", "pt-BR"]} onAfterToggle={() => { afterToggleCalls += 1; }} />);
    });

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Switch language to Português (Brasil)");
    expect(button?.getAttribute("aria-label")).toBe("Switch language to Português (Brasil)");

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(i18n.language).toBe("pt-BR");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("pt-BR");
    expect(document.documentElement.lang).toBe("pt-BR");
    expect(afterToggleCalls).toBe(1);
    expect(container.querySelector("button")?.textContent).toBe("Mudar o idioma para English");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Mudar o idioma para English");
  });

  it("renders nothing when only one locale is selectable", () => {
    act(() => {
      root.render(<LanguageToggle locales={["en"]} />);
    });
    expect(container.querySelector("button")).toBeNull();
  });
});

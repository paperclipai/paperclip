// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageToggle, PRIMARY_LANGUAGES, getLanguageDetails, getNextLocale } from "./LanguageToggle";
import { changeLanguage, getCurrentLocale } from "@/i18n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("LanguageToggle", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    changeLanguage("en");
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("names English, Brazilian Portuguese, and European Portuguese correctly", () => {
    expect(getLanguageDetails("en").label).toBe("Language: English");
    expect(getLanguageDetails("pt-BR").label).toBe("Idioma: Português (BR)");
    expect(getLanguageDetails("pt-PT").label).toBe("Idioma: Português (PT)");
  });

  it("cycles through English -> pt-BR -> pt-PT -> English", () => {
    expect(getNextLocale("en")).toBe("pt-BR");
    expect(getNextLocale("pt-BR")).toBe("pt-PT");
    expect(getNextLocale("pt-PT")).toBe("en");
  });

  it("renders with English as default in compact-menu-action variant", async () => {
    const root = createRoot(container);
    await act(() => {
      root.render(<LanguageToggle variant="compact-menu-action" />);
    });

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Language: English");
    expect(container.textContent).toContain("Language: English");

    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    expect(select?.value).toBe("en");

    await act(() => root.unmount());
  });

  it("renders correctly when locale is pt-PT", async () => {
    changeLanguage("pt-PT");
    const root = createRoot(container);
    await act(() => {
      root.render(<LanguageToggle variant="compact-menu-action" />);
    });

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Idioma: Português (PT)");
    expect(container.textContent).toContain("Idioma: Português (PT)");

    const select = container.querySelector("select");
    expect(select?.value).toBe("pt-PT");

    await act(() => root.unmount());
  });

  it("allows selecting European Portuguese through the language picker", async () => {
    const onAfterToggle = vi.fn();
    const root = createRoot(container);
    await act(() => {
      root.render(<LanguageToggle variant="compact-menu-action" onAfterToggle={onAfterToggle} />);
    });

    const select = container.querySelector("select");
    expect(select).not.toBeNull();

    await act(() => {
      if (select) {
        select.value = "pt-PT";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    expect(getCurrentLocale()).toBe("pt-PT");
    expect(onAfterToggle).toHaveBeenCalledOnce();

    await act(() => root.unmount());
  });

  it("cycles to pt-BR when clicking toggle button from en", async () => {
    const onAfterToggle = vi.fn();
    const root = createRoot(container);
    await act(() => {
      root.render(<LanguageToggle variant="compact-menu-action" onAfterToggle={onAfterToggle} />);
    });

    const button = container.querySelector("button");
    await act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(getCurrentLocale()).toBe("pt-BR");
    expect(onAfterToggle).toHaveBeenCalledOnce();

    await act(() => root.unmount());
  });

  it("cycles to pt-PT when clicking toggle button from pt-BR", async () => {
    changeLanguage("pt-BR");
    const onAfterToggle = vi.fn();
    const root = createRoot(container);
    await act(() => {
      root.render(<LanguageToggle variant="compact-menu-action" onAfterToggle={onAfterToggle} />);
    });

    const button = container.querySelector("button");
    await act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(getCurrentLocale()).toBe("pt-PT");
    expect(onAfterToggle).toHaveBeenCalledOnce();

    await act(() => root.unmount());
  });

  it("includes all primary languages in picker options", async () => {
    const root = createRoot(container);
    await act(() => {
      root.render(<LanguageToggle variant="compact-menu-action" />);
    });

    const options = Array.from(container.querySelectorAll("option")).map((o) => o.value);
    for (const lang of PRIMARY_LANGUAGES) {
      expect(options).toContain(lang.code);
    }

    await act(() => root.unmount());
  });
});

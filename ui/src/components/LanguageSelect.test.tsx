// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { LanguageSelect } from "./LanguageSelect";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("LanguageSelect", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    void i18n.changeLanguage("en");
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    localStorage.clear();
    void i18n.changeLanguage("en");
  });

  it("persists Simplified Chinese and updates translated chrome", async () => {
    const root = createRoot(container);
    await act(() => {
      root.render(<LanguageSelect />);
    });

    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    expect(container.textContent).toContain("Language");

    await act(() => {
      select!.value = "zh-CN";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(localStorage.getItem("paperclip.locale")).toBe("zh-CN");
    expect(i18n.language).toBe("zh-CN");
    expect(container.textContent).toContain("语言");

    await act(() => {
      root.unmount();
    });
  });
});

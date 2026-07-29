// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getLocaleDisplayName, setLocale } from "@/i18n";
import { LocaleSwitcher } from "./LocaleSwitcher";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("LocaleSwitcher", () => {
  let container: HTMLDivElement;

  beforeEach(async () => {
    await setLocale("en");
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    container.remove();
    document.body.innerHTML = "";
    await setLocale("en");
  });

  it("reacts immediately when the active locale changes", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<LocaleSwitcher />);
    });

    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
      `${getLocaleDisplayName("en")} (en)`,
    );

    await act(async () => {
      await setLocale("ru");
    });

    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
      `${getLocaleDisplayName("ru")} (ru)`,
    );

    await act(async () => {
      root.unmount();
    });
  });
});

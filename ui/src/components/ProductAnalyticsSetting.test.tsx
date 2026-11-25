// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserAnalyticsConfig } from "@paperclipai/shared";
import { ANALYTICS_CONSENT_STORAGE_KEY, resetAnalyticsConsentForTest } from "@/lib/analytics/consent";
import { ProductAnalyticsSetting } from "./ProductAnalyticsSetting";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const config: BrowserAnalyticsConfig = {
  token: "phc_test",
  apiHost: "/_ph",
  uiHost: null,
  environment: "production",
  stackId: "stack-1",
  replayEnabled: true,
  consentRequired: false,
};

describe("ProductAnalyticsSetting", () => {
  let container: HTMLDivElement;

  afterEach(() => {
    container.remove();
    window.localStorage.clear();
    resetAnalyticsConsentForTest();
  });

  function render(value: BrowserAnalyticsConfig | null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<ProductAnalyticsSetting config={value} />));
    return root;
  }

  it("shows nothing when browser analytics is off for the instance", () => {
    const root = render(null);
    expect(container.innerHTML).toBe("");
    act(() => root.unmount());
  });

  it("turns analytics off and on for this browser", () => {
    const root = render(config);
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(document.getElementById(toggle.getAttribute("aria-labelledby")!)?.textContent).toBe("Product analytics");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    act(() => toggle.click());
    expect(window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY)).toBe("denied");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    act(() => toggle.click());
    expect(window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY)).toBe("granted");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    act(() => root.unmount());
  });

  it("is off before a visitor who must consent has chosen", () => {
    const root = render({ ...config, consentRequired: true });
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    act(() => root.unmount());
  });

  it("stays off and cannot be turned on when the browser asks not to be tracked where consent is required", () => {
    Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "granted");
    const root = render({ ...config, consentRequired: true });
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(true);
    expect(container.textContent).toContain("Your browser asks sites not to track you");
    Object.defineProperty(navigator, "globalPrivacyControl", { value: undefined, configurable: true });
    act(() => root.unmount());
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyticsConsentBanner } from "./AnalyticsConsentBanner";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("AnalyticsConsentBanner", () => {
  let container: HTMLDivElement;

  afterEach(() => {
    container.remove();
  });

  function render(props: Parameters<typeof AnalyticsConsentBanner>[0]) {
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<AnalyticsConsentBanner {...props} />));
    return root;
  }

  it("is a labelled region with plain copy, a privacy link and two keyboard buttons", () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    const root = render({ recordings: true, onAccept, onDecline });
    const region = container.querySelector("section")!;
    expect(region.getAttribute("aria-label")).toBe("Analytics choice");
    const description = document.getElementById(region.getAttribute("aria-describedby")!);
    expect(description?.textContent).toContain(
      "Paperclip uses analytics and session recordings to improve the product. Recordings hide what you type and your messages, documents and connected accounts, but may show page names like task titles.",
    );
    const link = region.querySelector("a")!;
    expect(link.textContent).toBe("Privacy policy");
    expect(link.getAttribute("href")).toBe("https://paperclip.ing/privacy/");
    const buttons = [...region.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Decline", "Accept"]);
    expect(buttons.every((button) => button.type === "button")).toBe(true);
    act(() => buttons[0]!.click());
    act(() => buttons[1]!.click());
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[aria-modal]")).toBeNull();
    act(() => root.unmount());
  });

  it("does not mention recordings when replay is off", () => {
    const root = render({ recordings: false, onAccept: vi.fn(), onDecline: vi.fn() });
    expect(container.textContent).not.toContain("recordings");
    act(() => root.unmount());
  });
});

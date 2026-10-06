// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SidePanelMobileTabs } from "./SidePanelMobileTabs";
import { i18n, t } from "@/i18n";
import { useSidePanelTabs } from "./use-side-panel-tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const longTitle = "Bookmarked post formats and fourteen model-harness tweets";

function Fixture() {
  const controller = useSidePanelTabs({ initialState: {
    tabs: [{ id: "properties", type: "view", label: "Properties", payload: {} }, { id: "plan", type: "document", label: longTitle, payload: {} }],
    activeTabId: "plan",
  } });
  return <><SidePanelMobileTabs tabs={controller.tabs} activeTabId={controller.activeTabId} onActiveTabChange={controller.selectTab} onCloseTab={controller.closeTab} /><output>{controller.activeTabId ?? "empty"}</output></>;
}

describe("SidePanelMobileTabs", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Fixture />));
  });
  afterEach(async () => { act(() => root.unmount()); container.remove(); await i18n.changeLanguage("en"); });
  function button(label: string) {
    const result = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.getAttribute("aria-label") === label);
    expect(result).toBeDefined();
    return result!;
  }
  async function click(label: string) { await act(async () => button(label).click()); }

  it("retranslates an open overview without replacing user titles, selection, or tab elements", async () => {
    await click("Switch tabs, 2 open");
    const tab = button(longTitle);
    const close = button(`Close ${longTitle}`);
    for (const locale of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(button(longTitle)).toBe(tab);
      expect(tab.getAttribute("aria-current")).toBe("true");
      expect(button(t("oct6Beta.dynamic068", { v0: longTitle }))).toBe(close);
      expect(button(t("oct6Beta.switchTabs", { count: 2 })).getAttribute("aria-expanded")).toBe("true");
      expect(container.querySelector("output")?.textContent).toBe("plan");
    }
  });

  it("shows full titles, selects a tab, and returns focus to the title selector", async () => {
    await click("Switch tabs, 2 open");
    expect(button(longTitle).textContent).toContain(longTitle);
    expect(button(longTitle).getAttribute("aria-current")).toBe("true");
    await act(async () => {
      button(longTitle).focus();
      button(longTitle).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(button("Properties"));
    await click("Properties");
    expect(container.querySelector("output")?.textContent).toBe("properties");
    expect(document.querySelector('ul[aria-label="Open tabs"]')).toBeNull();
  });

  it("keeps the current tab on inactive close and offers an empty state after the last close", async () => {
    await click("Switch tabs, 2 open");
    await click("Close Properties");
    expect(container.querySelector("output")?.textContent).toBe("plan");
    expect(button("Switch tabs, 1 open").getAttribute("aria-expanded")).toBe("true");
    await click(`Close ${longTitle}`);
    expect(container.querySelector("output")?.textContent).toBe("empty");
    expect(button("Switch tabs, 0 open").disabled).toBe(true);
    expect(document.querySelector('ul[aria-label="Open tabs"]')).toBeNull();
  });

  it("chooses a neighbor and keeps keyboard focus in the overview when closing the active tab", async () => {
    await click("Switch tabs, 2 open");
    await click(`Close ${longTitle}`);
    expect(container.querySelector("output")?.textContent).toBe("properties");
    expect(document.activeElement).toBe(button("Properties"));
  });
});

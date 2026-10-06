// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageTabBar, type PageTabItem } from "./PageTabBar";
import { Tabs } from "./ui/tabs";

const sidebar = vi.hoisted(() => ({ isMobile: true }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => sidebar }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("PageTabBar", () => {
  const items: PageTabItem[] = [
    { value: "plain", label: "Plain label" },
    { value: "rich", label: <span>Rich label <strong>2</strong></span>, mobileLabel: "Rich label 2" },
    { value: "fallback", label: <span>Legacy label</span> },
  ];

  afterEach(() => { sidebar.isMobile = true; });

  it("uses explicit mobile text and preserves legacy fallbacks and raw change values", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onValueChange = vi.fn();
    try {
      await act(async () => { root.render(<PageTabBar items={items} value="plain" onValueChange={onValueChange} />); });
      const select = container.querySelector("select")!;
      expect(Array.from(select.options, (option) => [option.value, option.textContent])).toEqual([
        ["plain", "Plain label"], ["rich", "Rich label 2"], ["fallback", "fallback"],
      ]);
      expect(select.querySelector("span, strong")).toBeNull();
      await act(async () => {
        select.value = "rich";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(onValueChange).toHaveBeenCalledExactlyOnceWith("rich");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([true, false])("keeps rich tabs when the mobile select is not enabled (mobile=%s)", async (isMobile) => {
    sidebar.isMobile = isMobile;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<Tabs defaultValue="rich"><PageTabBar items={items} value="rich" /></Tabs>);
      });
      expect(container.querySelector("select")).toBeNull();
      expect(container.querySelector('[role="tab"][data-state="active"] strong')?.textContent).toBe("2");
      expect(container.textContent).toContain("Legacy label");
    } finally {
      await act(async () => root.unmount());
    }
  });
});

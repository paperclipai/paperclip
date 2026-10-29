// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSidePanelTabs } from "./use-side-panel-tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useSidePanelTabs", () => {
  const mounted: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of mounted) act(() => root.unmount());
    mounted.length = 0;
  });

  it("reports initial and updated serializable state to the persistence boundary", async () => {
    const onStateChange = vi.fn();
    function Harness() {
      const controller = useSidePanelTabs({
        initialState: {
          tabs: [{ id: "details", type: "details", label: "Details", payload: { source: "fixture" } }],
          activeTabId: "details",
        },
        onStateChange,
      });
      return (
        <button
          type="button"
          onClick={() => controller.openTab({
            id: "history",
            type: "history",
            label: "History",
            payload: { source: "fixture" },
          })}
        >
          Open history
        </button>
      );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => root.render(<Harness />));
    expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ activeTabId: "details" }));

    await act(async () => container.querySelector("button")?.click());
    expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      activeTabId: "history",
      tabs: expect.arrayContaining([expect.objectContaining({ id: "history" })]),
    }));
    container.remove();
  });
});

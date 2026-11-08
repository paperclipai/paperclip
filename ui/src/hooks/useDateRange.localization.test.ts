// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { PRESET_LABELS, useDateRange } from "./useDateRange";

afterEach(async () => { vi.useRealTimers(); await i18n.changeLanguage("en"); });

it("updates a mounted date preset label without resetting custom range state", async () => {
  document.body.innerHTML = "<div id='root'></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  let range: ReturnType<typeof useDateRange>;
  function Harness() {
    range = useDateRange();
    return createElement("span", null, PRESET_LABELS[range.preset]);
  }
  try {
    await i18n.changeLanguage("en");
    await act(async () => { root.render(createElement(Harness)); });
    expect(container.textContent).toBe("Month to Date");
    await act(async () => { range.setPreset("custom"); range.setCustomFrom("2026-10-01"); range.setCustomTo("2026-10-31"); });
    const from = range!.from;
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(container.textContent).toBe("自定义");
    expect(range!.customFrom).toBe("2026-10-01");
    expect(range!.from).toBe(from);
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container.textContent).toBe("Custom");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  }
});

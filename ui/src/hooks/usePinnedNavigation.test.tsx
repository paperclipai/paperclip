// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { usePinnedNavigation } from "./usePinnedNavigation";

it("reorders hundreds of pins without nested scans and preserves hidden-company slots", async () => {
  const key = "paperclip.coordinator.pinned-nav.v1:pin-review";
  const visible = Array.from({ length: 500 }, (_, index) => `agent-chat:company:agent-${index}`);
  const hidden = "agent-chat:other-company:hidden";
  localStorage.setItem(key, JSON.stringify([...visible.slice(0, 250), hidden, ...visible.slice(250)]));
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let navigation!: ReturnType<typeof usePinnedNavigation>;
  function Harness() { navigation = usePinnedNavigation("pin-review"); return null; }
  const original = Array.prototype.includes;
  let scanned = 0;
  const includes = vi.spyOn(Array.prototype, "includes").mockImplementation(function (this: unknown[], value: unknown, from?: number) {
    if (this.length >= 500 && typeof value === "string" && value.startsWith("agent-chat:")) {
      scanned += this.length;
      if (scanned > visible.length * 3) throw new Error("Pin reordering scans growing lists repeatedly");
    }
    return original.call(this, value, from);
  });
  try {
    await act(async () => root.render(<Harness />));
    const before = navigation.pins;
    await act(async () => root.render(<Harness />));
    expect(navigation.pins).toBe(before);
    await act(async () => navigation.reorder([...visible].reverse()));
    const saved = JSON.parse(localStorage.getItem(key)!);
    expect(saved[250]).toBe(hidden);
    expect(saved.filter((entry: string) => entry !== hidden)).toEqual([...visible].reverse());
    expect(scanned).toBeLessThanOrEqual(visible.length * 3);
  } finally {
    includes.mockRestore();
    await act(async () => root.unmount());
    host.remove(); localStorage.removeItem(key);
  }
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConfigSaveBar } from "./AgentConfigSaveBar";

// React chooses the animation event name at import time; jsdom has no AnimationEvent constructor.
vi.hoisted(() => { Object.defineProperty(window, "AnimationEvent", { configurable: true, value: Event }); });

let root: Root;
let host: HTMLDivElement;
const save = vi.fn(), discard = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(dirty = false, saving = false, savedVersion = 0) {
  await act(() => root.render(<AgentConfigSaveBar dirty={dirty} saving={saving} savedVersion={savedVersion} onSave={save} onDiscard={discard} />));
}
const visible = () => host.querySelector("footer")?.getAttribute("data-visible") === "true";
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("Identity save footer", () => {
  it("stays hidden on entry and hides on undo/discard without claiming a save", async () => {
    await render(); expect(visible()).toBe(false);
    await render(true); expect(visible()).toBe(true);
    await render(); expect(visible()).toBe(false);
    expect(host.textContent).not.toContain("Saved changes");
  });
  it("holds for two seconds after the saved label finishes entering", async () => {
    await render(true);
    await render(true, true);
    await render(false, false, 1);
    expect(visible()).toBe(true);
    expect(host.textContent).toContain("Saved changes");
    await advance(3000); expect(visible()).toBe(true); // animation has not ended
    await act(() => host.querySelector(".agent-save-status-in")!.dispatchEvent(new Event("animationend", { bubbles: true })));
    await advance(1999); expect(visible()).toBe(true);
    await advance(1); expect(visible()).toBe(false);
    expect(host.querySelector(".agent-save-status-in")?.textContent).toContain("Saved changes");
  });
  it("keeps a new dirty draft visible when the prior success timer expires", async () => {
    await render(true); await render(false, false, 1);
    await act(() => host.querySelector(".agent-save-status-in")!.dispatchEvent(new Event("animationend", { bubbles: true })));
    await advance(1000); await render(true, false, 1); await advance(3000);
    expect(visible()).toBe(true);
    expect(host.textContent).not.toContain("Saved changes");
  });
  it("holds successful saves with reduced motion without waiting for an animation event", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    await render(true); await render(false, false, 1);
    await advance(1999); expect(visible()).toBe(true);
    await advance(1); expect(visible()).toBe(false);
  });
  it("does not show success after a failed save", async () => {
    await render(true); await render(true, true); await render(true);
    expect(visible()).toBe(true);
    expect(host.textContent).not.toContain("Saved changes");
  });
});

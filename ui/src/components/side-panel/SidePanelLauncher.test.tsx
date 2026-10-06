// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileText } from "lucide-react";
import { SidePanelLauncher } from "./SidePanelLauncher";
import { setLocale } from "@/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

describe("SidePanelLauncher", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    setLocale("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setLocale("en");
  });

  it("renders grouped loading, failure, disabled, and already-open states", async () => {
    await act(async () => root.render(
      <SidePanelLauncher
        sections={[
          { id: "open", label: "Open", items: [{ id: "plan", label: "Plan", icon: <FileText />, alreadyOpen: true }] },
          { id: "loading", label: "Recent", items: [], loading: true },
          { id: "failed", label: "Remote", items: [], error: "Recent files unavailable." },
          { id: "disabled", items: [{ id: "files", label: "Files", disabled: true, disabledReason: "No workspace." }] },
        ]}
        onSelect={() => {}}
      />,
    ));
    expect(container.textContent).toContain("Loading…");
    expect(container.textContent).toContain("Recent files unavailable.");
    expect(container.textContent).toContain("No workspace.");
    expect(container.querySelector('[aria-label="Already open"]')).not.toBeNull();
    expect(container.querySelector('[aria-disabled="true"]')).not.toBeNull();
  });

  it("selects enabled caller-provided items", async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(
      <SidePanelLauncher
        sections={[{ id: "docs", items: [{ id: "plan", label: "Plan" }] }]}
        onSelect={onSelect}
      />,
    ));
    const option = container.querySelector<HTMLElement>('[role="option"]')!;
    await act(async () => option.click());
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "plan" }));
  });

  it("keeps search and caller data when switching the default launcher to Russian", async () => {
    const onSelect = vi.fn();
    const item = { id: "raw-plan-id", label: "Plan / user title", alreadyOpen: true };
    await act(async () => root.render(<SidePanelLauncher sections={[{ id: "docs", label: "Custom section", items: [item] }]} onSelect={onSelect} />));
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Plan");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => setLocale("ru"));
    expect(input.value).toBe("Plan");
    expect(input.getAttribute("placeholder")).toBe("Поиск вкладок и ресурсов…");
    expect(container.textContent).toContain("Custom section");
    expect(container.textContent).toContain("Plan / user title");
    expect(container.querySelector('[aria-label="Уже открыто"]')).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLElement>('[role="option"]')!.click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(item);
    await act(async () => setLocale("en"));
    expect(input.value).toBe("Plan");
    expect(input.getAttribute("placeholder")).toBe("Search tabs and resources…");
  });
});

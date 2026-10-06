// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { InlineEntitySelector } from "./InlineEntitySelector";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

describe("InlineEntitySelector", () => {
  let container: HTMLDivElement;
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    container.remove();
    document.body.innerHTML = "";
  });

  it.each([false, true])("allows wheel and touch scrolling outside a parent dialog (mobile: %s)", async (mobile) => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: mobile && query === "(max-width: 40rem)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const root = createRoot(container);
    await act(() => {
      root.render(
        <Dialog defaultOpen>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>New task</DialogTitle>
            <InlineEntitySelector
              value=""
              options={Array.from({ length: 20 }, (_, index) => ({ id: `agent-${index}`, label: `Agent ${index}` }))}
              placeholder="Assignee"
              noneLabel="No assignee"
              searchPlaceholder="Search assignees..."
              emptyMessage="No assignees found."
              onChange={vi.fn()}
              triggerTestId="nested-assignee-picker"
              openOnFocus={false}
              modal
            />
          </DialogContent>
        </Dialog>,
      );
    });
    try {
      await act(() => {
        document.querySelector<HTMLButtonElement>("[data-testid=nested-assignee-picker]")!.click();
      });
      // Let both real Radix scroll locks install their document listeners.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const list = document.querySelector<HTMLElement>("[data-mobile-entity-picker-list]")!;
      expect(list).not.toBeNull();
      expect(document.querySelector("[data-slot=dialog-content]")!.contains(list)).toBe(false);
      // jsdom has no layout; supply the geometry of a list with more rows than fit.
      list.style.overflowY = "auto";
      Object.defineProperties(list, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 200 },
      });
      const option = list.querySelector("button")!;
      const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
      option.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(false);
      const touch = (type: string, y: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: [{ clientX: 100, clientY: y }] },
          changedTouches: { value: [{ clientX: 100, clientY: y }] },
        });
        option.dispatchEvent(event);
        return event;
      };
      touch("touchstart", 150);
      expect(touch("touchmove", 100).defaultPrevented).toBe(false);
      // The background stays locked while the picker is open.
      const outsideMove = new Event("touchmove", { bubbles: true, cancelable: true });
      Object.defineProperties(outsideMove, {
        touches: { value: [{ clientX: 100, clientY: 100 }] },
        changedTouches: { value: [{ clientX: 100, clientY: 100 }] },
      });
      document.body.dispatchEvent(outsideMove);
      expect(outsideMove.defaultPrevented).toBe(true);
    } finally {
      await act(() => root.unmount());
    }
  });

  it("opens on the next keyboard focus after a desktop outside dismissal", async () => {
    const root = createRoot(container);
    await act(() => {
      root.render(<>
        <button type="button" data-testid="outside-picker">Outside</button>
        <InlineEntitySelector
          value=""
          options={[{ id: "agent-1", label: "Agent One" }]}
          placeholder="Assignee"
          noneLabel="No assignee"
          searchPlaceholder="Search assignees..."
          emptyMessage="No assignees found."
          onChange={vi.fn()}
          triggerTestId="desktop-assignee-picker"
        />
      </>);
    });
    try {
      const trigger = container.querySelector<HTMLButtonElement>("[data-testid=desktop-assignee-picker]")!;
      const outside = container.querySelector<HTMLButtonElement>("[data-testid=outside-picker]")!;
      await act(() => trigger.click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      await act(() => {
        outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
        outside.focus();
        outside.click();
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(document.querySelector("[data-mobile-entity-picker]")).toBeNull();
      expect(document.activeElement).toBe(outside);
      await act(() => trigger.focus());
      expect(document.querySelector("[data-mobile-entity-picker]")).not.toBeNull();
    } finally {
      await act(() => root.unmount());
    }
  });

  it("dismisses the mobile project sheet from its backdrop and preserves the task dialog", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 40rem)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const onChange = vi.fn();
    const root = createRoot(container);
    await act(() => {
      root.render(
        <Dialog defaultOpen>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>New task</DialogTitle>
            <InlineEntitySelector
              value="project-1"
              options={[{ id: "project-1", label: "Board UI" }]}
              placeholder="Project"
              noneLabel="No project"
              searchPlaceholder="Search projects..."
              emptyMessage="No projects found."
              onChange={onChange}
              triggerTestId="project-picker"
              openOnFocus={false}
            />
          </DialogContent>
        </Dialog>,
      );
    });
    try {
      const trigger = document.querySelector<HTMLButtonElement>('[data-testid="project-picker"]')!;
      await act(() => trigger.click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const backdrop = document.querySelector<HTMLElement>("[data-mobile-entity-picker]")!.parentElement!;
      await act(() => {
        const pointerDown = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
        Object.defineProperty(pointerDown, "pointerType", { value: "touch" });
        backdrop.dispatchEvent(pointerDown);
        backdrop.click();
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(document.querySelector("[data-mobile-entity-picker]")).toBeNull();
      expect(document.querySelector("[data-slot=dialog-content]")).not.toBeNull();
      expect(trigger.textContent).toContain("Board UI");
      expect(document.activeElement).toBe(trigger);
      expect(onChange).not.toHaveBeenCalled();
      await act(() => trigger.click());
      expect(document.querySelector("[data-mobile-entity-picker]")).not.toBeNull();
    } finally {
      await act(() => root.unmount());
    }
  });

  it("keeps handled search navigation keys inside the popover", async () => {
    const root = createRoot(container);
    const onChange = vi.fn();
    const documentKeyDown = vi.fn();
    document.addEventListener("keydown", documentKeyDown);

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[
            { id: "agent:agent-1", label: "CodexCoder" },
            { id: "agent:agent-2", label: "DesignBot" },
          ]}
          placeholder="Responsible"
          noneLabel="No responsible"
          searchPlaceholder="Search responsible..."
          emptyMessage="No responsible found."
          onChange={onChange}
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const searchInput = document.querySelector('input[placeholder="Search responsible..."]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    searchInput?.focus();

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      searchInput?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    });

    expect(documentKeyDown).not.toHaveBeenCalled();

    await act(async () => {
      searchInput?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });

    expect(documentKeyDown).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith("agent:agent-1");

    document.removeEventListener("keydown", documentKeyDown);
    act(() => {
      root.unmount();
    });
  });

  it("focuses the search input when opened on coarse pointers", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(pointer: coarse)" || query === "(max-width: 40rem)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const root = createRoot(container);

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[
            { id: "agent:agent-1", label: "CodexCoder" },
            { id: "agent:agent-2", label: "DesignBot" },
          ]}
          placeholder="Responsible"
          noneLabel="No responsible"
          searchPlaceholder="Search responsible..."
          emptyMessage="No responsible found."
          onChange={vi.fn()}
          disablePortal
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const searchInput = document.querySelector('input[placeholder="Search responsible..."]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    expect(searchInput?.className).toContain("text-base");
    expect(document.querySelector("[data-mobile-entity-picker]")).not.toBeNull();
    expect(container.contains(document.querySelector("[data-mobile-entity-picker]"))).toBe(false);
    expect(document.querySelector("[data-mobile-entity-picker-header]")?.textContent).toContain("Responsible");
    expect(document.querySelector('button[aria-label="Close selector"]')).not.toBeNull();
    expect(document.activeElement).toBe(searchInput);

    await act(async () => {
      (document.querySelector('button[aria-label="Close selector"]') as HTMLButtonElement | null)?.click();
      await Promise.resolve();
    });
    expect(document.querySelector("[data-mobile-entity-picker]")).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("opens on programmatic focus without toggling an open popover closed", async () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[{ id: "project-1", label: "Project One" }]}
          placeholder="Project"
          noneLabel="No project"
          searchPlaceholder="Search projects..."
          emptyMessage="No projects found."
          onChange={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.focus();
      await Promise.resolve();
    });
    expect(
      document.querySelector('input[placeholder="Search projects..."]'),
    ).not.toBeNull();

    await act(async () => {
      trigger?.focus();
      await Promise.resolve();
    });
    expect(
      document.querySelector('input[placeholder="Search projects..."]'),
    ).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("does not open the popover when disabled", async () => {
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[{ id: "agent:agent-1", label: "CodexCoder" }]}
          placeholder="Responsible"
          noneLabel="No responsible"
          searchPlaceholder="Search responsible..."
          emptyMessage="No responsible found."
          onChange={onChange}
          disabled
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger?.disabled).toBe(true);

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.querySelector('input[placeholder="Search responsible..."]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("filters options as the user types in the search box", async () => {
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[
            { id: "agent:agent-1", label: "CodexCoder" },
            { id: "agent:agent-2", label: "DesignBot" },
          ]}
          placeholder="Responsible"
          noneLabel="No responsible"
          searchPlaceholder="Search responsible..."
          emptyMessage="No responsible found."
          onChange={onChange}
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const searchInput = document.querySelector('input[placeholder="Search responsible..."]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    const nativeInputValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeInputValue?.call(searchInput, "design");
      searchInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const optionLabels = Array.from(document.querySelectorAll("[role='dialog'] button, .max-h-56 button")).map(
      (el) => el.textContent ?? "",
    );
    const joined = optionLabels.join("|");
    expect(joined).toContain("DesignBot");
    expect(joined).not.toContain("CodexCoder");

    act(() => {
      root.unmount();
    });
  });
});

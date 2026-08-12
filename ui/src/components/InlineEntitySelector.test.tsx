// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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


function defaultMatchMedia(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
}

describe("InlineEntitySelector", () => {
  let container: HTMLDivElement;
  let roots: Root[] = [];
  let originalMatchMedia: typeof window.matchMedia;
  let originalMaxTouchPoints: number;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    originalMaxTouchPoints = window.navigator.maxTouchPoints;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount();
      });
    }
    roots = [];
    window.matchMedia = originalMatchMedia ?? defaultMatchMedia;
    Object.defineProperty(window.navigator, "maxTouchPoints", {
      configurable: true,
      value: originalMaxTouchPoints,
    });
    document.body.replaceChildren();
  });

  function createTestRoot() {
    const root = createRoot(container);
    roots.push(root);
    return root;
  }

  it("keeps handled search navigation keys inside the popover", async () => {
    const root = createTestRoot();
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

    document.removeEventListener("keydown", documentKeyDown);  });

  it("does not focus or raise the keyboard for search input on coarse pointers", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const root = createTestRoot();

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
    expect(document.activeElement).not.toBe(searchInput);
    expect(searchInput?.readOnly).toBe(true);
    expect(searchInput?.inputMode).toBe("none");
    expect(searchInput?.autocomplete).toBe("off");
    expect(searchInput?.getAttribute("autocorrect")).toBe("off");
    expect(searchInput?.getAttribute("autocapitalize")).toBe("off");
    expect(searchInput?.getAttribute("spellcheck")).toBe("false");
    expect(searchInput?.className).toContain("paperclip-mobile-control-font-size");
  });

  it("treats touch-only devices as coarse even when the pointer media query is false", async () => {
    Object.defineProperty(window.navigator, "maxTouchPoints", {
      configurable: true,
      value: 5,
    });
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(hover: none)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const root = createTestRoot();

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[{ id: "agent:agent-1", label: "CodexCoder" }]}
          placeholder="Responsible"
          noneLabel="No responsible"
          searchPlaceholder="Search responsible..."
          emptyMessage="No responsible found."
          onChange={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const searchInput = document.querySelector('input[placeholder="Search responsible..."]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    expect(searchInput?.readOnly).toBe(true);
    expect(searchInput?.inputMode).toBe("none");
    expect(document.activeElement).not.toBe(searchInput);
  });

  it("keeps desktop search typeable and focused", async () => {
    Object.defineProperty(window.navigator, "maxTouchPoints", {
      configurable: true,
      value: 0,
    });
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const root = createTestRoot();

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
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const searchInput = document.querySelector('input[placeholder="Search responsible..."]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    expect(document.activeElement).toBe(searchInput);
    expect(searchInput?.readOnly).toBe(false);
    expect(searchInput?.inputMode).toBe("");
    expect(searchInput?.className).toContain("paperclip-mobile-control-font-size");
  });

  it("keeps search typeable on touchscreen laptops with hover-capable primary input", async () => {
    Object.defineProperty(window.navigator, "maxTouchPoints", {
      configurable: true,
      value: 5,
    });
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(any-hover: hover)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const root = createTestRoot();

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[{ id: "agent:agent-1", label: "CodexCoder" }]}
          placeholder="Responsible"
          noneLabel="No responsible"
          searchPlaceholder="Search responsible..."
          emptyMessage="No responsible found."
          onChange={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const searchInput = document.querySelector('input[placeholder="Search responsible..."]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    expect(searchInput?.readOnly).toBe(false);
    expect(searchInput?.inputMode).toBe("");
    expect(document.activeElement).toBe(searchInput);
  });

  it("reconciles search focus when pointer mode changes while open", async () => {
    let isCoarsePointer = false;
    const changeHandlers = new Map<string, () => void>();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return query === "(pointer: coarse)" ? isCoarsePointer : false;
      },
      media: query,
      onchange: null,
      addEventListener: vi.fn((_type: string, handler: () => void) => {
        changeHandlers.set(query, handler);
      }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const root = createTestRoot();

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
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const searchInput = document.querySelector('input[placeholder="Search responsible..."]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    expect(document.activeElement).toBe(searchInput);

    await act(async () => {
      isCoarsePointer = true;
      changeHandlers.get("(pointer: coarse)")?.();
    });

    expect(document.activeElement).not.toBe(searchInput);
    expect(searchInput?.readOnly).toBe(true);
    expect(searchInput?.inputMode).toBe("none");

    await act(async () => {
      isCoarsePointer = false;
      changeHandlers.get("(pointer: coarse)")?.();
    });

    expect(document.activeElement).toBe(searchInput);
    expect(searchInput?.readOnly).toBe(false);
    expect(searchInput?.inputMode).toBe("");
    expect(changeHandlers.has("(hover: none)")).toBe(true);
    expect(changeHandlers.has("(any-hover: hover)")).toBe(true);
  });
});

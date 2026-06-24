// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchableSelect, type SearchableSelectGroup, type SearchableSelectOption } from "./SearchableSelect";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function render(node: ReactNode, container: HTMLElement) {
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return root;
}

function setInputValue(input: HTMLInputElement, value: string) {
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  });
}

describe("SearchableSelect", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    globalThis.ResizeObserver = originalResizeObserver!;
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders grouped duplicate options while keeping selection by value", async () => {
    const onValueChange = vi.fn();
    const alpha: SearchableSelectOption = { key: "recent:alpha", value: "alpha", label: "Alpha" };
    const groups: SearchableSelectGroup[] = [
      { id: "recent", label: "Recent", options: [alpha] },
      { id: "all", label: "All", options: [{ ...alpha, key: "all:alpha" }] },
    ];

    root = render(
      <SearchableSelect
        value="alpha"
        groups={groups}
        onValueChange={onValueChange}
        placeholder="Pick one"
        disablePortal
        renderOption={(option) => <span data-option-key={option.key}>{option.label}</span>}
      />,
      container,
    );

    const trigger = container.querySelector("button[role='combobox']") as HTMLButtonElement | null;
    expect(trigger?.textContent).toContain("Alpha");

    act(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(container.querySelector("[data-option-key='recent:alpha']")).not.toBeNull();
    expect(container.querySelector("[data-option-key='all:alpha']")).not.toBeNull();
  });

  it("filters options and returns the selected option object", async () => {
    const onValueChange = vi.fn();
    const bravo = { key: "all:bravo", value: "bravo", label: "Bravo", searchText: "secondary branch" };
    const groups: SearchableSelectGroup[] = [
      {
        id: "all",
        label: "All",
        options: [
          { key: "all:alpha", value: "alpha", label: "Alpha", searchText: "primary branch" },
          bravo,
        ],
      },
    ];

    root = render(
      <SearchableSelect
        value=""
        groups={groups}
        onValueChange={onValueChange}
        placeholder="Pick one"
        searchPlaceholder="Search options..."
        disablePortal
      />,
      container,
    );

    const trigger = container.querySelector("button[role='combobox']") as HTMLButtonElement | null;
    act(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    const input = container.querySelector("input[placeholder='Search options...']") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    setInputValue(input!, "sec br");
    await flush();

    expect(container.textContent).not.toContain("Alpha");
    expect(container.textContent).toContain("Bravo");

    const bravoItem = Array.from(container.querySelectorAll("[cmdk-item]")).find((item) => item.textContent?.includes("Bravo"));
    expect(bravoItem).not.toBeUndefined();
    act(() => {
      bravoItem?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onValueChange).toHaveBeenCalledWith("bravo", bravo);
  });

  it("shows loading, empty, and disabled states", async () => {
    const onValueChange = vi.fn();

    root = render(
      <SearchableSelect
        value=""
        groups={[{ id: "all", options: [{ key: "all:alpha", value: "alpha", label: "Alpha" }] }]}
        onValueChange={onValueChange}
        placeholder="Pick one"
        loading
        loadingMessage="Loading choices..."
        disablePortal
      />,
      container,
    );

    const trigger = container.querySelector("button[role='combobox']") as HTMLButtonElement | null;
    act(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(container.textContent).toContain("Loading choices...");

    act(() => {
      root?.render(
        <SearchableSelect
          value=""
          groups={[{ id: "all", options: [{ key: "all:alpha", value: "alpha", label: "Alpha" }] }]}
          onValueChange={onValueChange}
          placeholder="Pick one"
          searchPlaceholder="Search options..."
          emptyMessage="Nothing matched."
          disablePortal
        />,
      );
    });
    const input = container.querySelector("input[placeholder='Search options...']") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    setInputValue(input!, "zzz");
    await flush();
    expect(container.textContent).toContain("Nothing matched.");

    act(() => {
      root?.render(
        <SearchableSelect
          value=""
          groups={[]}
          onValueChange={onValueChange}
          placeholder="Pick one"
          disabled
          disablePortal
        />,
      );
    });
    expect(container.querySelector("button[role='combobox']")?.hasAttribute("disabled")).toBe(true);
  });
});

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchableSelect, type SearchableSelectGroup, type SearchableSelectOption } from "./SearchableSelect";
import {
  buildReusableExecutionWorkspaceOptionGroups,
  reusableWorkspaceOptionMatches,
  type ReusableExecutionWorkspaceLike,
  type ReusableWorkspaceOption,
} from "@/lib/reusable-execution-workspaces";

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

function keyDown(target: Element, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function workspace(overrides: Partial<ReusableExecutionWorkspaceLike>): ReusableExecutionWorkspaceLike {
  return {
    id: overrides.id ?? "workspace-id",
    name: overrides.name ?? "Workspace",
    cwd: overrides.cwd ?? null,
    lastUsedAt: overrides.lastUsedAt ?? "2026-06-24T00:00:00.000Z",
    status: overrides.status,
    branchName: overrides.branchName,
  };
}

function buildWorkspaceSelectGroups(workspaces: readonly ReusableExecutionWorkspaceLike[]) {
  return buildReusableExecutionWorkspaceOptionGroups(workspaces, {
    now: "2026-06-24T12:00:00.000Z",
  }).map((group) => ({
    id: group.id,
    label: group.label,
    options: group.options,
  })) satisfies SearchableSelectGroup<string, ReusableWorkspaceOption>[];
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

  it("ranks visible label matches ahead of lower-quality search text matches", async () => {
    const onValueChange = vi.fn();
    const groups: SearchableSelectGroup[] = [
      {
        id: "all",
        label: "All",
        options: [
          {
            key: "all:path-only",
            value: "path-only",
            label: "Paperclip app",
            searchText: "/srv/paperclip/mobile-checkout",
          },
          {
            key: "all:mobile",
            value: "mobile",
            label: "Mobile agent chat",
            searchText: "/srv/paperclip/agent-chat",
          },
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
        renderOption={(option) => <span data-option-key={option.key}>{option.label}</span>}
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
    setInputValue(input!, "mobile");
    await flush();

    const renderedKeys = Array.from(container.querySelectorAll("[data-option-key]")).map((item) =>
      item.getAttribute("data-option-key"),
    );
    expect(renderedKeys).toEqual(["all:mobile", "all:path-only"]);

    const commandList = container.querySelector("[data-slot='command-list']");
    expect(commandList?.className).toContain("overscroll-contain");
    expect(commandList?.className).toContain("touch-pan-y");
  });

  it("applies custom filtering before custom scoring", async () => {
    const groups: SearchableSelectGroup[] = [
      {
        id: "all",
        options: [
          { key: "all:alpha", value: "alpha", label: "Alpha", searchText: "visible" },
          { key: "all:hidden", value: "hidden", label: "Hidden", searchText: "visible" },
        ],
      },
    ];

    root = render(
      <SearchableSelect
        value=""
        groups={groups}
        onValueChange={vi.fn()}
        placeholder="Pick one"
        searchPlaceholder="Search options..."
        disablePortal
        filterOption={(option, query) => option.value !== "hidden" && option.searchText === query}
        scoreOption={() => 0}
        renderOption={(option) => <span data-option-key={option.key}>{option.label}</span>}
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
    setInputValue(input!, "visible");
    await flush();

    const renderedKeys = Array.from(container.querySelectorAll("[data-option-key]")).map((item) =>
      item.getAttribute("data-option-key"),
    );
    expect(renderedKeys).toEqual(["all:alpha"]);
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

  it("opens on focus and closes with Escape", async () => {
    root = render(
      <SearchableSelect
        value=""
        groups={[{ id: "all", options: [{ key: "all:alpha", value: "alpha", label: "Alpha" }] }]}
        onValueChange={vi.fn()}
        placeholder="Pick one"
        searchPlaceholder="Search options..."
        disablePortal
      />,
      container,
    );

    const trigger = container.querySelector("button[role='combobox']") as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.focus();
    });
    await flush();

    const input = container.querySelector("input[placeholder='Search options...']") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");

    keyDown(input!, "Escape");
    await flush();

    expect(container.querySelector("input[placeholder='Search options...']")).toBeNull();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      trigger?.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
      trigger?.focus();
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(container.querySelector("input[placeholder='Search options...']")).not.toBeNull();
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");

    const reopenedInput = container.querySelector("input[placeholder='Search options...']") as HTMLInputElement | null;
    expect(reopenedInput).not.toBeNull();
    setInputValue(reopenedInput!, "alp");
    await flush();

    keyDown(reopenedInput!, "Escape");
    await flush();

    expect(container.querySelector("input[placeholder='Search options...']")).toBeNull();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
  });

  it("filters workspace options, moves with arrows, and selects the workspace id with Enter", async () => {
    const onValueChange = vi.fn();
    const groups = buildWorkspaceSelectGroups([
      workspace({
        id: "workspace-paperclip",
        name: "Paperclip app",
        cwd: "/srv/paperclip/home/paperclipai/paperclip/.paperclip/worktrees/PAP-11722-new-existing-workspace-selector",
        branchName: "feature/reusable-workspaces",
        status: "running",
        lastUsedAt: "2026-06-24T10:00:00.000Z",
      }),
      workspace({
        id: "workspace-marketing",
        name: "Marketing site",
        cwd: "/srv/paperclip/home/marketing-site",
        branchName: "landing-refresh",
        status: "idle",
        lastUsedAt: "2026-06-20T10:00:00.000Z",
      }),
    ]);

    root = render(
      <SearchableSelect<string, ReusableWorkspaceOption>
        value=""
        groups={groups}
        onValueChange={onValueChange}
        placeholder="Choose an existing workspace"
        searchPlaceholder="Search workspaces..."
        filterOption={(option, query) => reusableWorkspaceOptionMatches(option, query)}
        disablePortal
        renderOption={(option, { selected }) => (
          <span data-option-key={option.key} data-selected={String(selected)}>
            {option.label}
          </span>
        )}
      />,
      container,
    );

    const trigger = container.querySelector("button[role='combobox']") as HTMLButtonElement | null;
    act(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    const input = container.querySelector("input[placeholder='Search workspaces...']") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(container.textContent).toContain("Recent");
    expect(container.textContent).toContain("All workspaces");

    setInputValue(input!, "pclip reusable");
    await flush();

    expect(container.textContent).toContain("Paperclip app");
    expect(container.textContent).not.toContain("Marketing site");

    const selectedOptionKey = () => (
      container.querySelector("[cmdk-item][aria-selected='true'] [data-option-key]")?.getAttribute("data-option-key")
    );

    expect(selectedOptionKey()).toBe("recent:workspace-paperclip");
    keyDown(input!, "ArrowDown");
    await flush();
    expect(selectedOptionKey()).toBe("all:workspace-paperclip");

    keyDown(input!, "ArrowUp");
    await flush();
    expect(selectedOptionKey()).toBe("recent:workspace-paperclip");

    keyDown(input!, "ArrowDown");
    await flush();
    keyDown(input!, "Enter");
    await flush();

    expect(onValueChange).toHaveBeenCalledWith(
      "workspace-paperclip",
      expect.objectContaining({
        key: "all:workspace-paperclip",
        value: "workspace-paperclip",
        workspaceId: "workspace-paperclip",
      }),
    );
    expect(container.querySelector("input[placeholder='Search workspaces...']")).toBeNull();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      trigger?.focus();
    });
    await flush();

    expect(container.querySelector("input[placeholder='Search workspaces...']")).toBeNull();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
  });
});

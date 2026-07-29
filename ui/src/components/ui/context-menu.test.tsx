// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./context-menu";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ContextMenu", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  function render(node: React.ReactElement) {
    root = createRoot(container);
    act(() => {
      root!.render(node);
    });
  }

  function rightClick(target: HTMLElement) {
    act(() => {
      target.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      );
    });
  }

  function selectItem(item: HTMLElement) {
    // Radix menu items select on pointerup-driven click; a plain click event
    // is what jsdom can deliver and Radix accepts it.
    act(() => {
      item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      item.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
      item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  function menuItems(): HTMLElement[] {
    return Array.from(document.querySelectorAll('[data-slot="context-menu-item"]'));
  }

  it("is closed until the trigger receives a contextmenu event", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-testid="row">row</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Open in new tab</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );

    expect(document.querySelector('[data-slot="context-menu-content"]')).toBeNull();

    rightClick(container.querySelector('[data-testid="row"]') as HTMLElement);

    const content = document.querySelector('[data-slot="context-menu-content"]');
    expect(content).not.toBeNull();
    expect(content!.getAttribute("data-state")).toBe("open");
    expect(menuItems().map((el) => el.textContent)).toContain("Open in new tab");
  });

  it("suppresses the native browser menu on the trigger", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-testid="row">row</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Copy link</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );

    const row = container.querySelector('[data-testid="row"]') as HTMLElement;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    act(() => {
      row.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("invokes onSelect for the clicked item and closes the menu", () => {
    const onOpen = vi.fn();
    const onCopy = vi.fn();
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-testid="row">row</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onOpen}>Open in new tab</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onCopy}>Copy link</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );

    rightClick(container.querySelector('[data-testid="row"]') as HTMLElement);

    const copy = menuItems().find((el) => el.textContent === "Copy link");
    expect(copy).not.toBeUndefined();
    selectItem(copy!);

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="context-menu-content"]')).toBeNull();
  });

  it("does not select disabled items", () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-testid="row">row</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled onSelect={onSelect}>
            Run now
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );

    rightClick(container.querySelector('[data-testid="row"]') as HTMLElement);

    const item = menuItems().find((el) => el.textContent === "Run now") as HTMLElement;
    expect(item.getAttribute("data-disabled")).not.toBeNull();
    selectItem(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders submenu triggers for nested menus (status/priority pattern)", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-testid="row">row</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Set status</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>Done</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>,
    );

    rightClick(container.querySelector('[data-testid="row"]') as HTMLElement);

    const subTrigger = document.querySelector('[data-slot="context-menu-sub-trigger"]');
    expect(subTrigger).not.toBeNull();
    expect(subTrigger!.textContent).toContain("Set status");
    expect(subTrigger!.getAttribute("aria-haspopup")).toBe("menu");
  });
});

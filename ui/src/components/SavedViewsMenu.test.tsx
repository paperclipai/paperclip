// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SavedViewsMenu } from "./SavedViewsMenu";
import type { SavedView } from "../lib/saved-issue-views";
import {
  persistSavedViews,
  savedViewsStorageKey,
} from "../lib/saved-issue-views";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type ViewState = { statuses: string[] };
type Column = "status" | "id";

const normalizers = {
  normalizeViewState: (value: unknown): ViewState => {
    const candidate = value as Partial<ViewState> | null;
    return {
      statuses: Array.isArray(candidate?.statuses)
        ? candidate.statuses.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  },
  normalizeColumns: (value: unknown): Column[] => Array.isArray(value)
    ? (value as unknown[]).filter((entry): entry is Column => entry === "status" || entry === "id")
    : ["status"],
};

const location = { companyId: "company-1", collectionKey: "tasks" };

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

function renderMenu(onApply?: (view: SavedView<ViewState, Column>) => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const apply: (view: SavedView<ViewState, Column>) => void = onApply ?? vi.fn();
  const element = (
    <SavedViewsMenu
      companyId="company-1"
      collectionKey="tasks"
      snapshotViewState={{ statuses: [] }}
      snapshotColumns={["status"]}
      normalizers={normalizers}
      onApply={apply}
    />
  );
  if (typeof reactAct === "function") {
    reactAct(() => {
      root!.render(element);
    });
  } else {
    flushSync(() => {
      root!.render(element);
    });
  }
  return { container: container as HTMLDivElement, onApply: apply };
}

function dispatchClick(target: Element | null | undefined) {
  if (!target) throw new Error("click target not found");
  const fire = () => {
    // Radix menu triggers open on pointerdown with the main button pressed.
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  };
  if (typeof reactAct === "function") reactAct(fire);
  else flushSync(fire);
}

function setInputText(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  const fire = () => {
    if (setter) setter.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  if (typeof reactAct === "function") reactAct(fire);
  else flushSync(fire);
}

function pressKey(target: Element, key: string) {
  const fire = () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  };
  if (typeof reactAct === "function") reactAct(fire);
  else flushSync(fire);
}

function openMenu(trigger: Element | null) {
  dispatchClick(trigger);
  const menu = document.querySelector('[role="menu"]');
  expect(menu).toBeTruthy();
  return menu as HTMLElement;
}

function storedViews() {
  const raw = window.localStorage.getItem(savedViewsStorageKey(location));
  if (!raw) return null;
  return JSON.parse(raw).views as Array<{ id: string; name: string; viewState: unknown }>;
}

afterEach(() => {
  if (typeof reactAct === "function") {
    reactAct(() => {
      root?.unmount();
    });
  } else {
    root?.unmount();
  }
  container?.remove();
  root = null;
  container = null;
  window.localStorage.removeItem(savedViewsStorageKey(location));
});

describe("SavedViewsMenu", () => {
  it("renders a Views trigger without a count when nothing is saved", () => {
    const { container: rendered } = renderMenu();
    const trigger = rendered.querySelector("button[aria-label='Saved views']");
    expect(trigger?.textContent).toContain("Views");
    expect(trigger?.textContent).not.toMatch(/\d/);
  });

  it("shows the saved view count from storage", () => {
    persistSavedViews(location, [{
      id: "view-1",
      name: "Blocked work",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      viewState: { statuses: ["blocked"] },
      columns: ["status"],
    }]);
    const { container: rendered } = renderMenu();
    const trigger = rendered.querySelector("button[aria-label='Saved views (1)']");
    expect(trigger?.textContent).toContain("1");
  });

  it("saves the current filters under a typed name and persists them", () => {
    const { container: rendered } = renderMenu();
    openMenu(rendered.querySelector("button[aria-label='Saved views']"));

    const nameInput = document.querySelector('input[aria-label="Name for the current view"]') as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    setInputText(nameInput, "My blocked");

    const saveButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Save",
    );
    expect(saveButton?.hasAttribute("disabled")).toBe(false);
    dispatchClick(saveButton);

    const views = storedViews();
    expect(views).toHaveLength(1);
    expect(views?.[0]).toMatchObject({
      name: "My blocked",
      viewState: { statuses: [] },
      columns: ["status"],
    });
    expect(nameInput.value).toBe("");
    const trigger = rendered.querySelector("button[aria-label='Saved views (1)']");
    expect(trigger?.textContent).toContain("1");
  });

  it("applies a saved view through onApply and closes the menu", () => {
    persistSavedViews(location, [{
      id: "view-1",
      name: "Blocked work",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      viewState: { statuses: ["blocked"] },
      columns: ["status"],
    }]);
    const onApply = vi.fn();
    const { container: rendered } = renderMenu(onApply);
    openMenu(rendered.querySelector("button[aria-label='Saved views (1)']"));

    const applyButton = document.querySelector('button[title="Apply Blocked work"]');
    expect(applyButton?.textContent).toContain("Blocked work");
    dispatchClick(applyButton);

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0]).toMatchObject({
      id: "view-1",
      viewState: { statuses: ["blocked"] },
    });
    expect(document.querySelector('[role="menu"]')).toBeFalsy();
  });

  it("renames a view on Enter and persists the new name", () => {
    persistSavedViews(location, [{
      id: "view-1",
      name: "Blocked work",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      viewState: { statuses: ["blocked"] },
      columns: ["status"],
    }]);
    const { container: rendered } = renderMenu();
    openMenu(rendered.querySelector("button[aria-label='Saved views (1)']"));

    dispatchClick(document.querySelector('button[aria-label="Rename Blocked work"]'));
    const renameInput = document.querySelector('input[aria-label="Rename Blocked work"]') as HTMLInputElement;
    expect(renameInput).toBeTruthy();
    setInputText(renameInput, "Stalled work");
    pressKey(renameInput, "Enter");

    expect(storedViews()?.[0]).toMatchObject({ id: "view-1", name: "Stalled work" });
    expect(document.querySelector('[role="menu"]')).toBeTruthy();
  });

  it("cancels a rename on Escape without touching storage", () => {
    persistSavedViews(location, [{
      id: "view-1",
      name: "Blocked work",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      viewState: { statuses: ["blocked"] },
      columns: ["status"],
    }]);
    const { container: rendered } = renderMenu();
    openMenu(rendered.querySelector("button[aria-label='Saved views (1)']"));

    dispatchClick(document.querySelector('button[aria-label="Rename Blocked work"]'));
    const renameInput = document.querySelector('input[aria-label="Rename Blocked work"]') as HTMLInputElement;
    setInputText(renameInput, "Abandoned rename");
    pressKey(renameInput, "Escape");

    expect(document.querySelector('input[aria-label="Rename Blocked work"]')).toBeFalsy();
    expect(storedViews()?.[0]).toMatchObject({ name: "Blocked work" });
  });

  it("deletes a view and clears it from storage", () => {
    persistSavedViews(location, [{
      id: "view-1",
      name: "Blocked work",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      viewState: { statuses: ["blocked"] },
      columns: ["status"],
    }]);
    const { container: rendered } = renderMenu();
    openMenu(rendered.querySelector("button[aria-label='Saved views (1)']"));

    dispatchClick(document.querySelector('button[aria-label="Delete Blocked work"]'));

    expect(storedViews()).toEqual([]);
    expect(rendered.querySelector("button[aria-label='Saved views']")).toBeTruthy();
    expect(rendered.querySelector("button[aria-label='Saved views (1)']")).toBeFalsy();
  });

  it("shows a storage error and keeps in-memory state when writes fail", () => {
    const setItem = vi.spyOn(window.localStorage.__proto__, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      const { container: rendered } = renderMenu();
      openMenu(rendered.querySelector("button[aria-label='Saved views']"));

      const nameInput = document.querySelector('input[aria-label="Name for the current view"]') as HTMLInputElement;
      setInputText(nameInput, "Lost view");
      const saveButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Save",
      );
      dispatchClick(saveButton);

      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Browser storage is unavailable");
      expect(rendered.querySelector("button[aria-label='Saved views (1)']")).toBeFalsy();
      expect(window.localStorage.getItem(savedViewsStorageKey(location))).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });
});

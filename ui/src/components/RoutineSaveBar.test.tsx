// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineSaveBar } from "./RoutineSaveBar";
import type { RoutineHistoryDirtyFieldDescriptor } from "./RoutineHistoryTab";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const DIRTY: RoutineHistoryDirtyFieldDescriptor[] = [
  { key: "title", label: "the title" },
  { key: "description", label: "the description" },
];

function renderBar(props: Partial<React.ComponentProps<typeof RoutineSaveBar>>) {
  const handlers = {
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onReload: vi.fn(),
  };
  act(() => {
    root.render(
      <RoutineSaveBar
        dirtyFields={props.dirtyFields ?? []}
        isSaving={props.isSaving ?? false}
        saveConflict={props.saveConflict ?? false}
        onSave={props.onSave ?? handlers.onSave}
        onDiscard={props.onDiscard ?? handlers.onDiscard}
        onReload={props.onReload ?? handlers.onReload}
      />,
    );
  });
  return handlers;
}

describe("RoutineSaveBar", () => {
  it("renders nothing when clean and no conflict", () => {
    renderBar({ dirtyFields: [] });
    expect(container.textContent).toBe("");
  });

  it("shows the unsaved change count when dirty", () => {
    renderBar({ dirtyFields: DIRTY });
    expect(container.textContent).toContain("2 unsaved changes");
  });

  it("invokes onSave on Cmd/Ctrl+S while dirty", () => {
    const handlers = renderBar({ dirtyFields: DIRTY });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true }));
    });
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
  });

  it("does not invoke onSave on Cmd+S when clean", () => {
    const handlers = renderBar({ dirtyFields: [] });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true }));
    });
    expect(handlers.onSave).not.toHaveBeenCalled();
  });

  it("surfaces the conflict recovery actions on saveConflict", () => {
    const handlers = renderBar({ dirtyFields: DIRTY, saveConflict: true });
    expect(container.textContent).toContain("Routine changed elsewhere");
    const buttons = Array.from(container.querySelectorAll("button"));
    const reload = buttons.find((button) => button.textContent?.includes("Reload latest"));
    const overwrite = buttons.find((button) => button.textContent?.includes("Overwrite anyway"));
    expect(reload).toBeTruthy();
    expect(overwrite).toBeTruthy();
    act(() => {
      reload!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handlers.onReload).toHaveBeenCalledTimes(1);
  });
});

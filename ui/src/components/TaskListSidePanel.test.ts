// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { isTaskListCoveredByPanel, isTaskListSidePanelCloseKey, taskListSidePanelFrame } from "./TaskListSidePanel";

describe("isTaskListCoveredByPanel", () => {
  it("covers the list only while an overlay panel shows a task", () => {
    expect(isTaskListCoveredByPanel("PAP-1", "overlay")).toBe(true);
    expect(isTaskListCoveredByPanel(null, "overlay")).toBe(false);
    expect(isTaskListCoveredByPanel("PAP-1", "docked")).toBe(false);
  });
});

describe("taskListSidePanelFrame", () => {
  it("docks the panel at a fixed share beside the list", () => {
    expect(taskListSidePanelFrame("docked")).toEqual({
      presentation: "docked",
      className: "w-(--task-list-side-panel-width) shrink-0",
    });
  });

  it("lays the overlay over the whole list so the list keeps its scroll underneath", () => {
    expect(taskListSidePanelFrame("overlay")).toEqual({ presentation: "sheet", className: "absolute inset-0 z-10" });
  });
});

function keyEvent(key: string, target: EventTarget | null = document.body, defaultPrevented = false) {
  return { key, target, defaultPrevented };
}

describe("isTaskListSidePanelCloseKey", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("closes on a plain Escape", () => {
    expect(isTaskListSidePanelCloseKey(keyEvent("Escape"))).toBe(true);
  });

  it("ignores other keys and handled events", () => {
    expect(isTaskListSidePanelCloseKey(keyEvent("Enter"))).toBe(false);
    expect(isTaskListSidePanelCloseKey(keyEvent("Escape", document.body, true))).toBe(false);
  });

  it("leaves Escape to a focused text field", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    expect(isTaskListSidePanelCloseKey(keyEvent("Escape", textarea))).toBe(false);
  });

  it("leaves Escape to an open dialog", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    expect(isTaskListSidePanelCloseKey(keyEvent("Escape"))).toBe(false);
  });
});

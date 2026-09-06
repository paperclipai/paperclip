// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  readTaskSidePanelState,
  taskPanelDocumentTab,
  taskPanelFilesTab,
  taskPanelPropertiesTab,
  taskPanelSubtasksTab,
  writeTaskSidePanelState,
} from "./task-side-panel-state";

describe("task side-panel persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips an intentionally empty task state", () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: { tabs: [], activeTabId: null },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: true,
      updatedAt: 1,
    });
    expect(readTaskSidePanelState("user-1", "company-1", "task-1", true)).toMatchObject({
      state: { tabs: [], activeTabId: null },
      userInteracted: true,
    });
  });

  it("isolates account and company state", () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: { tabs: [taskPanelPropertiesTab()], activeTabId: "properties" },
      launcherOpen: false,
      userInteracted: false,
      autoPlanHandled: false,
      updatedAt: 1,
    });
    expect(readTaskSidePanelState("user-2", "company-1", "task-1", true)).toBeNull();
    expect(readTaskSidePanelState("user-1", "company-2", "task-1", true)).toBeNull();
  });

  it("drops file tabs when the experiment is disabled while keeping documents", () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: {
        tabs: [taskPanelPropertiesTab(), taskPanelFilesTab(), taskPanelDocumentTab("plan", "Plan")],
        activeTabId: "files",
      },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: true,
      updatedAt: 1,
    });
    const restored = readTaskSidePanelState("user-1", "company-1", "task-1", false);
    expect(restored?.state.tabs.map((tab) => tab.id)).toEqual(["properties", "document:plan"]);
    expect(restored?.state.activeTabId).toBe("properties");
  });

  it("round-trips the Streamlined UI subtasks tab", () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: {
        tabs: [taskPanelPropertiesTab(), taskPanelSubtasksTab()],
        activeTabId: "subtasks",
      },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: true,
      updatedAt: 1,
    });

    const restored = readTaskSidePanelState("user-1", "company-1", "task-1", false);
    expect(restored?.state.tabs.map((tab) => tab.id)).toEqual(["properties", "subtasks"]);
    expect(restored?.state.activeTabId).toBe("subtasks");
  });

  it("retains only the 50 most recently written tasks", () => {
    for (let index = 0; index < 52; index += 1) {
      writeTaskSidePanelState("user-1", "company-1", `task-${index}`, {
        state: { tabs: [taskPanelPropertiesTab()], activeTabId: "properties" },
        launcherOpen: false,
        userInteracted: false,
        autoPlanHandled: false,
        updatedAt: index,
      });
    }
    expect(readTaskSidePanelState("user-1", "company-1", "task-0", true)).toBeNull();
    expect(readTaskSidePanelState("user-1", "company-1", "task-51", true)).not.toBeNull();
  });
});

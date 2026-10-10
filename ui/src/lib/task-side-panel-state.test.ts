// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  readTaskSidePanelState,
  taskPanelDocumentTab,
  taskPanelComputerTab,
  taskPanelFilesTab,
  taskPanelPropertiesTab,
  taskPanelSkillTab,
  taskPanelSubtasksTab,
  writeTaskSidePanelState,
  shouldSuppressTaskPanelUntilPlan,
  openSkillPanelState,
} from "./task-side-panel-state";

describe("task side-panel persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("persists only computer identity and removes accidental credentials before writing storage", () => {
    const environmentId = "12345678-1234-1234-1234-123456789012";
    const tab = taskPanelComputerTab(environmentId);
    const contaminated = { ...tab, viewerUrl: "https://viewer.example/#private-top-token",
      payload: { ...tab.payload, viewerUrl: "https://viewer.example/#private-payload-token", owner: { ownerId: "private-owner" }, secretHeaders: { Cookie: "private-cookie" } } };
    writeTaskSidePanelState("user-1", "company-1", "computer-task", {
      state: { tabs: [contaminated], activeTabId: tab.id }, launcherOpen: false, userInteracted: true, autoPlanHandled: true, updatedAt: 1,
    });
    const stored = window.localStorage.getItem(window.localStorage.key(0)!)!;
    expect(stored).not.toContain("private-");
    expect(stored).not.toContain("viewerUrl");
    expect(stored).not.toContain("secretHeaders");
    expect(readTaskSidePanelState("user-1", "company-1", "computer-task", true)?.state.tabs[0]?.payload)
      .toEqual({ kind: "computer", environmentId });

    // A later write also scrubs unsupported fields from retained task entries.
    const parsed = JSON.parse(stored);
    parsed.tasks["computer-task"].state.tabs[0].payload.viewerUrl = "https://viewer.example/#private-old-token";
    window.localStorage.setItem(window.localStorage.key(0)!, JSON.stringify(parsed));
    writeTaskSidePanelState("user-1", "company-1", "other-task", {
      state: { tabs: [taskPanelPropertiesTab()], activeTabId: "properties" }, launcherOpen: false, userInteracted: false, autoPlanHandled: false, updatedAt: 2,
    });
    expect(window.localStorage.getItem(window.localStorage.key(0)!)).not.toContain("private-old-token");
  });

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

  it("persists and restores a skill tab", () => {
    writeTaskSidePanelState("user-1", "company-1", "task-skill", {
      state: { tabs: [taskPanelPropertiesTab(), taskPanelSkillTab("skill-1", "Release helper")], activeTabId: "skill:skill-1" },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: false,
      updatedAt: 1,
    });
    expect(readTaskSidePanelState("user-1", "company-1", "task-skill", true)?.state).toMatchObject({
      activeTabId: "skill:skill-1",
      tabs: [{ id: "properties" }, { id: "skill:skill-1", payload: { kind: "skill", skillId: "skill-1" } }],
    });
  });

  it("keeps an onboarding panel open after skill acknowledgement", () => {
    const before = { panelBeforePlanOverrideIssueId: null };
    const opened = openSkillPanelState(before, { id: "skill-1", name: "Release helper" }, "task-1", true);
    expect(opened.panelBeforePlanOverrideIssueId).toBe("task-1");
    const acknowledged = { ...opened, skill: null };
    expect(shouldSuppressTaskPanelUntilPlan({ deferredPlanAvailable: false, panelBeforePlanOverride: acknowledged.panelBeforePlanOverrideIssueId === "task-1" })).toBe(false);
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

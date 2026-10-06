// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import {
  readTaskSidePanelState,
  taskPanelDocumentTab,
  taskPanelFilesTab,
  taskPanelPropertiesTab,
  taskPanelSkillTab,
  taskPanelTabLabelDisplay,
  taskPanelSubtasksTab,
  writeTaskSidePanelState,
  shouldSuppressTaskPanelUntilPlan,
  openSkillPanelState,
} from "./task-side-panel-state";

describe("task side-panel persistence", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(async () => { await i18n.changeLanguage("en"); });

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

  it("localizes only marked skill fallbacks without changing saved names or identities", async () => {
    await i18n.changeLanguage("ru");
    const tabs = [
      taskPanelSkillTab("unnamed"),
      taskPanelSkillTab("named", "Skill"),
      taskPanelSkillTab("raw", "Release helper / {{raw}}"),
      // Historical entries have no marker; even a label of Skill is user data.
      { ...taskPanelSkillTab("legacy"), payload: { kind: "skill" as const, skillId: "legacy" } },
    ];
    writeTaskSidePanelState("user-1", "company-1", "task-skill", {
      state: { tabs, activeTabId: "skill:unnamed" },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: false,
      updatedAt: 1,
    });
    const storedBytes = window.localStorage.getItem("paperclip:task-side-panel:v1:user-1:company-1");
    const restored = readTaskSidePanelState("user-1", "company-1", "task-skill", true)!.state;
    expect(restored.tabs).toEqual(tabs);
    expect(restored.activeTabId).toBe("skill:unnamed");
    expect(restored.tabs.map(taskPanelTabLabelDisplay)).toEqual(["Навык", "Skill", "Release helper / {{raw}}", "Skill"]);
    await i18n.changeLanguage("en");
    expect(restored.tabs.map(taskPanelTabLabelDisplay)).toEqual(["Skill", "Skill", "Release helper / {{raw}}", "Skill"]);
    await i18n.changeLanguage("ru");
    expect(taskPanelTabLabelDisplay(restored.tabs[0])).toBe("Навык");
    expect(window.localStorage.getItem("paperclip:task-side-panel:v1:user-1:company-1")).toBe(storedBytes);
    expect(restored.tabs[0].label).toBe("Skill");
    expect(restored.tabs[0].payload).toEqual({ kind: "skill", skillId: "unnamed", defaultLabel: true });
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

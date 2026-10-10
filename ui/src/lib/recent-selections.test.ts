// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  getRecentAssigneeIds,
  getRecentAssigneeSelectionIds,
  sortAgentsByRecency,
  trackRecentAssignee,
  trackRecentAssigneeUser,
} from "./recent-assignees";
import { getLastProjectId, getRecentProjectIds, trackRecentProject } from "./recent-projects";
import { getLastComposerEffort, rememberComposerEffort } from "./recent-composer-effort";
import { orderItemsBySelectedAndRecent } from "./recent-selections";

describe("recent selection ordering", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps the selected option first, then three recent options, then default order", () => {
    const ordered = orderItemsBySelectedAndRecent(
      [
        { id: "", label: "No project" },
        { id: "alpha", label: "Alpha" },
        { id: "bravo", label: "Bravo" },
        { id: "charlie", label: "Charlie" },
        { id: "delta", label: "Delta" },
        { id: "echo", label: "Echo" },
      ],
      "charlie",
      ["echo", "bravo", "delta", "alpha"],
    );

    expect(ordered.map((item) => item.id)).toEqual(["charlie", "echo", "bravo", "delta", "", "alpha"]);
  });

  it("keeps the no-value option first when it is selected", () => {
    const ordered = orderItemsBySelectedAndRecent(
      [
        { id: "", label: "No responsible" },
        { id: "agent-1", label: "Agent 1" },
        { id: "agent-2", label: "Agent 2" },
      ],
      "",
      ["agent-2"],
    );

    expect(ordered.map((item) => item.id)).toEqual(["", "agent-2", "agent-1"]);
  });

  it("only promotes the latest three assignees before default alphabetical order", () => {
    const agents = [
      { id: "alpha", name: "Alpha" },
      { id: "bravo", name: "Bravo" },
      { id: "charlie", name: "Charlie" },
      { id: "delta", name: "Delta" },
      { id: "echo", name: "Echo" },
    ];

    const sorted = sortAgentsByRecency(agents, ["delta", "bravo", "echo", "charlie"]);

    expect(sorted.map((agent) => agent.id)).toEqual(["delta", "bravo", "echo", "alpha", "charlie"]);
  });

  it("tracks recent project ids newest first without duplicates", () => {
    trackRecentProject("project-1");
    trackRecentProject("project-2");
    trackRecentProject("project-1");

    expect(getRecentProjectIds()).toEqual(["project-1", "project-2"]);
  });

  it("remembers projects and explicit No project separately for each company", () => {
    expect(getLastProjectId("company-1")).toBeUndefined();
    trackRecentProject("project-1", "company-1");
    trackRecentProject("project-2", "company-2");
    expect(getLastProjectId("company-1")).toBe("project-1");
    expect(getLastProjectId("company-2")).toBe("project-2");
    trackRecentProject("", "company-1");
    expect(getLastProjectId("company-1")).toBe("");
    expect(getLastProjectId("company-2")).toBe("project-2");
    expect(getRecentProjectIds()).toEqual(["project-2", "project-1"]);
  });

  it("remembers effort and an explicit Default choice within the company", () => {
    expect(getLastComposerEffort("company-1")).toBeUndefined();
    rememberComposerEffort("company-1", "high");
    rememberComposerEffort("company-2", "ultra");
    expect(getLastComposerEffort("company-1")).toBe("high");
    rememberComposerEffort("company-1", null);
    expect(getLastComposerEffort("company-1")).toBeNull();
    expect(getLastComposerEffort("company-2")).toBe("ultra");
    localStorage.setItem("paperclip:composer-effort:company-1", "broken json");
    expect(getLastComposerEffort("company-1")).toBeUndefined();
  });

  it("tracks recent user and agent assignee selections with prefixed ids", () => {
    trackRecentAssignee("agent-1");
    trackRecentAssigneeUser("user-1");

    expect(getRecentAssigneeSelectionIds()).toEqual(["user:user-1", "agent:agent-1"]);
    expect(getRecentAssigneeIds()).toEqual(["agent-1"]);
  });

  it("remembers assignees separately in each company", () => {
    trackRecentAssignee("agent-1", "company-1");
    trackRecentAssigneeUser("user-1", "company-2");
    trackRecentAssigneeUser("user-2", "company-1");

    expect(getRecentAssigneeSelectionIds("company-1")).toEqual(["user:user-2", "agent:agent-1"]);
    expect(getRecentAssigneeSelectionIds("company-2")).toEqual(["user:user-1"]);
    expect(getRecentAssigneeSelectionIds("company-3")).toEqual([]);
  });
});

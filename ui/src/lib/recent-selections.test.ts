// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  getRecentAssigneeIds,
  getRecentAssigneeSelectionIds,
  sortAgentsByRecency,
  trackRecentAssignee,
  trackRecentAssigneeUser,
} from "./recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "./recent-projects";
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
        { id: "", label: "No assignee" },
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

  it("tracks recent user and agent assignee selections with prefixed ids", () => {
    trackRecentAssignee("agent-1");
    trackRecentAssigneeUser("user-1");

    expect(getRecentAssigneeSelectionIds()).toEqual(["user:user-1", "agent:agent-1"]);
    expect(getRecentAssigneeIds()).toEqual(["agent-1"]);
  });
});

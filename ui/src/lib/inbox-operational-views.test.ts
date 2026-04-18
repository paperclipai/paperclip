// @vitest-environment node

import { describe, expect, it } from "vitest";
import { defaultIssueFilterState } from "./issue-filters";
import {
  buildInboxOperationalViews,
  getActiveInboxOperationalViewKey,
  getMissionControlOwnerAgents,
} from "./inbox-operational-views";

describe("inbox operational views", () => {
  it("limits owner views to the mission-control operators in stable order", () => {
    const ownerAgents = getMissionControlOwnerAgents([
      { id: "agent-3", name: "Stitch" },
      { id: "agent-4", name: "Someone Else" },
      { id: "agent-1", name: "Main" },
      { id: "agent-2", name: "Ork" },
      { id: "agent-5", name: "Personal OS" },
    ]);

    expect(ownerAgents.map((agent) => agent.name)).toEqual(["Main", "Ork", "Stitch", "Personal OS"]);
  });

  it("builds the blocked/waiting and recent-handoff operational views", () => {
    const views = buildInboxOperationalViews([{ id: "agent-1", name: "Main" }], true);

    expect(views.find((view) => view.key === "blocked_or_waiting")?.filterState).toMatchObject({
      statuses: ["backlog", "todo", "in_progress", "in_review", "blocked"],
      blockedOrWaiting: true,
      hideRoutineExecutions: true,
    });
    expect(views.find((view) => view.key === "recent_handoffs")?.filterState).toMatchObject({
      recentHandoffs: true,
      hideRoutineExecutions: true,
    });
  });

  it("detects the active operational view from filter state", () => {
    const views = buildInboxOperationalViews([
      { id: "agent-1", name: "Main" },
      { id: "agent-2", name: "Ork" },
    ], false);

    expect(getActiveInboxOperationalViewKey({
      ...defaultIssueFilterState,
      statuses: ["backlog", "todo", "in_progress", "in_review", "blocked"],
      owners: ["agent-2"],
    }, views)).toBe("owner:agent-2");

    expect(getActiveInboxOperationalViewKey(defaultIssueFilterState, views)).toBeNull();
  });
});

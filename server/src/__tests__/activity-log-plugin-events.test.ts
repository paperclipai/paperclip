import { describe, expect, it } from "vitest";
import { eventTypeForActivityAction } from "../services/activity-log.ts";

describe("activity-log plugin event mapping", () => {
  it("maps canonical agent lifecycle actions to themselves", () => {
    expect(eventTypeForActivityAction("agent.created")).toBe("agent.created");
    expect(eventTypeForActivityAction("agent.updated")).toBe("agent.updated");
    expect(eventTypeForActivityAction("agent.deleted")).toBe("agent.deleted");
  });

  it("maps agent pause/resume/terminate to agent.status_changed", () => {
    expect(eventTypeForActivityAction("agent.paused")).toBe("agent.status_changed");
    expect(eventTypeForActivityAction("agent.resumed")).toBe("agent.status_changed");
    expect(eventTypeForActivityAction("agent.terminated")).toBe("agent.status_changed");
  });

  it("returns null for unknown actions", () => {
    expect(eventTypeForActivityAction("agent.something_made_up")).toBeNull();
    expect(eventTypeForActivityAction("not_a_real_action")).toBeNull();
  });

  it("preserves existing comment/document/approval/budget mappings", () => {
    expect(eventTypeForActivityAction("issue_comment_created")).toBe("issue.comment.created");
    expect(eventTypeForActivityAction("issue.document_updated")).toBe("issue.document.updated");
    expect(eventTypeForActivityAction("approval.approved")).toBe("approval.decided");
    expect(eventTypeForActivityAction("budget.soft_threshold_crossed")).toBe(
      "budget.incident.opened",
    );
  });
});

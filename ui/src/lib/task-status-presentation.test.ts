import { describe, expect, it } from "vitest";
import { resolveTaskStatusPresentation } from "./task-status-presentation";

describe("execution-backed task status", () => {
  it.each([
    ["todo", "Todo"],
    ["in_review", "In Review"],
    ["blocked", "Blocked"],
    ["monitoring", "Monitoring"],
    ["in_progress", "In Progress"],
  ])("uses server presentation %s for a task whose lifecycle is in_progress", (displayStatus, label) => {
    expect(resolveTaskStatusPresentation({ status: "in_progress", displayStatus })).toEqual({
      glyphStatus: displayStatus, label, ariaLabel: label,
    });
  });

  it("keeps external conversation waits idle after projection", () => {
    expect(resolveTaskStatusPresentation({ status: "in_progress", displayStatus: "in_review", externalConversationState: "waiting" }))
      .toEqual({ glyphStatus: "idle", label: "Idle", ariaLabel: "Idle" });
  });

  it.each(["done", "cancelled", "blocked", "in_review", "todo"])("preserves an optimistic %s transition over a stale display status", (status) => {
    expect(resolveTaskStatusPresentation({ status, displayStatus: "in_progress" }).glyphStatus).toBe(status);
  });

  it("preserves status when the server did not send a projection", () => {
    expect(resolveTaskStatusPresentation({ status: "in_progress" }).label).toBe("In Progress");
    expect(resolveTaskStatusPresentation({ status: "done" }).label).toBe("Done");
  });
});

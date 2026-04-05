import { describe, expect, it } from "vitest";
import { statusBecameActionable } from "../routes/issues-status-actionable.js";

describe("statusBecameActionable", () => {
  it("returns true when in_review → todo", () => {
    expect(
      statusBecameActionable({
        requestStatus: "todo",
        previousStatus: "in_review",
        newStatus: "todo",
      }),
    ).toBe(true);
  });

  it("returns true when in_progress → todo", () => {
    expect(
      statusBecameActionable({
        requestStatus: "todo",
        previousStatus: "in_progress",
        newStatus: "todo",
      }),
    ).toBe(true);
  });

  it("returns true when done → todo", () => {
    expect(
      statusBecameActionable({
        requestStatus: "todo",
        previousStatus: "done",
        newStatus: "todo",
      }),
    ).toBe(true);
  });

  it("returns true when blocked → todo", () => {
    expect(
      statusBecameActionable({
        requestStatus: "todo",
        previousStatus: "blocked",
        newStatus: "todo",
      }),
    ).toBe(true);
  });

  it("returns true when cancelled → todo", () => {
    expect(
      statusBecameActionable({
        requestStatus: "todo",
        previousStatus: "cancelled",
        newStatus: "todo",
      }),
    ).toBe(true);
  });

  it("returns false when todo → in_progress (not transitioning to todo)", () => {
    expect(
      statusBecameActionable({
        requestStatus: "in_progress",
        previousStatus: "todo",
        newStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("returns false when backlog → todo (handled by statusChangedFromBacklog)", () => {
    expect(
      statusBecameActionable({
        requestStatus: "todo",
        previousStatus: "backlog",
        newStatus: "todo",
      }),
    ).toBe(false);
  });

  it("returns false when requestStatus is undefined (status not changed)", () => {
    expect(
      statusBecameActionable({
        requestStatus: undefined,
        previousStatus: "in_review",
        newStatus: "in_review",
      }),
    ).toBe(false);
  });

  it("returns false when transitioning between non-actionable states", () => {
    expect(
      statusBecameActionable({
        requestStatus: "done",
        previousStatus: "in_progress",
        newStatus: "done",
      }),
    ).toBe(false);
  });

  it("returns false when in_progress → backlog", () => {
    expect(
      statusBecameActionable({
        requestStatus: "backlog",
        previousStatus: "in_progress",
        newStatus: "backlog",
      }),
    ).toBe(false);
  });
});

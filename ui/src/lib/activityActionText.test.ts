import { describe, expect, it } from "vitest";
import { formatActivityAction } from "./activityActionText";

describe("formatActivityAction", () => {
  it("describes hidden issue updates explicitly", () => {
    expect(formatActivityAction("issue.updated", {
      hiddenAt: "2026-04-15T00:00:00.000Z",
      _previous: {
        hiddenAt: null,
      },
    })).toBe("hid the issue");
  });

  it("describes unhidden issue updates explicitly", () => {
    expect(formatActivityAction("issue.updated", {
      hiddenAt: null,
      _previous: {
        hiddenAt: "2026-04-15T00:00:00.000Z",
      },
    })).toBe("made the issue visible again");
  });

  it("preserves existing status-change wording", () => {
    expect(formatActivityAction("issue.updated", {
      status: "done",
      _previous: {
        status: "in_review",
      },
    })).toBe("changed the status from in review to done");
  });
});

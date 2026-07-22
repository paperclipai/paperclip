import { describe, expect, it } from "vitest";
import { defaultMeetingId } from "./meeting-selection.js";

describe("defaultMeetingId", () => {
  it("opens the newest meeting even when an older one has more issues", () => {
    const meetings = [
      { id: "new-clean", issue_count: 0 },
      { id: "old-rich", issue_count: 6 },
    ];
    expect(defaultMeetingId(meetings)).toBe("new-clean");
  });

  it("honours an explicit historical selection", () => {
    expect(defaultMeetingId([{ id: "new" }], "old")).toBe("old");
  });
});

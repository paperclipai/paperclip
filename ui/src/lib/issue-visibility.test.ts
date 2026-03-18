import { describe, expect, it } from "vitest";
import { getIssueVisibilityAction } from "./issue-visibility";

describe("getIssueVisibilityAction", () => {
  it("returns a hide action for visible issues", () => {
    const action = getIssueVisibilityAction(null, () => "2026-03-18T12:34:56.000Z");

    expect(action).toEqual({
      isHidden: false,
      label: "Hide this Issue",
      hiddenAt: "2026-03-18T12:34:56.000Z",
    });
  });

  it("returns an unhide action for hidden issues", () => {
    const action = getIssueVisibilityAction("2026-03-18T11:00:00.000Z", () => "unused");

    expect(action).toEqual({
      isHidden: true,
      label: "Unhide this Issue",
      hiddenAt: null,
    });
  });
});

import { describe, expect, it } from "vitest";
import { routineOverviewCopyText } from "./routine-description-copy";

describe("routineOverviewCopyText", () => {
  it("copies the draft while the description is being edited", () => {
    expect(routineOverviewCopyText({
      editing: true,
      draft: "- draft line",
      saved: "- saved line",
    })).toBe("- draft line");
  });

  it("copies the saved description when the overview is not being edited", () => {
    expect(routineOverviewCopyText({
      editing: false,
      draft: "- draft line",
      saved: "- saved line",
    })).toBe("- saved line");
  });

  it("copies an empty string when there is no saved description", () => {
    expect(routineOverviewCopyText({
      editing: false,
      draft: "",
      saved: null,
    })).toBe("");
  });
});

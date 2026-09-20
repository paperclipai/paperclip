import { describe, expect, it } from "vitest";
import { isNonSubstantiveModelWarningComment } from "./model-side-warning.js";

describe("isNonSubstantiveModelWarningComment", () => {
  it("detects the observed codex warning-only output", () => {
    expect(isNonSubstantiveModelWarningComment(
      [
        "Warning: Skill descriptions were shortened to fit the skills context budget. " +
          "Codex can still see every skill, but some descriptions are shorter. " +
          "Disable unused skills or plugins to leave more room for the rest.",
        "",
        "We're currently experiencing high demand, which may cause temporary errors.",
      ].join("\n"),
    )).toBe(true);
  });

  it("detects a lone high-demand notice", () => {
    expect(isNonSubstantiveModelWarningComment(
      "We're currently experiencing high demand, which may cause temporary errors.",
    )).toBe(true);
  });

  it("keeps a substantive progress note that merely mentions a warning", () => {
    expect(isNonSubstantiveModelWarningComment(
      [
        "Warning: Skill descriptions were shortened to fit the skills context budget.",
        "frame 02/08 generated, attaching shortly",
      ].join("\n"),
    )).toBe(false);
  });

  it("keeps ordinary progress comments", () => {
    expect(isNonSubstantiveModelWarningComment("frame 02/08 generated, attaching shortly"))
      .toBe(false);
  });

  it("treats an empty body as non-matching (not a warning)", () => {
    expect(isNonSubstantiveModelWarningComment("   \n\n")).toBe(false);
  });
});

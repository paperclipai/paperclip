import { describe, expect, it } from "vitest";
import { matchSafeQuestionValidationPattern } from "./question-validation-pattern";

describe("matchSafeQuestionValidationPattern", () => {
  it("matches the bounded fixed-width subset without a dynamic RegExp", () => {
    expect(matchSafeQuestionValidationPattern("^#[0-9A-F][0-9A-F]$", "#2F"))
      .toBe("match");
    expect(matchSafeQuestionValidationPattern("^#[0-9A-F][0-9A-F]$", "#GG"))
      .toBe("no_match");
    expect(matchSafeQuestionValidationPattern("^item\\.\\d$", "item.7"))
      .toBe("match");
  });

  it("rejects provider patterns that can trigger backtracking", () => {
    expect(
      matchSafeQuestionValidationPattern("^(a+)+$", `${"a".repeat(50_000)}!`),
    ).toBe("unsupported");
    expect(matchSafeQuestionValidationPattern("^[a-z]*[a-z]*$", "abc"))
      .toBe("unsupported");
    expect(matchSafeQuestionValidationPattern("[a-z]", "a"))
      .toBe("unsupported");
  });
});

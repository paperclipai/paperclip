import { describe, expect, it } from "vitest";
import { resolveSkillSummaryText, sanitizeSkillSummaryText } from "./company-skill-summary";

describe("company skill summary text", () => {
  it("drops stray YAML block scalar markers without rewriting other markdown", () => {
    expect(sanitizeSkillSummaryText(">")).toBeNull();
    expect(sanitizeSkillSummaryText("|")).toBeNull();
    expect(sanitizeSkillSummaryText("- Helpful summary")).toBe("- Helpful summary");
    expect(sanitizeSkillSummaryText("# Helpful summary")).toBe("# Helpful summary");
  });

  it("falls back to the skill key when requested and the summary is empty", () => {
    expect(resolveSkillSummaryText({
      name: "Humanizer",
      key: "content/humanizer",
      description: ">",
    }, { fallbackKey: true })).toBe("content/humanizer");

    expect(resolveSkillSummaryText({
      name: "humanizer",
      key: "humanizer",
      description: "|",
    }, { fallbackKey: true })).toBe("humanizer");
  });

  it("falls back from a stale tagline to a real description", () => {
    expect(resolveSkillSummaryText({
      tagline: ">",
      description: "Cleans up rough AI prose.",
      key: "content/humanizer",
      name: "Humanizer",
    })).toBe("Cleans up rough AI prose.");
  });
});

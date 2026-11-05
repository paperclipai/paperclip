import { describe, expect, it } from "vitest";
import { unescapeIntrawordUnderscores } from "./underscore-markdown";

describe("unescapeIntrawordUnderscores", () => {
  it("restores underscores the person typed inside words and identifiers", () => {
    expect(unescapeIntrawordUnderscores("Reply with E2E\\_ASK\\_12\\_journey\\_1793913565974\\_507b01b8."))
      .toBe("Reply with E2E_ASK_12_journey_1793913565974_507b01b8.");
    expect(unescapeIntrawordUnderscores("Set PAPERCLIP\\_TASK\\_ID and snake\\_case")).toBe("Set PAPERCLIP_TASK_ID and snake_case");
    expect(unescapeIntrawordUnderscores("ünïcode\\_wörd")).toBe("ünïcode_wörd");
  });

  it("keeps escapes that change rendering or belong to code", () => {
    for (const value of [
      "\\_not emphasis\\_",
      "word \\_start",
      "end\\_ word",
      "a\\\\_b",
      "Use `snake\\_case` literally",
      "```\nE2E\\_ASK\n```",
      "~~~ts\nconst a\\_b = 1;\n~~~",
    ]) expect(unescapeIntrawordUnderscores(value)).toBe(value);
  });

  it("resumes after a closed fence or code span", () => {
    expect(unescapeIntrawordUnderscores("```\nkeep\\_this\n```\nfix\\_this"))
      .toBe("```\nkeep\\_this\n```\nfix_this");
    expect(unescapeIntrawordUnderscores("`keep\\_this` and fix\\_this")).toBe("`keep\\_this` and fix_this");
  });
});

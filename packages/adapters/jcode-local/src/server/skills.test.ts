import { describe, expect, it } from "vitest";
import { resolveJcodeSkillsHome } from "./skills.js";

describe("resolveJcodeSkillsHome", () => {
  it("respects config.env.HOME when materializing skills", () => {
    expect(
      resolveJcodeSkillsHome({
        env: {
          HOME: "/custom/jcode-home",
        },
      }),
    ).toBe("/custom/jcode-home/.jcode/skills");
  });
});

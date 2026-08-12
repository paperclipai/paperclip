import { describe, expect, it } from "vitest";
import { toDesiredSkillPayload } from "./AgentSkillsTab";

describe("toDesiredSkillPayload", () => {
  const skillKey = "paperclipai/paperclip/paperclip";
  const versionId = "22222222-2222-4222-8222-222222222222";

  it("includes saved version pins while beta skills are enabled", () => {
    expect(toDesiredSkillPayload([skillKey], { [skillKey]: versionId }, true)).toEqual([
      { key: skillKey, versionId },
    ]);
  });

  it("omits saved version pins while beta skills are disabled", () => {
    expect(toDesiredSkillPayload([skillKey], { [skillKey]: versionId }, false)).toEqual([
      skillKey,
    ]);
  });
});

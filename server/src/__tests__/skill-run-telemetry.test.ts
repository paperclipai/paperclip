import { describe, expect, it } from "vitest";
import { buildRunSkillTelemetry } from "../services/skill-run-telemetry.js";

describe("buildRunSkillTelemetry", () => {
  it("separates requested, desired, available, and prepared skills without claiming invocation", () => {
    const runtimeEntries = [
      { key: "company/acme/qa", runtimeName: "qa", source: "/skills/qa" },
      { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: "/skills/paperclip", required: true },
      { key: "company/acme/research", runtimeName: "research", source: "/skills/research" },
    ];

    expect(buildRunSkillTelemetry({
      runtimeEntries,
      effectiveConfig: {
        paperclipSkillSync: {
          desiredSkills: ["company/acme/qa", "company/acme/research", "missing/skill"],
        },
      },
      mentionedSkillKeys: ["company/acme/research"],
    })).toEqual({
      schemaVersion: 2,
      availableCount: 3,
      availableKeys: [
        "company/acme/qa",
        "company/acme/research",
        "paperclipai/paperclip/paperclip",
      ],
      requestedKeys: ["company/acme/qa", "company/acme/research", "missing/skill"],
      desiredKeys: [
        "company/acme/qa",
        "company/acme/research",
        "missing/skill",
      ],
      requiredKeys: ["paperclipai/paperclip/paperclip"],
      preparedKeys: [
        "company/acme/qa",
        "company/acme/research",
      ],
      unavailableDesiredKeys: ["missing/skill"],
      preparationSignals: [
        { key: "company/acme/qa", sources: ["agent_selection"] },
        { key: "company/acme/research", sources: ["issue_mention"] },
      ],
    });
  });
});

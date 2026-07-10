import { describe, expect, it } from "vitest";
import { buildRunSkillTelemetry } from "../services/skill-run-telemetry.js";

describe("buildRunSkillTelemetry", () => {
  it("records availability and why each run skill was activated", () => {
    const runtimeEntries = [
      { key: "company/acme/qa", runtimeName: "qa", source: "/skills/qa" },
      { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: "/skills/paperclip", required: true },
      { key: "company/acme/research", runtimeName: "research", source: "/skills/research" },
    ];

    expect(buildRunSkillTelemetry({
      runtimeEntries,
      effectiveConfig: {
        paperclipSkillSync: {
          desiredSkills: ["company/acme/qa", "company/acme/research"],
        },
      },
      mentionedSkillKeys: ["company/acme/research"],
    })).toEqual({
      schemaVersion: 1,
      availableCount: 3,
      availableKeys: [
        "company/acme/qa",
        "company/acme/research",
        "paperclipai/paperclip/paperclip",
      ],
      requiredKeys: ["paperclipai/paperclip/paperclip"],
      activatedKeys: [
        "company/acme/qa",
        "company/acme/research",
        "paperclipai/paperclip/paperclip",
      ],
      invocationSignals: [
        { key: "company/acme/qa", sources: ["agent_selection"] },
        { key: "company/acme/research", sources: ["issue_mention"] },
        { key: "paperclipai/paperclip/paperclip", sources: ["runtime_required"] },
      ],
    });
  });
});

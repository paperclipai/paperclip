import { describe, expect, it } from "vitest";
import {
  normalizePaperclipOperationalSkillPreference,
  normalizePaperclipRunnerAdapterConfig,
  PAPERCLIP_OPERATIONAL_SKILL_KEY,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const legacyConfig = {
  paperclipSkillSync: {
    desiredSkills: [PAPERCLIP_OPERATIONAL_SKILL_KEY],
  },
};

describe("paperclip_runner operational skill normalization", () => {
  it("applies full-auto native runner defaults at persistence boundaries", () => {
    expect(normalizePaperclipRunnerAdapterConfig("paperclip_runner", {})).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
      codexPermissionMode: "never",
      lifecycleMode: "per_turn",
    });
  });

  it("repairs an existing blank model without replacing an explicit model", () => {
    expect(normalizePaperclipRunnerAdapterConfig("paperclip_runner", { model: "" }))
      .toMatchObject({ model: "gpt-5.6-sol" });
    expect(normalizePaperclipRunnerAdapterConfig("paperclip_runner", { model: "gpt-5.5" }))
      .toMatchObject({ model: "gpt-5.5" });
  });

  it("does not replace a non-Codex provider model with the Codex default", () => {
    expect(normalizePaperclipRunnerAdapterConfig("paperclip_runner", {
      provider: "claude_managed",
      model: "claude-sonnet-5",
    })).toMatchObject({
      provider: "claude_managed",
      model: "claude-sonnet-5",
    });
  });

  it("removes the legacy operational skill while preserving optional skills", () => {
    const normalized = normalizePaperclipOperationalSkillPreference("paperclip_runner", {
      paperclipSkillSync: {
        desiredSkills: [PAPERCLIP_OPERATIONAL_SKILL_KEY, "company-1/reviewer"],
      },
    });

    expect(normalized).toEqual({
      paperclipSkillSync: { desiredSkills: ["company-1/reviewer"] },
    });
  });

  it("restores the required operational skill through the legacy resolver after switching back", () => {
    const normalized = normalizePaperclipOperationalSkillPreference("paperclip_runner", legacyConfig);
    expect(resolveLegacyPaperclipDesiredSkillNames(normalized, [{
      key: PAPERCLIP_OPERATIONAL_SKILL_KEY,
      runtimeName: "paperclip",
    }])).toEqual([PAPERCLIP_OPERATIONAL_SKILL_KEY]);
  });

  it("does not change direct adapter preferences", () => {
    expect(normalizePaperclipOperationalSkillPreference("codex_local", legacyConfig)).toBe(legacyConfig);
  });
});

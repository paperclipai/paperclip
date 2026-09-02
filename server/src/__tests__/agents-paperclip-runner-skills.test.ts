import { describe, expect, it } from "vitest";
import { PAPERCLIP_OPERATIONAL_SKILL_KEY } from "@paperclipai/adapter-utils/server-utils";
import { assertPaperclipRunnerOperationalSkillInvariant } from "../services/agents.js";

const legacyConfig = {
  paperclipSkillSync: {
    desiredSkills: [PAPERCLIP_OPERATIONAL_SKILL_KEY],
  },
};

describe("paperclip_runner operational skill invariant", () => {
  it("rejects the legacy operational skill on new runners", () => {
    expect(() => assertPaperclipRunnerOperationalSkillInvariant({
      adapterType: "paperclip_runner",
      nextConfig: legacyConfig,
    })).toThrow("does not support the legacy Paperclip operational skill");
  });

  it("rejects adding the legacy skill or carrying it onto a runner adapter", () => {
    expect(() => assertPaperclipRunnerOperationalSkillInvariant({
      adapterType: "paperclip_runner",
      nextConfig: legacyConfig,
      priorAdapterType: "paperclip_runner",
      priorConfig: {},
    })).toThrow("does not support the legacy Paperclip operational skill");
    expect(() => assertPaperclipRunnerOperationalSkillInvariant({
      adapterType: "paperclip_runner",
      nextConfig: legacyConfig,
      priorAdapterType: "codex_local",
      priorConfig: legacyConfig,
    })).toThrow("does not support the legacy Paperclip operational skill");
  });

  it("allows stale runner assignments to remain inert while they are edited or removed", () => {
    expect(() => assertPaperclipRunnerOperationalSkillInvariant({
      adapterType: "paperclip_runner",
      nextConfig: legacyConfig,
      priorAdapterType: "paperclip_runner",
      priorConfig: legacyConfig,
    })).not.toThrow();
    expect(() => assertPaperclipRunnerOperationalSkillInvariant({
      adapterType: "paperclip_runner",
      nextConfig: {},
      priorAdapterType: "paperclip_runner",
      priorConfig: legacyConfig,
    })).not.toThrow();
  });

  it("does not apply the native-runner invariant to direct adapters", () => {
    expect(() => assertPaperclipRunnerOperationalSkillInvariant({
      adapterType: "codex_local",
      nextConfig: legacyConfig,
    })).not.toThrow();
  });
});

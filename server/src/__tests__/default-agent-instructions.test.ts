import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  loadDefaultAgentInstructionsBundleLocalizationCandidates,
  normalizeDefaultAgentInstructionsLocale,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("default agent instructions", () => {
  it("loads the Chinese CEO instruction bundle", async () => {
    const files = await loadDefaultAgentInstructionsBundle("ceo", "zh-CN");

    expect(Object.keys(files).sort()).toEqual(["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"]);
    expect(files["AGENTS.md"]).toContain("你是 CEO");
    expect(files["HEARTBEAT.md"]).toContain("CEO 心跳检查清单");
    expect(files["SOUL.md"]).toContain("CEO 人格设定");
    expect(files["TOOLS.md"]).toContain("你的工具会记录在这里");
  });

  it("loads the Chinese default non-CEO instruction bundle", async () => {
    const files = await loadDefaultAgentInstructionsBundle("default", "zh-CN");

    expect(Object.keys(files)).toEqual(["AGENTS.md"]);
    expect(files["AGENTS.md"]).toContain("你是 Paperclip 公司中的一名智能体");
  });

  it("loads Chinese role-specific non-CEO instruction bundles", async () => {
    const roleExpectations = [
      ["cto", "你是 CTO"],
      ["cmo", "你是 CMO"],
      ["engineer", "软件工程师"],
      ["qa", "QA 工程师"],
      ["designer", "产品设计师"],
    ] as const;

    for (const [role, expected] of roleExpectations) {
      const files = await loadDefaultAgentInstructionsBundle(role, "zh-CN");
      expect(Object.keys(files)).toEqual(["AGENTS.md"]);
      expect(files["AGENTS.md"]).toContain(expected);
    }
  });

  it("maps known role aliases to role-specific bundles", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("cto")).toBe("cto");
    expect(resolveDefaultAgentInstructionsBundleRole("cmo")).toBe("cmo");
    expect(resolveDefaultAgentInstructionsBundleRole("coder")).toBe("engineer");
    expect(resolveDefaultAgentInstructionsBundleRole("uxdesigner")).toBe("designer");
    expect(resolveDefaultAgentInstructionsBundleRole("unknown")).toBe("default");
  });

  it("includes legacy CMO and CTO defaults as safe localization candidates", async () => {
    const ctoCandidates = await loadDefaultAgentInstructionsBundleLocalizationCandidates("cto");
    const cmoCandidates = await loadDefaultAgentInstructionsBundleLocalizationCandidates("cmo");

    expect(ctoCandidates.map((candidate) => candidate.id)).toContain("legacy-en:cto-v1");
    expect(cmoCandidates.map((candidate) => candidate.id)).toContain("legacy-en:cmo-v1");
    expect(ctoCandidates.find((candidate) => candidate.id === "legacy-en:cto-v1")?.files["AGENTS.md"]).toContain(
      "You are the CTO. You own technical strategy",
    );
    expect(cmoCandidates.find((candidate) => candidate.id === "legacy-en:cmo-v1")?.files["AGENTS.md"]).toContain(
      "You are the CMO. You own marketing",
    );
  });

  it("defaults unknown locales to English", () => {
    expect(normalizeDefaultAgentInstructionsLocale(undefined)).toBe("en");
    expect(normalizeDefaultAgentInstructionsLocale("fr")).toBe("en");
    expect(normalizeDefaultAgentInstructionsLocale("zh-CN")).toBe("zh-CN");
  });
});

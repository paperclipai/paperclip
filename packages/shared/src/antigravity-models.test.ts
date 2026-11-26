import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_GENERATED_MODEL_CATALOG as CATALOG } from "./antigravity-models.generated.js";
import {
  ANTIGRAVITY_API_KEY_DEFAULT_MODEL,
  ANTIGRAVITY_THINKING_LEVELS,
  antigravityApiKeyModels,
  antigravityFamilyModelIds,
  antigravityModelChoice,
  antigravityModelNeedsPaidGeminiApiPlan,
  antigravityModelRefusalMessage,
  antigravityServerThinkingLevel,
  formatAntigravityModelId,
  parseAntigravityModelId,
} from "./antigravity-models.js";

const serverIds = CATALOG.families.flatMap(family => antigravityFamilyModelIds(family.id));

describe("Antigravity model ids", () => {
  it("round-trips every server catalog id exactly, including all Gemini 4 levels", () => {
    expect(serverIds).toHaveLength(28);
    for (const id of serverIds) {
      const variant = parseAntigravityModelId(id, { catalog: "server" });
      expect(variant, id).not.toBeNull();
      expect(formatAntigravityModelId(variant!)).toBe(id);
    }
  });

  it("parses and formats all five server thinking levels", () => {
    for (const level of ANTIGRAVITY_THINKING_LEVELS) {
      const id = `gemini-4-neon-${level}`;
      expect(parseAntigravityModelId(id)).toEqual({ familyId: "gemini-4-neon", level, spelling: "server" });
      expect(formatAntigravityModelId({ familyId: "gemini-4-neon", level, spelling: "server" })).toBe(id);
    }
  });

  it("keeps the account catalog's xhigh spelling distinct from the server's extra_high", () => {
    expect(parseAntigravityModelId("gemini-4-neon-xhigh", { catalog: "account" })).toEqual({ familyId: "gemini-4-neon", level: "extra_high", spelling: "account" });
    expect(parseAntigravityModelId("gemini-4-neon-extra_high", { catalog: "account" })).toEqual({ familyId: "gemini-4-neon", level: "extra_high", spelling: "server" });
    for (const id of ["gemini-4-neon-xhigh", "gemini-4-neon-extra_high", "gemini-4-neon-high", "gemini-4-neon-max", "gemini-4-neon-high-effort", "gemini-4-neon-xhigh-effort"]) {
      expect(formatAntigravityModelId(parseAntigravityModelId(id, { catalog: "account" })!), id).toBe(id);
    }
    expect(antigravityServerThinkingLevel("xhigh")).toBe("extra_high");
    expect(antigravityServerThinkingLevel("extra_high")).toBe("extra_high");
    expect(antigravityServerThinkingLevel("max")).toBeNull();
    expect(() => formatAntigravityModelId({ familyId: "gemini-4-neon", level: "max", spelling: "server" })).toThrow();
  });

  it("reads legacy account ids the way the server does, and round-trips them", () => {
    expect(parseAntigravityModelId("gemini-3.5-flash-low", { catalog: "account" })).toMatchObject({ familyId: "gemini-3.5-flash", level: "medium" });
    expect(parseAntigravityModelId("gemini-3.5-flash-low", { catalog: "server" })).toMatchObject({ familyId: "gemini-3.5-flash", level: "low" });
    for (const id of ["gemini-3.5-flash-extra-low", "gemini-3.5-flash-low", "gemini-3-flash-agent", "gemini-3.1-pro-low", "gemini-pro-agent"]) {
      expect(formatAntigravityModelId(parseAntigravityModelId(id, { catalog: "account" })!)).toBe(id);
    }
  });

  it("does not invent a level for ids that carry none", () => {
    for (const id of ["gemini-4-neon", "auto", "", "-high", "claude-sonnet-4"]) expect(parseAntigravityModelId(id)).toBeNull();
  });
});

describe("Antigravity API-key suggestions", () => {
  it("lists the live API-key catalog first, then every Gemini 4 level marked as needing a paid plan", () => {
    const models = antigravityApiKeyModels();
    expect(models.slice(0, 14).map(model => model.id)).toEqual([
      "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
      "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
      "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low",
      "gemini-3.5-flash-high", "gemini-3.5-flash-medium", "gemini-3.5-flash-low",
      "gemini-3.1-pro-high", "gemini-3.1-pro-low",
    ]);
    expect(ANTIGRAVITY_API_KEY_DEFAULT_MODEL).toBe("gemini-3.8-flash-high");
    const gemini4 = models.slice(14);
    expect(gemini4.map(model => model.id)).toEqual([
      "gemini-4-carbon-medium", "gemini-4-carbon-high", "gemini-4-carbon-low",
      "gemini-4-neon-high", "gemini-4-neon-extra_high", "gemini-4-neon-medium", "gemini-4-neon-low",
      "gemini-4-hydrogen-high", "gemini-4-hydrogen-extra_high", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-low",
      "gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low",
    ]);
    expect(gemini4.every(model => model.label.endsWith("needs a paid Gemini API plan"))).toBe(true);
    expect(gemini4.every(model => antigravityModelNeedsPaidGeminiApiPlan(model.id))).toBe(true);
    expect(models.slice(0, 14).some(model => antigravityModelNeedsPaidGeminiApiPlan(model.id))).toBe(false);
  });

  it("names family and level for the picker", () => {
    expect(antigravityModelChoice({ id: "gemini-4-neon-extra_high" })).toEqual({ familyId: "gemini-4-neon", familyLabel: "Gemini 4 Neon", level: "extra_high", levelLabel: "Extra high" });
    expect(antigravityModelChoice({ id: "gemini-9-nova-xhigh", label: "Gemini 9 Nova (Extra)" }, { catalog: "account" }))
      .toEqual({ familyId: "gemini-9-nova", familyLabel: "Gemini 9 Nova", level: "extra_high", levelLabel: "Extra high" });
  });

  it("explains a refused model in plain language, naming only the model", () => {
    const neon = antigravityModelRefusalMessage("gemini-4-neon-high", "api_key");
    expect(neon).toBe("Gemini 4 Neon (High) is not available with this Gemini API key. Use a key on a paid Gemini API plan that includes Gemini 4, or choose a Gemini 3 model.");
    expect(antigravityModelRefusalMessage("gemini-4-neon-xhigh", "subscription")).toContain("Gemini 4 Neon (Extra high) is not available to this Google account.");
    for (const message of [neon, antigravityModelRefusalMessage("gemini-3.8-flash-high", "api_key")]) {
      expect(message).not.toMatch(/-32602|429|RESOURCE_EXHAUSTED|agent_platform|gemini-/);
    }
  });
});

// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  agentUsesDifficultyRouting,
  formatIssueDifficultyRouting,
  readDifficultyRoutingDraft,
  runtimeConfigWithDifficultyRouting,
  setDifficultyTierSetting,
} from "./difficulty-routing";

describe("difficulty routing helpers", () => {
  it("reads a missing or invalid config as disabled", () => {
    expect(readDifficultyRoutingDraft(undefined)).toEqual({ enabled: false, tiers: {} });
    expect(readDifficultyRoutingDraft({ enabled: "yes" })).toEqual({ enabled: false, tiers: {} });
    expect(agentUsesDifficultyRouting({ difficultyRouting: { enabled: true, tiers: {} } })).toBe(true);
    expect(agentUsesDifficultyRouting(null)).toBe(false);
  });

  it("sets and clears tier fields, dropping empty tiers", () => {
    const withModel = setDifficultyTierSetting({ enabled: true, tiers: {} }, "L3", { model: "opus", effort: "high" });
    expect(withModel.tiers).toEqual({ L3: { model: "opus", effort: "high" } });
    const noEffort = setDifficultyTierSetting(withModel, "L3", { effort: "" });
    expect(noEffort.tiers).toEqual({ L3: { model: "opus" } });
    expect(setDifficultyTierSetting(noEffort, "L3", { model: "" }).tiers).toEqual({});
  });

  it("restores the saved runtime config when the draft matches it again", () => {
    const saved = { heartbeat: { enabled: true } };
    const enabled = runtimeConfigWithDifficultyRouting(saved, undefined, { enabled: true, tiers: {} });
    expect(enabled.difficultyRouting).toEqual({ enabled: true, tiers: {} });
    expect(runtimeConfigWithDifficultyRouting(saved, enabled, { enabled: false, tiers: {} }))
      .toEqual({ heartbeat: { enabled: true }, aiConnection: undefined });
  });

  it("formats the decision summary", () => {
    expect(formatIssueDifficultyRouting(null)).toBe("Auto (decided at first run)");
    expect(formatIssueDifficultyRouting({
      tier: "L3", source: "manual", agentId: null, model: null, effort: null,
      confidence: null, decidedAt: "2026-11-16T00:00:00.000Z", decisionInvocationId: null,
    })).toBe("Manual: L3 · agent default model");
  });
});

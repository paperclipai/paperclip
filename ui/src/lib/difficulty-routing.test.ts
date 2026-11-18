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

describe("difficulty escalation helpers", () => {
  const base = { enabled: true, tiers: { L3: { model: "claude-opus-5-5", effort: "high" } } };

  it("sets and clears the escalation setting", () => {
    const withEscalation = setDifficultyTierSetting(base, "escalation", { model: "claude-fable-5-2", effort: "high" });
    expect(withEscalation).toEqual({ ...base, escalation: { model: "claude-fable-5-2", effort: "high" } });
    expect(setDifficultyTierSetting(withEscalation, "escalation", { model: "", effort: "" })).toEqual(base);
  });

  it("saves a change that only touches the escalation setting", () => {
    const saved = { difficultyRouting: base };
    const next = setDifficultyTierSetting(base, "escalation", { model: "claude-fable-5-2" });
    expect(runtimeConfigWithDifficultyRouting(saved, undefined, next).difficultyRouting).toEqual(next);
  });

  it("shows why a task escalated", () => {
    expect(formatIssueDifficultyRouting({
      tier: "L3", source: "auto", agentId: null, model: "claude-fable-5-2", effort: "high", confidence: null,
      decidedAt: "2026-11-17T00:00:00.000Z", decisionInvocationId: null,
      escalation: { reason: "run_failed", step: "escalation", fromTier: "L3", triggerDecisionId: null,
        fromModel: "claude-opus-5-5", fromEffort: "high", triggerRunId: null, escalatedAt: "2026-11-17T01:00:00.000Z" },
    })).toBe("Auto: L3 · claude-fable-5-2 · high · escalated: previous run failed");
    expect(formatIssueDifficultyRouting({
      tier: "L3", source: "auto", agentId: null, model: "claude-opus-5-5", effort: "high", confidence: null,
      decidedAt: "2026-11-17T00:00:00.000Z", decisionInvocationId: null,
      escalation: { reason: "changes_requested", step: "tier", fromTier: "L2", triggerDecisionId: "changes_requested:1",
        fromModel: "claude-opus-5-5", fromEffort: "medium", triggerRunId: null, escalatedAt: "2026-11-17T01:00:00.000Z" },
    })).toBe("Auto: L3 · claude-opus-5-5 · high · escalated from L2: changes requested");
  });
});

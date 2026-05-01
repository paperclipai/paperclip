// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildAssigneeAdapterOverrides } from "./issue-assignee-overrides";

describe("buildAssigneeAdapterOverrides", () => {
  it("returns null for adapters that do not accept issue overrides", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "process",
        lane: "custom",
        modelOverride: "anything",
        thinkingEffortOverride: "high",
        chrome: true,
      }),
    ).toBeNull();
  });

  it("primary lane sends nothing", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "claude_local",
        lane: "primary",
        modelOverride: "",
        thinkingEffortOverride: "",
        chrome: false,
      }),
    ).toBeNull();
  });

  it("cheap lane sends modelProfile=cheap and no adapterConfig", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "codex_local",
        lane: "cheap",
        modelOverride: "ignored",
        thinkingEffortOverride: "high",
        chrome: false,
      }),
    ).toEqual({ modelProfile: "cheap" });
  });

  it("custom lane preserves explicit model + thinking effort + chrome overrides", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "claude_local",
        lane: "custom",
        modelOverride: "claude-haiku-4-5",
        thinkingEffortOverride: "high",
        chrome: true,
      }),
    ).toEqual({
      adapterConfig: {
        model: "claude-haiku-4-5",
        effort: "high",
        chrome: true,
      },
    });
  });

  it("custom lane returns null when no fields are set", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "codex_local",
        lane: "custom",
        modelOverride: "",
        thinkingEffortOverride: "",
        chrome: false,
      }),
    ).toBeNull();
  });

  it("custom lane uses adapter-specific keys for thinking effort", () => {
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "codex_local",
        lane: "custom",
        modelOverride: "",
        thinkingEffortOverride: "minimal",
        chrome: false,
      }),
    ).toEqual({
      adapterConfig: { modelReasoningEffort: "minimal" },
    });
    expect(
      buildAssigneeAdapterOverrides({
        adapterType: "opencode_local",
        lane: "custom",
        modelOverride: "",
        thinkingEffortOverride: "max",
        chrome: false,
      }),
    ).toEqual({
      adapterConfig: { variant: "max" },
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  PAPERCLIP_ADAPTIVE_VARIANT,
  adaptiveThinkingVariantDefinitions,
  buildOpenCodeRunArgs,
  isAdaptiveThinkingModel,
} from "./run-args.js";

describe("buildOpenCodeRunArgs", () => {
  it("passes the adaptive fallback variant when none is configured", () => {
    expect(buildOpenCodeRunArgs({})).toEqual([
      "run",
      "--format",
      "json",
      "--variant",
      PAPERCLIP_ADAPTIVE_VARIANT,
    ]);
  });

  it("respects an explicitly configured variant and model", () => {
    expect(
      buildOpenCodeRunArgs({ model: "opencode/glm-5.2", variant: "low", extraArgs: ["--foo"] }),
    ).toEqual(["run", "--format", "json", "--model", "opencode/glm-5.2", "--variant", "low", "--foo"]);
  });

  it("passes --session before --model/--variant on resume", () => {
    expect(
      buildOpenCodeRunArgs({ model: "opencode/claude-opus-5", resumeSessionId: "ses_123" }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--session",
      "ses_123",
      "--model",
      "opencode/claude-opus-5",
      "--variant",
      PAPERCLIP_ADAPTIVE_VARIANT,
    ]);
  });
});

describe("adaptive thinking capability gate", () => {
  it("matches verified adaptive-only models with and without provider prefix", () => {
    expect(isAdaptiveThinkingModel("opencode/claude-opus-5")).toBe(true);
    expect(isAdaptiveThinkingModel("claude-opus-5")).toBe(true);
    expect(isAdaptiveThinkingModel("opencode/muse-spark-1.3-contributor-free")).toBe(true);
  });

  it("does not match models that accept the legacy thinking shape", () => {
    expect(isAdaptiveThinkingModel("opencode/glm-5.2")).toBe(false);
    expect(isAdaptiveThinkingModel("openai/gpt-5.2-codex")).toBe(false);
    expect(isAdaptiveThinkingModel("")).toBe(false);
    expect(isAdaptiveThinkingModel(null)).toBe(false);
  });

  it("defines a thinking.type.adaptive variant per gated model", () => {
    const definitions = adaptiveThinkingVariantDefinitions();
    expect(Object.keys(definitions).sort()).toEqual([
      "claude-opus-5",
      "muse-spark-1.3-contributor-free",
    ]);
    for (const variants of Object.values(definitions)) {
      expect(variants).toEqual({
        [PAPERCLIP_ADAPTIVE_VARIANT]: { thinking: { type: "adaptive" } },
      });
    }
  });
});

import { describe, expect, it } from "vitest";
import { analyzePromptCacheability } from "./prompt-cache.js";

describe("analyzePromptCacheability", () => {
  it("returns no warnings for stable prompt variables", () => {
    expect(
      analyzePromptCacheability("You are {{ agent.name }} working on issue {{ context.issueId }}."),
    ).toEqual([]);
  });

  it("returns no warnings for null, undefined, or empty templates", () => {
    expect(analyzePromptCacheability(null)).toEqual([]);
    expect(analyzePromptCacheability(undefined)).toEqual([]);
    expect(analyzePromptCacheability("")).toEqual([]);
    expect(analyzePromptCacheability("   ")).toEqual([]);
  });

  it("warns when the whole context object is interpolated", () => {
    expect(analyzePromptCacheability("Wake context: {{ context }}")).toEqual([
      {
        variable: "context",
        message: "Serializes the entire wake context, which is bulky and often includes volatile fields.",
      },
    ]);
  });

  it("warns for volatile run identifiers and timestamps", () => {
    expect(
      analyzePromptCacheability("Run {{ run.id }} at {{ context.now }} with fallback {{ runId }}."),
    ).toEqual([
      {
        variable: "runId",
        message: "Includes a unique run ID on every heartbeat, which defeats prompt-prefix stability.",
      },
      {
        variable: "run.id",
        message: "Includes a unique run ID on every heartbeat, which defeats prompt-prefix stability.",
      },
      {
        variable: "context.now",
        message: "Includes a fresh timestamp on each wake, which defeats prompt-prefix stability.",
      },
    ]);
  });

  it("emits both context and context.now warnings when both are present", () => {
    expect(
      analyzePromptCacheability("Context: {{ context }} timestamp: {{ context.now }}"),
    ).toEqual([
      {
        variable: "context",
        message: "Serializes the entire wake context, which is bulky and often includes volatile fields.",
      },
      {
        variable: "context.now",
        message: "Includes a fresh timestamp on each wake, which defeats prompt-prefix stability.",
      },
    ]);
  });
});

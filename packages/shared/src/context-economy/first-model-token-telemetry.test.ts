import { describe, expect, it } from "vitest";
import {
  captureFirstModelTokenTelemetry,
  decomposePromptChars,
} from "./first-model-token-telemetry.js";

describe("first-model-token-telemetry", () => {
  it("records measured tokens with source", () => {
    const t = captureFirstModelTokenTelemetry({
      firstModelInputTokens: 14823,
      firstModelCachedInputTokens: 17580,
      measurementSource: "provider",
      promptChars: decomposePromptChars({
        baselineInstructions: 8795,
        taskContext: 1805,
        toolSchema: 0,
        sessionHistory: 0,
      }),
    });
    expect(t.measured).toBe(true);
    expect(t.firstModelInputTokens).toBe(14823);
    expect(t.firstModelCachedInputTokens).toBe(17580);
    expect(t.reason).toBeNull();
    expect(t.promptChars.total).toBe(10600);
  });

  it("keeps null + reason when provider does not report", () => {
    const t = captureFirstModelTokenTelemetry({
      promptChars: decomposePromptChars({ baselineInstructions: 6000 }),
      reason: "opencode runtime omitted usage in first response",
    });
    expect(t.measured).toBe(false);
    expect(t.firstModelInputTokens).toBeNull();
    expect(t.firstModelCachedInputTokens).toBeNull();
    expect(t.measurementSource).toBe("unsupported");
    expect(t.reason).toBe("opencode runtime omitted usage in first response");
  });

  it("never invents tokens from chars", () => {
    const t = captureFirstModelTokenTelemetry({
      // only chars supplied, no token numbers
      promptChars: decomposePromptChars({
        baselineInstructions: 12000,
        taskContext: 2000,
        toolSchema: 3000,
        sessionHistory: 1000,
      }),
    });
    expect(t.measured).toBe(false);
    expect(t.firstModelInputTokens).toBeNull();
    expect(t.promptChars.total).toBe(18000);
  });

  it("decomposes prompt chars additively", () => {
    const d = decomposePromptChars({
      baselineInstructions: 6000,
      taskContext: 1800,
      toolSchema: 500,
      sessionHistory: 200,
    });
    expect(d.total).toBe(8500);
  });
});

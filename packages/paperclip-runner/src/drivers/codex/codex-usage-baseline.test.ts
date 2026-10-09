import { describe, it, expect } from "vitest";
import { observeCodexUsage, codexRunUsage } from "./codex-usage-baseline.js";
describe("Codex resume usage accounting", () => {
  it("never charges historical snapshots, including repetitions after restart", () => {
    let state = observeCodexUsage(
      null,
      { inputTokens: 100, outputTokens: 20 },
      true,
    );
    state = observeCodexUsage(
      JSON.parse(JSON.stringify(state)),
      { inputTokens: 100, outputTokens: 20 },
      true,
    );
    expect(codexRunUsage(state).runDelta).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    state = observeCodexUsage(
      state,
      { inputTokens: 140, outputTokens: 26 },
      false,
    );
    state = observeCodexUsage(
      state,
      { inputTokens: 140, outputTokens: 26 },
      false,
    );
    state = observeCodexUsage(
      state,
      { inputTokens: 100, outputTokens: 20 },
      true,
    );
    expect(codexRunUsage(state).runDelta).toEqual({
      inputTokens: 40,
      outputTokens: 6,
    });
  });
  it("retains all current usage for a fresh session", () => {
    expect(
      codexRunUsage(
        observeCodexUsage(null, { inputTokens: 40, outputTokens: 6 }, false),
      ).runDelta,
    ).toEqual({ inputTokens: 40, outputTokens: 6 });
  });
});

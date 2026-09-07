import { describe, expect, it } from "vitest";
import {
  assertAdapterModelCompatibility,
  classifyDeterministicTerminalErrorCode,
  isDeterministicTerminalFailedRun,
} from "./heartbeat.js";

describe("terminal run circuit breaker", () => {
  it("rejects a Claude model on codex_local before dispatch", () => {
    expect(() =>
      assertAdapterModelCompatibility({
        adapterType: "codex_local",
        adapterConfig: { model: "claude-sonnet-4-6" },
      }),
    ).toThrow(/unsupported model\/backend combination/i);
  });

  it("preserves custom Codex gateway model IDs", () => {
    expect(() =>
      assertAdapterModelCompatibility({
        adapterType: "codex_local",
        adapterConfig: { model: "company-codex-finetune" },
      }),
    ).not.toThrow();
  });

  it.each([
    ["The model claude-sonnet-4-6 is unsupported for this account", "model_not_found"],
    ["maximum context window exceeded: too many tokens", "context_window_exhausted"],
  ])("classifies repeated terminal failure %s", (errorMessage, expectedCode) => {
    const errorCode = classifyDeterministicTerminalErrorCode({ errorMessage });
    expect(errorCode).toBe(expectedCode);
    expect(isDeterministicTerminalFailedRun({ errorCode })).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { PrpTerminalState } from "../../vendor/paperclip-runner/index.js";
import { deriveNativeAcceptedOutcome, nativeEffectiveRunTerminalStateSqlText, nativeEffectiveTerminal, nativeRetainsWarmSession } from "./native-accepted-outcome.js";

const failedDone: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "done" };
const outcome = deriveNativeAcceptedOutcome({ terminal: failedDone, providerFailure: null, providerExplanation: {
  schema: "paperclip.provider-failure.v1", provider: "codex", phase: "turn", category: "overloaded", message: "busy", retryability: "transient" } });

describe("native accepted outcome", () => {
  it("keeps the warm session open so the next message does not cold-start", () => {
    expect(outcome).not.toBeNull();
    expect(nativeRetainsWarmSession({ terminal: failedDone, acceptedOutcome: outcome })).toBe(true);
    expect(nativeRetainsWarmSession({ terminal: failedDone, acceptedOutcome: null })).toBe(false);
    expect(nativeRetainsWarmSession({ terminal: failedDone, acceptedOutcome: outcome, continuationKind: "case_handoff" })).toBe(false);
  });

  it("settles a saved row from its outcome and leaves older rows on their raw terminal", () => {
    expect(nativeEffectiveTerminal({ terminal: failedDone, acceptedOutcome: outcome }, failedDone)).toMatchObject({ runTerminalState: "succeeded", turnTerminalState: "completed" });
    expect(nativeEffectiveTerminal({ terminal: failedDone }, failedDone)).toBe(failedDone);
    expect(nativeEffectiveTerminal({ terminal: failedDone, acceptedOutcome: { ...outcome, schema: "other" } }, failedDone)).toBe(failedDone);
  });

  it("refuses a column reference that is not a plain alias", () => {
    expect(nativeEffectiveRunTerminalStateSqlText("result_row.result_json")).toContain("result_row.result_json->'terminal'");
    expect(() => nativeEffectiveRunTerminalStateSqlText("x; drop table y")).toThrow();
  });
});

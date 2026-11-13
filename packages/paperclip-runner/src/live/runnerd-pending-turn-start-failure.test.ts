import { describe, expect, it } from "vitest";
import { runnerdPendingTurnStartFailure } from "./runnerd-codex-transport.js";

// Section G: a held turn failure that names another provider turn (for
// example, the turn an earlier generation lost on restore) is history. It must
// never fail the turn.start that is pending now (#19722 reported any held
// failure).
const failed = (providerTurnId: string | undefined, code = "provider_failed") => ({
  eventType: "turn.failed",
  envelope: { payload: { payload: { ...(providerTurnId ? { providerTurnId } : {}),
    recoverable: false, error: { code, message: "failed", recoverable: false } } } },
});

describe("runnerdPendingTurnStartFailure", () => {
  it("ignores a held failure of an earlier turn", () => {
    expect(runnerdPendingTurnStartFailure([failed("turn-lost", "provider_turn_lost_on_restore")], "turn-new")).toBeNull();
  });
  it("reports the pending turn's own failure", () => {
    expect(runnerdPendingTurnStartFailure([failed("turn-lost"), failed("turn-new")], "turn-new"))
      .toBe("provider_failed: failed");
  });
  it("reports a failure that names no turn, and a failed run terminal", () => {
    expect(runnerdPendingTurnStartFailure([failed(undefined)], "turn-new")).toBe("provider_failed: failed");
    expect(runnerdPendingTurnStartFailure([{ eventType: "run.terminal",
      envelope: { payload: { payload: { runTerminalState: "failed" } } } }], "turn-new")).toBe("run_terminal_failed");
  });
});

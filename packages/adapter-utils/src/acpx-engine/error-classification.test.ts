import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyAcpxError } from "./execute.js";

describe("classifyAcpxError", () => {
  // The provider states the reset without a year, so it is resolved against the
  // clock. Pin the clock, otherwise the expected instant below drifts with the
  // calendar rather than with the behaviour under test.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T05:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The engine names failures after the protocol phase that noticed them. Quota
  // exhaustion is about why the provider refused, so it has to be recognised
  // before the phase dispatch — otherwise every exhausted plan is filed as a
  // generic `acpx_turn_failed` and retried immediately instead of at the reset.
  it("classifies an exhausted subscription reported during a turn", () => {
    const classified = classifyAcpxError(
      new Error("You've hit your weekly limit · resets Aug 1 at 10am (Europe/Moscow)"),
      "turn",
    );

    expect(classified.errorCode).toBe("provider_quota");
    expect(classified.errorFamily).toBe("provider_quota");
    expect(classified.retryNotBefore).toBe("2026-08-01T07:00:00.000Z");
  });

  it("classifies quota text carried on the error cause", () => {
    const err = new Error("ACP turn failed", {
      cause: new Error("Claude usage limit reached"),
    });
    expect(classifyAcpxError(err, "turn").errorFamily).toBe("provider_quota");
  });

  // Reverse control: everything that is not a quota message keeps the phase
  // classification it had before.
  it("leaves an ordinary turn failure as a turn failure", () => {
    const classified = classifyAcpxError(new Error("Tool 'Bash' failed: exit code 1"), "turn");

    expect(classified.errorCode).toBe("acpx_turn_failed");
    expect(classified.errorFamily).toBeUndefined();
    expect(classified.retryNotBefore).toBeUndefined();
  });

  it("keeps session bring-up failures on their own code", () => {
    expect(classifyAcpxError(new Error("handshake refused"), "ensure_session").errorCode)
      .toBe("acpx_session_init_failed");
  });

  it("keeps auth failures ahead of the quota branch", () => {
    expect(classifyAcpxError(new Error("Not logged in: please run claude login"), "turn").errorCode)
      .toBe("acpx_auth_required");
  });
});

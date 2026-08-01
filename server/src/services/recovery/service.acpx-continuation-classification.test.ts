import { describe, expect, it } from "vitest";
import {
  classifyContinuationFailure,
  CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS,
  CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS,
} from "./service.js";

const run = (errorCode: string | null) =>
  ({ errorCode } as unknown as Parameters<typeof classifyContinuationFailure>[0]);

describe("ACPX continuation retry classification", () => {
  it.each([
    "acpx_session_init_failed",
    "acpx_session_config_failed",
    "acpx_turn_failed",
    "acpx_backend_unavailable",
    "acpx_timeout",
  ])("retries %s as transient infrastructure", (errorCode) => {
    // These are the codes the ACPX engine emits when the ACP session or turn dies on
    // the transport. Before this classification they fell into the `default` bucket
    // (one attempt, no backoff) and a single dropped socket escalated the issue to
    // `blocked` with no blocker anyone could clear.
    const classification = classifyContinuationFailure(run(errorCode));
    expect(classification.kind).toBe("transient_infra");
    expect(classification.maxAttempts).toBeGreaterThan(1);
    expect(classification.baseBackoffMs).toBeGreaterThan(0);
  });

  it("leaves ACPX configuration failures on the single-attempt default path", () => {
    // Auth and missing-backend failures repeat deterministically until a human fixes
    // the configuration, so burning the transient retry budget on them is pure noise.
    expect(classifyContinuationFailure(run("acpx_auth_required")).kind).toBe("default");
    expect(classifyContinuationFailure(run("acpx_backend_missing")).kind).toBe("default");
  });

  it("keeps non-retryable codes non-retryable", () => {
    expect(classifyContinuationFailure(run("budget_exhausted")).kind).toBe("non_retryable");
  });
});

describe("Transient retry configuration parsing", () => {
  it("exports finite integer max-attempts (default 3)", () => {
    expect(Number.isFinite(CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS)).toBe(true);
    expect(Number.isInteger(CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS)).toBe(true);
    expect(CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
  });

  it("exports finite backoff >= 1000 ms (default 60 000)", () => {
    expect(Number.isFinite(CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS)).toBe(true);
    expect(CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS).toBeGreaterThanOrEqual(1_000);
  });
});

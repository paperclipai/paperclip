import { describe, expect, it } from "vitest";
import { classifyContinuationFailure, isMissingExecutableFailure } from "./service.js";

const run = (input: { errorCode?: string | null; error?: string | null; resultJson?: unknown }) =>
  ({
    errorCode: input.errorCode ?? null,
    error: input.error ?? null,
    resultJson: input.resultJson ?? null,
  }) as unknown as Parameters<typeof classifyContinuationFailure>[0];

describe("missing-executable continuation classification", () => {
  it("classifies a PATH-resolution failure out of the generic transient bucket", () => {
    // The adapter records this as the catch-all `adapter_failed`, which sits in
    // TRANSIENT_INFRA_CONTINUATION_ERROR_CODES. Without the dedicated branch it
    // would inherit the most retry-friendly policy we have.
    const c = classifyContinuationFailure(
      run({ errorCode: "adapter_failed", error: 'Command not found in PATH: "claude"' }),
    );
    expect(c.kind).toBe("missing_executable");
    expect(c.maxAttempts).toBe(3);
    expect(c.baseBackoffMs).toBeGreaterThan(0);
  });

  it("classifies a raw spawn ENOENT the same way", () => {
    expect(
      classifyContinuationFailure(run({ errorCode: "adapter_failed", error: "spawn claude ENOENT" }))
        .kind,
    ).toBe("missing_executable");
  });

  it("matches on resultJson.errorMessage when run.error is empty", () => {
    expect(
      classifyContinuationFailure(
        run({
          errorCode: "adapter_failed",
          resultJson: { errorMessage: 'Command not found in PATH: "claude"' },
        }),
      ).kind,
    ).toBe("missing_executable");
  });

  it("caps attempts below the 12 the 2026-05-20 cluster burned", () => {
    const c = classifyContinuationFailure(
      run({ errorCode: "adapter_failed", error: 'Command not found in PATH: "claude"' }),
    );
    expect(c.maxAttempts).toBeLessThan(12);
  });

  it("leaves unrelated adapter failures in the transient bucket", () => {
    const c = classifyContinuationFailure(
      run({ errorCode: "adapter_failed", error: "upstream returned 503" }),
    );
    expect(c.kind).toBe("transient_infra");
  });

  it("does not reclassify codes that are already non-retryable", () => {
    // A paused agent whose prior error text happens to mention ENOENT must still
    // short-circuit as non_retryable rather than earning three fresh attempts.
    expect(
      classifyContinuationFailure(
        run({ errorCode: "agent_not_invokable", error: "spawn claude ENOENT" }),
      ).kind,
    ).toBe("non_retryable");
  });

  it("ignores prose that merely mentions a path", () => {
    expect(isMissingExecutableFailure(run({ error: "could not find the config path" }))).toBe(false);
    expect(isMissingExecutableFailure(run({ error: null }))).toBe(false);
    expect(isMissingExecutableFailure(null)).toBe(false);
  });
});

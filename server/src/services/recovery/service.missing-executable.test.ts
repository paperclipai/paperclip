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

  it("does not match captured agent output in resultJson.stdout/stderr", () => {
    // `resultJson` is not small metadata: the claude_local failure path stores
    // the raw `{ stdout, stderr }` capture (up to MAX_CAPTURE_BYTES), and the
    // CLI runs with `--output-format stream-json --verbose`, so stdout carries
    // every `tool_result` block the agent produced. An agent that shelled out
    // and hit its own ENOENT must not be read as OUR binary going missing.
    expect(
      isMissingExecutableFailure(
        run({
          errorCode: "adapter_failed",
          error: "upstream returned 503",
          resultJson: {
            stdout:
              '{"type":"user","message":{"content":[{"type":"tool_result","content":"spawn npm ENOENT"}]}}',
          },
        }),
      ),
    ).toBe(false);

    expect(
      isMissingExecutableFailure(
        run({
          errorCode: "adapter_failed",
          resultJson: { stderr: "npm: command not found in PATH" },
        }),
      ),
    ).toBe(false);

    // ...and the misclassification must not leak through the classifier either.
    expect(
      classifyContinuationFailure(
        run({
          errorCode: "adapter_failed",
          error: "upstream returned 503",
          resultJson: { stdout: "Error: spawn npm ENOENT" },
        }),
      ).kind,
    ).toBe("transient_infra");
  });

  it("still matches the named string fields the adapter actually sets", () => {
    expect(isMissingExecutableFailure(run({ error: "spawn claude ENOENT" }))).toBe(true);
    expect(
      isMissingExecutableFailure(run({ resultJson: { errorMessage: "spawn claude ENOENT" } })),
    ).toBe(true);
    expect(
      isMissingExecutableFailure(
        run({ resultJson: { message: 'Command not found in PATH: "claude"' } }),
      ),
    ).toBe(true);
  });

  it("tolerates non-string values in the named fields", () => {
    expect(
      isMissingExecutableFailure(run({ resultJson: { errorMessage: 42, message: null } })),
    ).toBe(false);
    expect(isMissingExecutableFailure(run({ resultJson: "spawn claude ENOENT" }))).toBe(false);
  });
});

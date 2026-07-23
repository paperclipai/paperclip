import { describe, expect, it } from "vitest";

import {
  OPENCODE_TRANSIENT_DEFAULT_BACKOFF_MS,
  OPENCODE_TRANSIENT_MAX_BACKOFF_MS,
  detectOpenCodeTransientUpstream,
  extractOpenCodeRetryHint,
  resolveOpenCodeTransientUpstreamMode,
  resolveOpenCodeTransientUpstreamOutcome,
} from "./transient.js";

const NOW = new Date("2026-07-01T12:00:00.000Z");

// The observed GOL-4038 failure shape: clean exit 0, no assistant output, the
// terminal upstream error only visible in the captured stream text.
const GEMINI_429_STDERR = [
  "AI_APICallError: Resource has been exhausted (e.g. check quota).",
  '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"27s"}]}}',
].join("\n");

describe("detectOpenCodeTransientUpstream", () => {
  it("detects a 429 RESOURCE_EXHAUSTED clean exit and honors retryDelay", () => {
    const detection = detectOpenCodeTransientUpstream(
      { stdout: "", stderr: GEMINI_429_STDERR, errorMessage: null, exitCode: 0, hasOutput: false },
      NOW,
    );
    expect(detection.detected).toBe(true);
    expect(detection.signature).toBe("resource_exhausted");
    expect(detection.retryHintSource).toBe("retry_delay");
    expect(detection.retryNotBefore?.toISOString()).toBe(new Date(NOW.getTime() + 27_000).toISOString());
    expect(detection.evidence).toContain("RESOURCE_EXHAUSTED");
  });

  it("detects statusCode 429 with Retry-After seconds on a nonzero exit", () => {
    const detection = detectOpenCodeTransientUpstream(
      {
        stdout: "",
        stderr: 'AI_APICallError: Too Many Requests\nstatusCode: 429\nresponseHeaders: { "retry-after": "45" }',
        errorMessage: null,
        exitCode: 1,
        hasOutput: false,
      },
      NOW,
    );
    expect(detection.detected).toBe(true);
    expect(detection.retryHintSource).toBe("retry_after_seconds");
    expect(detection.retryNotBefore?.toISOString()).toBe(new Date(NOW.getTime() + 45_000).toISOString());
  });

  it("detects a structured JSONL error event mentioning a quota failure", () => {
    const detection = detectOpenCodeTransientUpstream(
      {
        stdout: "",
        stderr: "",
        errorMessage: "You exceeded your current quota, please check your plan and billing details.",
        exitCode: 1,
        hasOutput: false,
      },
      NOW,
    );
    expect(detection.detected).toBe(true);
    expect(detection.signature).toBe("quota");
    // No explicit hint: default floor applies.
    expect(detection.retryHintSource).toBe("default");
    expect(detection.retryNotBefore?.toISOString()).toBe(
      new Date(NOW.getTime() + OPENCODE_TRANSIENT_DEFAULT_BACKOFF_MS).toISOString(),
    );
  });

  it("detects retryable 5xx / overloaded signatures", () => {
    for (const stderr of [
      "AI_APICallError: Internal Server Error\nstatusCode: 500",
      'statusCode: 529\n{"type":"error","error":{"type":"overloaded_error"}}',
      "upstream connect error: 503 Service Unavailable",
    ]) {
      const detection = detectOpenCodeTransientUpstream(
        { stdout: "", stderr, errorMessage: null, exitCode: 0, hasOutput: false },
        NOW,
      );
      expect(detection.detected, stderr).toBe(true);
      expect(detection.retryNotBefore).not.toBeNull();
    }
  });

  it("parses 'try again in' prose hints", () => {
    const detection = detectOpenCodeTransientUpstream(
      {
        stdout: "",
        stderr: "Rate limit reached for gpt-x. Please try again in 1.5m.",
        errorMessage: null,
        exitCode: 0,
        hasOutput: false,
      },
      NOW,
    );
    expect(detection.detected).toBe(true);
    expect(detection.retryHintSource).toBe("retry_in_phrase");
    expect(detection.retryNotBefore?.toISOString()).toBe(new Date(NOW.getTime() + 90_000).toISOString());
  });

  it("clamps absurd provider hints to the backoff ceiling", () => {
    const detection = detectOpenCodeTransientUpstream(
      {
        stdout: "",
        stderr: 'RESOURCE_EXHAUSTED "retryDelay": "999999999s"',
        errorMessage: null,
        exitCode: 0,
        hasOutput: false,
      },
      NOW,
    );
    expect(detection.retryNotBefore?.toISOString()).toBe(
      new Date(NOW.getTime() + OPENCODE_TRANSIENT_MAX_BACKOFF_MS).toISOString(),
    );
  });

  it("does NOT reclassify a productive exit-0 run whose transcript mentions rate limits", () => {
    const detection = detectOpenCodeTransientUpstream(
      {
        stdout: '{"type":"text","part":{"text":"the API returned 429 too many requests yesterday"}}',
        stderr: "",
        errorMessage: null,
        exitCode: 0,
        hasOutput: true,
      },
      NOW,
    );
    expect(detection.detected).toBe(false);
  });

  it("does NOT match deterministic auth failures (401 invalid key)", () => {
    const detection = detectOpenCodeTransientUpstream(
      {
        stdout: "",
        stderr: "AI_APICallError: Incorrect API key provided\nstatusCode: 401",
        errorMessage: null,
        exitCode: 1,
        hasOutput: false,
      },
      NOW,
    );
    expect(detection.detected).toBe(false);
  });

  it("does NOT match clean successful runs or timeouts", () => {
    expect(
      detectOpenCodeTransientUpstream(
        { stdout: '{"type":"text","part":{"text":"done"}}', stderr: "", errorMessage: null, exitCode: 0, hasOutput: true },
        NOW,
      ).detected,
    ).toBe(false);
    expect(
      detectOpenCodeTransientUpstream(
        { stdout: "", stderr: GEMINI_429_STDERR, errorMessage: null, exitCode: null, timedOut: true, hasOutput: false },
        NOW,
      ).detected,
    ).toBe(false);
  });
});

describe("extractOpenCodeRetryHint", () => {
  it("parses an HTTP-date Retry-After header", () => {
    const hint = extractOpenCodeRetryHint(
      { stderr: 'retry-after: "Wed, 01 Jul 2026 12:10:00 GMT"' },
      NOW,
    );
    expect(hint?.source).toBe("retry_after_date");
    expect(hint?.retryNotBefore.toISOString()).toBe("2026-07-01T12:10:00.000Z");
  });

  it("clamps a past Retry-After date up to the minimum backoff", () => {
    const hint = extractOpenCodeRetryHint(
      { stderr: 'retry-after: "Wed, 01 Jul 2026 11:00:00 GMT"' },
      NOW,
    );
    expect(hint?.retryNotBefore.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("returns null when no hint is present", () => {
    expect(extractOpenCodeRetryHint({ stderr: "RESOURCE_EXHAUSTED" }, NOW)).toBeNull();
  });

  // Critic F-2 regression: backtracking must not shrink the number to a prefix
  // digit ("3") and slip past the GMT/UTC negative lookahead.
  it("does not misparse a bare 'retry-after: 30 GMT' as 3 seconds", () => {
    expect(extractOpenCodeRetryHint({ stderr: "retry-after: 30 GMT" }, NOW)).toBeNull();
    const plain = extractOpenCodeRetryHint({ stderr: "retry-after: 30" }, NOW);
    expect(plain?.source).toBe("retry_after_seconds");
    expect(plain?.retryNotBefore.toISOString()).toBe(new Date(NOW.getTime() + 30_000).toISOString());
  });
});

describe("resolveOpenCodeTransientUpstreamMode", () => {
  it("defaults to shadow when unset or unrecognized", () => {
    expect(resolveOpenCodeTransientUpstreamMode(undefined)).toBe("shadow");
    expect(resolveOpenCodeTransientUpstreamMode("")).toBe("shadow");
    expect(resolveOpenCodeTransientUpstreamMode("banana")).toBe("shadow");
  });

  it("recognizes enforce and off spellings", () => {
    expect(resolveOpenCodeTransientUpstreamMode("enforce")).toBe("enforce");
    expect(resolveOpenCodeTransientUpstreamMode("ENFORCE")).toBe("enforce");
    expect(resolveOpenCodeTransientUpstreamMode("on")).toBe("enforce");
    expect(resolveOpenCodeTransientUpstreamMode("off")).toBe("off");
    expect(resolveOpenCodeTransientUpstreamMode("0")).toBe("off");
    expect(resolveOpenCodeTransientUpstreamMode("disabled")).toBe("off");
  });
});

describe("resolveOpenCodeTransientUpstreamOutcome", () => {
  const detection = detectOpenCodeTransientUpstream(
    { stdout: "", stderr: GEMINI_429_STDERR, errorMessage: null, exitCode: 0, hasOutput: false },
    NOW,
  );

  // Plan §6 acceptance: an opencode 429 exit yields errorFamily transient_upstream
  // plus a future retryNotBefore.
  it("enforce mode rewrites a clean 429 exit into a backed-off failure", () => {
    const outcome = resolveOpenCodeTransientUpstreamOutcome({ mode: "enforce", detection, exitCode: 0 });
    expect(outcome.enforce).toBe(true);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.errorCode).toBe("opencode_transient_upstream");
    expect(outcome.errorFamily).toBe("transient_upstream");
    expect(outcome.retryNotBefore).toBe(new Date(NOW.getTime() + 27_000).toISOString());
    expect(new Date(outcome.retryNotBefore ?? 0).getTime()).toBeGreaterThan(NOW.getTime());
    expect(outcome.shadowRecord).toBeNull();
  });

  it("enforce mode preserves an already nonzero exit code", () => {
    const outcome = resolveOpenCodeTransientUpstreamOutcome({ mode: "enforce", detection, exitCode: 3 });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.errorCode).toBe("opencode_transient_upstream");
  });

  it("shadow mode changes nothing but records what it would have done", () => {
    const outcome = resolveOpenCodeTransientUpstreamOutcome({ mode: "shadow", detection, exitCode: 0 });
    expect(outcome.enforce).toBe(false);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.errorCode).toBeNull();
    expect(outcome.errorFamily).toBeNull();
    expect(outcome.retryNotBefore).toBeNull();
    expect(outcome.shadowRecord).toMatchObject({
      detected: true,
      mode: "shadow",
      signature: "resource_exhausted",
      wouldErrorCode: "opencode_transient_upstream",
      wouldRetryNotBefore: new Date(NOW.getTime() + 27_000).toISOString(),
    });
  });

  it("off mode and non-detections pass through untouched", () => {
    const offOutcome = resolveOpenCodeTransientUpstreamOutcome({ mode: "off", detection, exitCode: 0 });
    expect(offOutcome).toMatchObject({ enforce: false, exitCode: 0, errorCode: null, shadowRecord: null });
    const cleanDetection = detectOpenCodeTransientUpstream(
      { stdout: "", stderr: "", errorMessage: null, exitCode: 0, hasOutput: true },
      NOW,
    );
    const cleanOutcome = resolveOpenCodeTransientUpstreamOutcome({ mode: "enforce", detection: cleanDetection, exitCode: 0 });
    expect(cleanOutcome).toMatchObject({ enforce: false, exitCode: 0, errorCode: null });
  });
});

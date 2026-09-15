import { describe, expect, it } from "vitest";

import { classifyFailure, shouldRetryFailure } from "./failure-classifier.js";
import {
  findSensitiveJsonValue,
  findSensitiveValue,
  normalizedSensitiveValues,
  redactText,
  sanitizeJson,
} from "./redaction.js";

describe("Runner acceptance failure classification", () => {
  it.each([
    ["assertion runtime mode expected legacy observed native", "candidate_failure"],
    ["provider connection timed out", "transient_infrastructure"],
    ["provider unsupported by this runner", "permanent_infrastructure"],
    ["secret redaction leak in result", "secret_leak"],
    ["teardown left a process running", "cleanup_failure"],
  ] as const)("classifies %s", (message, expected) => {
    expect(classifyFailure(new Error(message))).toBe(expected);
  });

  it("retries only transient infrastructure failures", () => {
    expect(shouldRetryFailure("transient_infrastructure")).toBe(true);
    expect(shouldRetryFailure("candidate_failure")).toBe(false);
    expect(shouldRetryFailure("secret_leak")).toBe(false);
  });
});

describe("Runner acceptance redaction", () => {
  const fakeSensitiveValue = ["fixture", "sensitive", "value"].join("-");
  const secretShapedValue = ["sk", "proj", "fixturevalue1234567890"].join("-");

  it("deduplicates and orders known sensitive values longest first", () => {
    expect(normalizedSensitiveValues([" short ", undefined, "long-value", "short"]))
      .toEqual(["long-value", "short"]);
  });

  it("redacts exact values, secret shapes, and structured sensitive fields", () => {
    expect(redactText(
      `value=${fakeSensitiveValue} shaped=${secretShapedValue}`,
      [fakeSensitiveValue],
    )).toBe("value=[REDACTED] shaped=[REDACTED]");
    expect(sanitizeJson({
      nested: { accessToken: fakeSensitiveValue },
      detail: `received ${secretShapedValue}`,
    }, [fakeSensitiveValue])).toEqual({
      nested: { accessToken: "[REDACTED]" },
      detail: "received [REDACTED]",
    });
  });

  it("detects exact, shaped, and sensitive-key leaks without scanning files", () => {
    expect(findSensitiveValue(fakeSensitiveValue, [fakeSensitiveValue]))
      .toBe("exact sensitive value");
    expect(findSensitiveValue(secretShapedValue)).toBe("secret-shaped value");
    expect(findSensitiveJsonValue({ password: "fixture-password" }))
      .toBe("sensitive field password");
    expect(findSensitiveJsonValue({ schema: "paperclip.runner-acceptance.result/v1" }))
      .toBeNull();
  });
});

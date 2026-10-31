import { expect, it } from "vitest";
import { privateAttemptDiagnostic } from "./private-attempt-diagnostic.js";

it("exposes only closed codes and counts even when the error contains private values", () => {
  const secret = "private-provider-output-and-credential";
  const value = privateAttemptDiagnostic({ stage: secret, result: { status: secret, failureClass: secret,
    error: secret, runIds: [secret], matcherResults: [secret] }, error: new Error(secret) });
  expect(JSON.stringify(value)).not.toContain(secret);
  expect(value).toMatchObject({ stage: "unknown", status: "unknown", failureClass: "unknown", runs: 1, checks: 1, finalization: "unclassified" });
});
it("distinguishes original product failure from an evidence bound", () => {
  expect(privateAttemptDiagnostic({ stage: "seal-original", result: { status: "failed", failureClass: "candidate_failure",
    error: "Timed out waiting for Actual new native task reads inherited project context; private details" },
    error: new Error("Complete original evidence exceeds byte allowance") })).toMatchObject({
    status: "failed", failureClass: "candidate_failure", phase: "future-work-timeout", finalization: "byte-bound",
  });
});

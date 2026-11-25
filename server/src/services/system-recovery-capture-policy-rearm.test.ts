import { expect, it } from "vitest";
import { REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION } from "./remote-workspace-snapshot-archive.js";
import { isCapturePolicyRearmable } from "./system-recovery-state.js";

const exhaustedSave = (capturePolicyVersion: number | undefined) => ({
  state: "exhausted" as const, phase: "preserve_files" as const, capturePolicyVersion,
  failure: { code: "export_interrupted", retryClass: "retry_transient", evidenceFingerprint: "9".repeat(64) },
}) as Parameters<typeof isCapturePolicyRearmable>[0];

it("names pipes in capture policy 3", () => {
  expect(REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION).toBeGreaterThanOrEqual(3);
});

it("re-arms a save exhausted under policy 2, which refused named pipes", () => {
  expect(isCapturePolicyRearmable(exhaustedSave(2))).toBe(true);
});

it("does not re-arm a save already exhausted under the current policy", () => {
  expect(isCapturePolicyRearmable(exhaustedSave(REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION))).toBe(false);
});

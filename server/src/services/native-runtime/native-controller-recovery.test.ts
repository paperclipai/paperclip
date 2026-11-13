import { describe, expect, it } from "vitest";
import { createNativeControllerRecovery, readNativeControllerRecovery } from "./native-controller-recovery.js";
import { nativeSha256 } from "./canonical.js";
import { redactRegisteredSecretValues } from "../run-secret-redaction.js";
import type { PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";

const snapshot: PersistedNativeSession = { backendKind: "mock", sessionId: "provider",
  identity: { companyId: "company", agentId: "agent", issueId: "issue", runId: "run", sessionId: "session" } };
const compatibility = { configDigest: `sha256:${"a".repeat(64)}`, processConfigDigest: null };
const binding = { runId: "run", runnerInstanceId: "runner", normalizedSessionId: "session" };

describe("native controller recovery envelope", () => {
  it("binds the stored snapshot, including redaction, without serializing its contents twice", () => {
    const stored = { ...snapshot, providerSessionId: "[REDACTED]" };
    const envelope = createNativeControllerRecovery(stored, compatibility, binding);
    expect(envelope.snapshotSha256).toBe(nativeSha256(stored));
    expect(readNativeControllerRecovery(envelope, JSON.parse(JSON.stringify(stored)))).toEqual(envelope);
    expect(readNativeControllerRecovery(envelope, { ...stored, providerSessionId: "secret-before-redaction" })).toBeNull();
    expect(JSON.stringify(envelope)).not.toContain("[REDACTED]");
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(4096);
  });

  it("does not certify a missing PRP publication or unknown format", () => {
    const pending = createNativeControllerRecovery(snapshot, compatibility, null);
    expect(readNativeControllerRecovery(pending, snapshot)).toBeNull();
    const published = createNativeControllerRecovery(snapshot, compatibility, binding);
    expect(readNativeControllerRecovery({ ...published, schema: "future" }, snapshot)).toBeNull();
    expect(readNativeControllerRecovery({ ...published, processConfigDigest: "unverified" }, snapshot)).toBeNull();
  });

  it("enforces the metadata byte bound on both write and read", () => {
    expect(() => createNativeControllerRecovery(snapshot, { ...compatibility, configDigest: "x".repeat(4096) }, binding))
      .toThrow("metadata_too_large");
    expect(readNativeControllerRecovery({ ...createNativeControllerRecovery(snapshot, compatibility, binding), extra: "x".repeat(4096) }, snapshot))
      .toBeNull();
  });

  it("keeps compatibility metadata out of public run projections", () => {
    expect(redactRegisteredSecretValues({ runnerProfileJson: { preserved: true,
      nativeControllerRecovery: createNativeControllerRecovery(snapshot, compatibility, binding) } }, []))
      .toEqual({ runnerProfileJson: { preserved: true } });
  });
});

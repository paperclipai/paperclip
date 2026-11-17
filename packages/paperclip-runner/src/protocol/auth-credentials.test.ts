import { describe, expect, it } from "vitest";
import { isCanonicalProviderEventType } from "../provider-events.js";
import { validatePrpEvent, type PrpAuthCredentialsUpdated, type PrpEvent } from "./replay-contract.js";

const payload: PrpAuthCredentialsUpdated = {
  schema: "paperclip.auth.credentials.updated.v1", provider: "grok", bindingId: "harness-auth",
  revision: 1, detection: "credential_store",
};

function event(version: 1 | 2 | 3): PrpEvent {
  return {
    schema: `paperclip.prp.event.v${version}`,
    schemaVersion: version, sourceEventId: "credential-update-1", sourceSeq: 1,
    sourceInstanceId: "runner", sourceKind: "runner", runId: "run", normalizedSessionId: "session",
    eventType: "auth.credentials.updated", priority: 0, emittedAt: "2026-10-15T12:00:00.000Z", payload,
  };
}

describe.each([1, 2, 3] as const)("PRP v%s credential updates", (version) => {
  it("accepts content-free store and native-hook notifications", () => {
    expect(isCanonicalProviderEventType("auth.credentials.updated")).toBe(true);
    expect(validatePrpEvent(event(version)).ok).toBe(true);
    expect(validatePrpEvent({ ...event(version), payload: { ...payload, detection: "native_hook" } }).ok).toBe(true);
  });

  it("rejects secret material, missing fields, invalid revisions, and downgraded priority", () => {
    const invalid = [
      { ...payload, access_token: "secret-sentinel" }, { ...payload, refresh_token: "secret-sentinel" },
      { ...payload, path: "/private/auth.json" }, { ...payload, fingerprint: "secret-digest" },
      { ...payload, revision: 0 }, { ...payload, revision: 1.5 }, { ...payload, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...payload, detection: "inferred_from_account_notification" }, { ...payload, bindingId: "" },
      { ...payload, schema: "paperclip.auth.credentials.updated.v2" },
      Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "provider")),
    ];
    for (const candidate of invalid) {
      expect(validatePrpEvent({ ...event(version), payload: candidate }).ok, JSON.stringify(candidate)).toBe(false);
    }
    expect(validatePrpEvent({ ...event(version), priority: 1 }).ok).toBe(false);
    expect(validatePrpEvent({ ...event(version), sourceKind: "control_plane" }).ok).toBe(false);
  });
});

import { it, expect } from "vitest";
import { immutableOwnedDaytonaSelection, ownedDaytonaProbeMatches } from "./runtime-daytona-target.js";
import { runtimePrivateRequirements, validateRuntimePrivateRequirement } from "../chat-runtime-private-requirements.js";
const digest = `sha256:${"a".repeat(64)}`;
it("requires immutable image identity and a new owned company namespace, never existing remote state", () => {
  const good = { imageRef: `registry.invalid/image@${digest}`, imageDigest: digest, disposableNamespace: "fixture.company", qualifiedHarness: "codex" };
  expect(immutableOwnedDaytonaSelection(good)).toBe(true);
  for (const patch of [{ imageRef: "registry.invalid/image:latest" }, { imageDigest: `sha256:${"b".repeat(64)}` }, { disposableNamespace: "production" }, { qualifiedHarness: "fake" }]) expect(immutableOwnedDaytonaSelection({ ...good, ...patch })).toBe(false);
});
it("requires actual scoped lease and public qualification bound to exact image/secret/environment", () => {
  const input = { companyId: "company", environmentId: "environment", secretId: "secret", imageRef: `registry.invalid/image@${digest}`, environment: { id: "environment", driver: "sandbox", status: "active", config: { provider: "daytona", image: `registry.invalid/image@${digest}`, apiKey: { type: "secret_ref", secretId: "secret" } } }, probe: { ok: true, details: { platformQualificationRecorded: true, leaseId: "lease" } }, lease: { id: "lease", companyId: "company", environmentId: "environment", provider: "daytona", providerLeaseId: "provider-resource", status: "released", cleanupStatus: "success", acquiredAt: "2026-10-27" } } as unknown as Parameters<typeof ownedDaytonaProbeMatches>[0];
  expect(ownedDaytonaProbeMatches(input)).toBe(true);
  for (const patch of [{ companyId: "foreign" }, { environmentId: "foreign" }, { secretId: "other-secret" }, { probe: { ...input.probe, ok: false } }, { lease: { ...input.lease, providerLeaseId: null } }, { lease: { ...input.lease, companyId: "foreign" } }]) expect(ownedDaytonaProbeMatches({ ...input, ...patch })).toBe(false);
});
it("admits only the two finite owned remote recovery private contracts", () => { for (const id of ["recovery.workspace-repair", "workspaces.recover-lost-sandbox"] as const) { const spec = runtimePrivateRequirements[id]; expect(validateRuntimePrivateRequirement(id, spec.provider, spec.fields, spec.credentials)).toBe(true); expect(() => validateRuntimePrivateRequirement(id, spec.provider, spec.fields, [])).toThrow("exact"); } });

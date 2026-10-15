import { describe, expect, it } from "vitest";
import type { Environment, SandboxEnvironmentConfig } from "@paperclipai/shared";
import { fingerprintEnvironmentSandboxProviderConfig as fingerprint, SANDBOX_PLATFORM_PROBE_METADATA_KEY } from "../services/environment-custom-image-runtime.js";
import { qualifiedSandboxSnapshotId, type SandboxTemplateIdentity } from "../services/sandbox-snapshot-qualification.js";

function fixture() {
  const config = { provider: "daytona", snapshot: "managed-snapshot", apiKey: "fixture-account" } as SandboxEnvironmentConfig;
  const template: SandboxTemplateIdentity = { id: "template", capturedAt: "2026-10-15T00:00:00Z", templateKind: "snapshot", bindingField: "snapshot" };
  const identity = { provider: "daytona", requestedRef: config.snapshot, id: "a6b9e7d0-f886-471a-b461-640dd03e8d0f", name: config.snapshot, organizationId: "provider-account", createdAt: "2026-10-07T23:19:57.133Z" };
  const proof = { v: 2, companyId: "company", snapshot: config.snapshot, template,
    baseConfigFingerprint: fingerprint(config), runtimeConfigFingerprint: fingerprint(config), snapshotIdentity: identity };
  const environment = { config, metadata: { [SANDBOX_PLATFORM_PROBE_METADATA_KEY]: { company: proof } } } as unknown as Environment;
  return { config, template, identity, proof, environment };
}

describe("qualified snapshot execution binding", () => {
  it("pins the measured provider ID without a network lookup", () => {
    const f = fixture();
    expect(qualifiedSandboxSnapshotId(f.environment, "company", f.config, f.template)).toBe(f.identity.id);
  });
  it.each(["company", "base-config", "account", "template", "snapshot", "image", "provider", "identity"])("rejects changed %s", change => {
    const f = fixture();
    let company = "company";
    if (change === "company") company = "foreign-company";
    if (change === "base-config") f.environment.config = { ...f.config, target: "different" };
    if (change === "account") f.config = { ...f.config, apiKey: "different-account" };
    if (change === "template") f.template = { ...f.template!, capturedAt: "2026-10-16T00:00:00Z" };
    if (change === "snapshot") f.config = { ...f.config, snapshot: "new-snapshot" };
    if (change === "image") f.config = { ...f.config, image: "other-image" };
    if (change === "provider") f.config = { ...f.config, provider: "other-provider" };
    if (change === "identity") f.identity.id = "mutable-name";
    expect(qualifiedSandboxSnapshotId(f.environment, company, f.config, f.template)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  describeBuiltinSandboxProvider,
  redactSandboxEventPayload,
  toSandboxLeaseReadModel,
} from "./read-model.js";
import type { EnvironmentLease } from "@paperclipai/shared";

const ACQUIRED_AT = new Date("2026-04-16T05:00:00.000Z");
const NOW = new Date("2026-05-16T05:00:00.000Z");

function buildLease(overrides: Partial<EnvironmentLease> = {}): EnvironmentLease {
  return {
    id: "lease-1",
    companyId: "company-1",
    environmentId: "env-1",
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: null,
    status: "active",
    leasePolicy: "ephemeral",
    provider: "docker",
    providerLeaseId: "sandbox://docker/env-1/abc",
    acquiredAt: ACQUIRED_AT,
    lastUsedAt: NOW,
    expiresAt: null,
    releasedAt: null,
    failureReason: null,
    cleanupStatus: null,
    metadata: {
      provider: "docker",
      image: "node:20",
      reuseLease: false,
      sandboxState: "running",
      kind: "docker",
      capabilities: {
        rootless: true,
        dropAllCapabilities: true,
        seccompProfile: "default",
        readOnlyRootfs: true,
        noNewPrivileges: true,
        cgroupsVersion: "v2",
        // attacker-controlled extra key should be dropped
        backdoor: "yes",
      },
      quotas: {
        cpuMillicores: 500,
        memoryBytes: 134217728,
        // extra unknown key should be dropped
        secretBudget: "$100",
      },
      network: {
        mode: "none",
        egressAllowlist: [],
        dnsAllowlist: [],
        allowLoopback: true,
        allowInboundPorts: [],
        // extra unknown key should be dropped
        backchannel: "10.0.0.1",
      },
      policyHash: "policy-hash-abc",
      // sensitive fields that must never appear in the read model
      env: { TOKEN: "secret-token-123" },
      command: "psql postgres://user:hunter2@db.internal/foo",
      destinationId: "destination-secret",
    },
    createdAt: ACQUIRED_AT,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("toSandboxLeaseReadModel", () => {
  it("projects allowlisted capabilities/quotas/network and drops unknown fields", () => {
    const lease = buildLease();
    const model = toSandboxLeaseReadModel(lease, new Map([["docker", true]]));

    expect(model.capabilities).toEqual({
      rootless: true,
      dropAllCapabilities: true,
      seccompProfile: "default",
      readOnlyRootfs: true,
      noNewPrivileges: true,
      cgroupsVersion: "v2",
    });
    expect(model.capabilities).not.toHaveProperty("backdoor");
    expect(model.quotas).toEqual({ cpuMillicores: 500, memoryBytes: 134217728 });
    expect(model.quotas).not.toHaveProperty("secretBudget");
    expect(model.network).toEqual({
      mode: "none",
      egressAllowlist: [],
      dnsAllowlist: [],
      allowLoopback: true,
      allowInboundPorts: [],
    });
    expect(model.network).not.toHaveProperty("backchannel");
  });

  it("omits secret metadata fields (env, command, destinationId)", () => {
    const lease = buildLease();
    const model = toSandboxLeaseReadModel(lease, new Map([["docker", true]]));
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("secret-token-123");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("destination-secret");
    expect(serialized).not.toContain("backdoor");
    expect(serialized).not.toContain("secretBudget");
    expect(serialized).not.toContain("backchannel");
  });

  it("labels truth=backend-backed when provider enabled and sandbox state advanced", () => {
    const lease = buildLease();
    const model = toSandboxLeaseReadModel(lease, new Map([["docker", true]]));
    expect(model.truth).toBe("backend-backed");
    expect(model.providerEnabled).toBe(true);
    expect(model.sandboxState).toBe("running");
  });

  it("labels truth=derived when sandbox state is only requested/provisioning", () => {
    const lease = buildLease({ metadata: { ...buildLease().metadata!, sandboxState: "requested" } });
    const model = toSandboxLeaseReadModel(lease, new Map([["docker", true]]));
    expect(model.truth).toBe("derived");
  });

  it("labels truth=preview when provider is disabled", () => {
    const lease = buildLease();
    const model = toSandboxLeaseReadModel(lease, new Map([["docker", false]]));
    expect(model.truth).toBe("preview");
    expect(model.providerEnabled).toBe(false);
  });

  it("labels truth=preview when providerLeaseId is null", () => {
    const lease = buildLease({ providerLeaseId: null });
    const model = toSandboxLeaseReadModel(lease, new Map([["docker", true]]));
    expect(model.truth).toBe("preview");
  });

  it("redacts failureReason via redactLearningEvidence", () => {
    const lease = buildLease({
      status: "failed",
      failureReason: "command failed: Bearer abcd1234efgh password=hunter2 dest psql postgres://u:p@h/d",
    });
    const model = toSandboxLeaseReadModel(lease, new Map([["docker", true]]));
    expect(model.failureReason).toContain("[REDACTED]");
    expect(model.failureReason).not.toContain("hunter2");
    expect(model.failureReason).not.toContain("abcd1234efgh");
  });

  it("summarizes artifacts as boolean+count without paths", () => {
    const lease = buildLease({
      metadata: {
        ...buildLease().metadata!,
        artifacts: { logs: "/host/secret-path/log.txt", report: "/host/report.json" },
      },
    });
    const model = toSandboxLeaseReadModel(lease, new Map([["docker", true]]));
    expect(model.artifacts).toEqual({ present: true, count: 2 });
    expect(JSON.stringify(model.artifacts)).not.toContain("/host/secret-path");
  });
});

describe("redactSandboxEventPayload", () => {
  it("recursively scrubs known secret patterns from event payloads", () => {
    const payload = {
      summary: "Bearer abcd1234 password=hunter2",
      nested: { url: "postgres://user:hunter2@db.internal/foo", arr: ["api_key=topsecret"] },
    };
    const redacted = redactSandboxEventPayload(payload);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("topsecret");
    expect(serialized).not.toContain("abcd1234");
    expect(serialized).toContain("[REDACTED]");
  });
});

describe("describeBuiltinSandboxProvider", () => {
  it("marks docker provider preview-only even when its runtime flag is set", () => {
    const desc = describeBuiltinSandboxProvider({ provider: "docker", enabled: true });
    expect(desc).toEqual({ provider: "docker", kind: "builtin", enabled: true, previewOnly: true });
  });

  it("marks the fake provider preview-only and not enabled", () => {
    const desc = describeBuiltinSandboxProvider({ provider: "fake", enabled: false });
    expect(desc).toEqual({ provider: "fake", kind: "builtin", enabled: false, previewOnly: true });
  });
});

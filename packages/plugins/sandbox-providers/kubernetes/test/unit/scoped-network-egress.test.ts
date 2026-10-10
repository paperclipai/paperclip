import { describe, expect, it, vi } from "vitest";
import {
  appendNetworkEgressDenyHint,
  createScopedNetworkEgressPolicy,
  createScopedNetworkEgressPolicyOrReleaseWorkload,
  parseScopedNetworkEgressGrant,
} from "../../src/scoped-network-egress.js";

describe("scoped network egress", () => {
  it("normalizes task grants", () => {
    expect(parseScopedNetworkEgressGrant({
      networkEgress: {
        allowFqdns: ["GitHub.com", "pypi.org"],
        allowCidrs: ["203.0.113.0/24"],
      },
    })).toEqual({
      allowFqdns: ["github.com", "pypi.org"],
      allowCidrs: ["203.0.113.0/24"],
    });
  });

  it("creates a standard policy scoped to the run label", async () => {
    const createNamespacedNetworkPolicy = vi.fn().mockResolvedValue({});
    await createScopedNetworkEgressPolicy({
      clients: { networking: { createNamespacedNetworkPolicy } } as never,
      namespace: "paperclip-acme",
      mode: "standard",
      runId: "run-123",
      workloadName: "pc-workload",
      ownerReference: { apiVersion: "batch/v1", kind: "Job", name: "pc-workload", uid: "uid-1" },
      grant: { allowFqdns: ["github.com", "pypi.org"], allowCidrs: [] },
    });
    expect(createNamespacedNetworkPolicy).toHaveBeenCalledWith(expect.objectContaining({
      namespace: "paperclip-acme",
      body: expect.objectContaining({
        metadata: expect.objectContaining({ name: "pc-workload-egress" }),
        spec: expect.objectContaining({ podSelector: { matchLabels: { "paperclip.io/run-id": "run-123" } } }),
      }),
    }));
  });

  it("caps scoped policy names while preserving the workload tail", async () => {
    const createNamespacedNetworkPolicy = vi.fn().mockResolvedValue({});
    const workloadName = `pc-${"a".repeat(260)}-unique-tail`;

    const name = await createScopedNetworkEgressPolicy({
      clients: { networking: { createNamespacedNetworkPolicy } } as never,
      namespace: "paperclip-acme",
      mode: "standard",
      runId: "run-123",
      workloadName,
      ownerReference: { apiVersion: "batch/v1", kind: "Job", name: workloadName, uid: "uid-1" },
      grant: { allowFqdns: ["github.com"], allowCidrs: [] },
    });

    expect(name).toHaveLength(253);
    expect(name).toMatch(/unique-tail-egress$/);
  });

  it("adds the policy and grant path to likely network denials", () => {
    expect(appendNetworkEgressDenyHint("curl: Could not resolve host: example.com", {
      allowFqdns: ["github.com"],
      allowCidrs: [],
    })).toContain("executionWorkspaceSettings.networkEgress");
  });

  it("releases the workload when scoped policy creation fails", async () => {
    const policyError = new Error("policy denied");
    const releaseWorkload = vi.fn().mockResolvedValue(undefined);

    await expect(createScopedNetworkEgressPolicyOrReleaseWorkload({
      clients: {
        networking: {
          createNamespacedNetworkPolicy: vi.fn().mockRejectedValue(policyError),
        },
      } as never,
      namespace: "paperclip-acme",
      mode: "standard",
      runId: "run-123",
      workloadName: "pc-workload",
      ownerReference: { apiVersion: "batch/v1", kind: "Job", name: "pc-workload", uid: "uid-1" },
      grant: { allowFqdns: ["github.com"], allowCidrs: [] },
    }, releaseWorkload)).rejects.toBe(policyError);
    expect(releaseWorkload).toHaveBeenCalledOnce();
  });
});

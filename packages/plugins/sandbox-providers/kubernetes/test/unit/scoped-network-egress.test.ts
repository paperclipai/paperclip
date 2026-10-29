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

  it("creates a per-lease adapter policy with base rules, scoped to the run", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const name = await createScopedNetworkEgressPolicy({
      clients: { custom: { createNamespacedCustomObject } } as never,
      namespace: "paperclip-acme",
      mode: "cilium",
      runId: "run-123",
      workloadName: "pc-workload",
      ownerReference: { apiVersion: "agents.x-k8s.io/v1alpha1", kind: "Sandbox", name: "pc-workload", uid: "uid-1" },
      suffix: "-adapter-egress",
      grant: { allowFqdns: ["claude.com"], allowCidrs: [] },
      baseRules: { paperclipServerNamespace: "paperclip", paperclipServerPodSelector: { app: "paperclip" } },
    });
    expect(name).toBe("pc-workload-adapter-egress");
    const body = createNamespacedCustomObject.mock.calls[0][0].body;
    expect(body.spec.endpointSelector).toEqual({ matchLabels: { "paperclip.io/run-id": "run-123" } });
    expect(body.metadata.ownerReferences[0].uid).toBe("uid-1");
    const egress = JSON.stringify(body.spec.egress);
    for (const v of ["claude.com", "kube-dns", "\"app\":\"paperclip\"", "3100"]) expect(egress).toContain(v);
  });

  it("creates the per-lease adapter policy even with an empty grant (base rules only)", async () => {
    const createNamespacedNetworkPolicy = vi.fn().mockResolvedValue({});
    await createScopedNetworkEgressPolicy({
      clients: { networking: { createNamespacedNetworkPolicy } } as never,
      namespace: "paperclip-acme",
      mode: "standard",
      runId: "run-123",
      workloadName: "pc-workload",
      ownerReference: { apiVersion: "batch/v1", kind: "Job", name: "pc-workload", uid: "uid-1" },
      suffix: "-adapter-egress",
      grant: { allowFqdns: [], allowCidrs: [] },
      baseRules: { paperclipServerNamespace: "paperclip" },
    });
    expect(createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1);
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

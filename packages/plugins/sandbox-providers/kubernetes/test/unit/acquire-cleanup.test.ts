import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  clients: {},
  ensureTenant: vi.fn(),
  claim: vi.fn(),
  findPod: vi.fn(),
  release: vi.fn(),
  createPolicy: vi.fn(),
  createSecret: vi.fn(),
  destroyResources: vi.fn(),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

vi.mock("../../src/tenant-orchestrator.js", () => ({
  ensureTenant: h.ensureTenant,
}));

vi.mock("../../src/sandbox-cr-orchestrator.js", () => ({
  SandboxCrTimeoutError: class SandboxCrTimeoutError extends Error {},
  sandboxCrOrchestrator: {
    claim: h.claim,
    findPod: h.findPod,
    release: h.release,
  },
}));

vi.mock("../../src/job-orchestrator.js", () => ({
  JobTimeoutError: class JobTimeoutError extends Error {},
  jobOrchestrator: {
    claim: h.claim,
    findPod: h.findPod,
    release: h.release,
  },
}));

vi.mock("../../src/secret-manager.js", () => ({
  createPerRunSecret: h.createSecret,
}));

vi.mock("../../src/scoped-network-egress.js", () => ({
  NETWORK_EGRESS_GRANT_PATH: "/run/paperclip/network-egress.json",
  appendNetworkEgressDenyHint: vi.fn((message: string) => message),
  parseScopedNetworkEgressGrant: vi.fn(() => ({
    allowFqdns: [],
    allowCidrs: [],
  })),
  createScopedNetworkEgressPolicyOrReleaseWorkload: h.createPolicy,
}));

vi.mock("../../src/lease-lifecycle.js", () => ({
  checkLeaseResumable: vi.fn(),
  destroyLeaseResources: h.destroyResources,
}));

import plugin from "../../src/plugin.js";

const acquireInput = {
  driverKey: "kubernetes",
  companyId: "company-1",
  environmentId: "environment-1",
  runId: "run-1",
  config: {
    inCluster: true,
    backend: "sandbox-cr",
    companySlug: "team-one",
    egressMode: "cilium",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.clients = {};
  h.ensureTenant.mockResolvedValue(undefined);
  h.claim.mockResolvedValue({ uid: "sandbox-uid-1" });
  h.createPolicy.mockResolvedValue("pc-run-egress");
  h.createSecret.mockResolvedValue(undefined);
  h.findPod.mockResolvedValue("pc-run-pod");
  h.release.mockResolvedValue(undefined);
  h.destroyResources.mockResolvedValue(undefined);
});

describe("onEnvironmentAcquireLease partial-failure cleanup", () => {
  it("deletes the claimed workload and per-run Secret when pod discovery fails", async () => {
    const readinessFailure = new Error("sandbox did not produce a pod");
    h.findPod.mockRejectedValue(readinessFailure);

    await expect(
      plugin.definition.onEnvironmentAcquireLease!(acquireInput),
    ).rejects.toBe(readinessFailure);

    const workloadName = h.claim.mock.calls[0]?.[2]?.metadata?.name as string;
    expect(workloadName).toMatch(/^pc-[a-z0-9]+$/);
    expect(h.createSecret).toHaveBeenCalledWith(
      h.clients,
      expect.objectContaining({
        namespace: "paperclip-team-one",
        secretName: `${workloadName}-env`,
        ownerName: workloadName,
      }),
    );
    expect(h.destroyResources).toHaveBeenCalledWith(h.clients, {
      namespace: "paperclip-team-one",
      name: workloadName,
      backend: "sandbox-cr",
      podName: null,
      secretName: `${workloadName}-env`,
    });
  });

  it("deletes the claimed workload when Secret creation fails", async () => {
    const secretFailure = new Error("secret create rejected");
    h.createSecret.mockRejectedValue(secretFailure);

    await expect(
      plugin.definition.onEnvironmentAcquireLease!(acquireInput),
    ).rejects.toBe(secretFailure);

    const workloadName = h.claim.mock.calls[0]?.[2]?.metadata?.name as string;
    expect(h.findPod).not.toHaveBeenCalled();
    expect(h.destroyResources).toHaveBeenCalledWith(h.clients, {
      namespace: "paperclip-team-one",
      name: workloadName,
      backend: "sandbox-cr",
      podName: null,
      secretName: `${workloadName}-env`,
    });
  });

  it("does not expose Secret request details when acquisition and cleanup both fail", async () => {
    h.createSecret.mockRejectedValue(new Error("request contained credential-marker"));
    h.destroyResources.mockRejectedValue(new Error("delete failed"));

    const result = plugin.definition.onEnvironmentAcquireLease!(acquireInput);
    await expect(result).rejects.toThrow(
      "Kubernetes sandbox lease acquisition failed and cleanup was incomplete.",
    );
    await expect(result).rejects.not.toThrow(/credential-marker/);
  });
});

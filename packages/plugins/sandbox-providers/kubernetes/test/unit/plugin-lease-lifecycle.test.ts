import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the kube-client module so the plugin handlers run against injected
// fake API clients instead of a real cluster. h.clients is swapped per test.
const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown> }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

import plugin from "../../src/plugin.js";
import { createKubeConfig } from "../../src/kube-client.js";

const CONFIG = { inCluster: true, backend: "sandbox-cr" };

function leaseMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace: "paperclip-acme",
    jobName: "pc-abc",
    podName: "pc-abc-pod",
    secretName: "pc-abc-env",
    phase: "Pending",
    backend: "sandbox-cr",
    ...overrides,
  };
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { code: 404 });
}

function readySandboxCr(podName: string): Record<string, unknown> {
  return {
    metadata: { uid: "uid-1" },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      podName,
    },
  };
}

beforeEach(() => {
  h.clients = {};
  vi.mocked(createKubeConfig).mockClear();
});

describe("onEnvironmentResumeLease", () => {
  it("is implemented (Daytona feature parity)", () => {
    expect(plugin.definition.onEnvironmentResumeLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentDestroyLease).toBeTypeOf("function");
  });

  it("returns a valid lease handle for a live sandbox-cr lease", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue({
          metadata: {},
          status: { phase: "Running" },
        }),
      },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBe("pc-abc");
    expect(lease.metadata).toEqual(
      expect.objectContaining({
        namespace: "paperclip-acme",
        jobName: "pc-abc",
        podName: "pc-abc-pod",
        secretName: "pc-abc-env",
        phase: "Running",
        backend: "sandbox-cr",
        resumedLease: true,
        // sandbox-cr has a pod-exec channel, so native file sync stays enabled.
        nativeFileSyncUnsupported: false,
      }),
    );
  });

  it("carries the acquisition-time reuse stamp onto the resumed lease", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue({ metadata: {}, status: { phase: "Running" } }),
      },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata({ acquiredForReuse: true }),
    });

    // Re-deriving it from the current config would let a later config flip
    // change how an already-acquired lease is released.
    expect(lease.metadata?.acquiredForReuse).toBe(true);
  });

  it("does not invent a reuse stamp for a lease that never had one", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue({ metadata: {}, status: { phase: "Running" } }),
      },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { ...CONFIG, reuseLease: true },
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.metadata?.acquiredForReuse).toBe(false);
  });

  it("flags a resumed job-backend lease as native-sync-unsupported so the server keeps the base64 fallback", async () => {
    h.clients = {
      batch: {
        readNamespacedJobStatus: vi.fn().mockResolvedValue({ status: { active: 1 } }),
      },
      core: {
        listNamespacedPod: vi.fn().mockResolvedValue({
          items: [{ metadata: { name: "pc-job-pod" }, status: { phase: "Running" } }],
        }),
      },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { inCluster: true, backend: "job" },
      providerLeaseId: "pc-job",
      leaseMetadata: leaseMetadata({ jobName: "pc-job", backend: "job", podName: "pc-job-pod" }),
    });

    expect(lease.providerLeaseId).toBe("pc-job");
    expect(lease.metadata).toEqual(
      expect.objectContaining({
        backend: "job",
        // The job backend has no exec channel; its native sync hook rejects, so
        // the lease must fall back to the byte-identical base64 transport.
        nativeFileSyncUnsupported: true,
      }),
    );
  });

  it("returns providerLeaseId null (expired) when the Sandbox CR is gone, so the caller falls back to acquireLease", async () => {
    h.clients = {
      custom: { getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: { readNamespacedPod: vi.fn() },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata?.expired).toBe(true);
    expect(lease.metadata?.reason).toMatch(/no longer exists/);
  });

  it("returns providerLeaseId null when the backing pod is gone", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: { readNamespacedPod: vi.fn().mockRejectedValue(notFound()) },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata?.expired).toBe(true);
  });
});

describe("onEnvironmentDestroyLease", () => {
  it("deletes the Sandbox CR, pod, and per-run Secret", async () => {
    const deleteCr = vi.fn().mockResolvedValue({});
    const deletePod = vi.fn().mockResolvedValue({});
    const deleteSecret = vi.fn().mockResolvedValue({});
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr },
      core: { deleteNamespacedPod: deletePod, deleteNamespacedSecret: deleteSecret },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(deleteCr).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-abc" }),
    );
    expect(deletePod).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-pod",
    });
    expect(deleteSecret).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-env",
    });
  });

  it("is idempotent: resolves cleanly when every resource is already gone (404)", async () => {
    h.clients = {
      custom: { deleteNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: {
        deleteNamespacedPod: vi.fn().mockRejectedValue(notFound()),
        deleteNamespacedSecret: vi.fn().mockRejectedValue(notFound()),
      },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await expect(
      plugin.definition.onEnvironmentDestroyLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: CONFIG,
        providerLeaseId: "pc-abc",
        leaseMetadata: leaseMetadata(),
      }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when providerLeaseId is null", async () => {
    const deleteCr = vi.fn();
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr },
      core: { deleteNamespacedPod: vi.fn(), deleteNamespacedSecret: vi.fn() },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: null,
      leaseMetadata: undefined,
    });

    expect(deleteCr).not.toHaveBeenCalled();
  });

  it("deletes the Job for job-backend leases", async () => {
    const deleteJob = vi.fn().mockResolvedValue({});
    const deleteCr = vi.fn();
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr },
      core: {
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
      },
      batch: { deleteNamespacedJob: deleteJob },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { inCluster: true, backend: "job" },
      providerLeaseId: "pc-job",
      leaseMetadata: leaseMetadata({ jobName: "pc-job", backend: "job", podName: "pc-job-pod", secretName: "pc-job-env" }),
    });

    expect(deleteJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-job" }),
    );
    expect(deleteCr).not.toHaveBeenCalled();
  });
});

describe("onEnvironmentReleaseLease", () => {
  function deleteClients() {
    return {
      custom: { deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}) },
      batch: { deleteNamespacedJob: vi.fn().mockResolvedValue({}) },
      core: {
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
      },
    };
  }

  async function release(input: {
    config: Record<string, unknown>;
    leaseMetadata: Record<string, unknown>;
    providerLeaseId?: string;
  }) {
    const clients = deleteClients();
    h.clients = clients;
    await plugin.definition.onEnvironmentReleaseLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: input.config,
      providerLeaseId: input.providerLeaseId ?? "pc-abc",
      leaseMetadata: input.leaseMetadata,
    });
    return clients;
  }

  it("tears the Sandbox CR down by default (reuseLease unset)", async () => {
    const clients = await release({
      config: CONFIG,
      leaseMetadata: leaseMetadata({ scopedNetworkPolicyName: null }),
    });

    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-abc" }),
    );
  });

  it("keeps the Sandbox CR alive when reuseLease is on and the lease carried no task-scoped egress grant", async () => {
    const clients = await release({
      config: { ...CONFIG, reuseLease: true },
      leaseMetadata: leaseMetadata({
        acquiredForReuse: true,
        scopedNetworkPolicyName: null,
        scopedNetworkEgress: { allowFqdns: [], allowCidrs: [] },
      }),
    });

    // The pod, its Sandbox CR, and the per-run Secret must all survive, or
    // there is nothing left for onEnvironmentResumeLease to resume.
    expect(clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
    expect(clients.core.deleteNamespacedPod).not.toHaveBeenCalled();
    expect(clients.core.deleteNamespacedSecret).not.toHaveBeenCalled();
    // A kept lease issues no request at all, so it never even builds a client.
    expect(createKubeConfig).not.toHaveBeenCalled();
  });

  it("destroys a lease that carried a task-scoped egress policy, even with reuseLease on", async () => {
    // A per-task network grant must never outlive its task: the scoped policy
    // selects the pod by its run-id label, which a reused pod keeps forever.
    const clients = await release({
      config: { ...CONFIG, reuseLease: true },
      leaseMetadata: leaseMetadata({
        acquiredForReuse: true,
        scopedNetworkPolicyName: "pc-abc-egress",
        scopedNetworkEgress: { allowFqdns: ["github.com"], allowCidrs: [] },
      }),
    });

    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-abc" }),
    );
  });

  it("destroys a lease whose recorded egress grant is non-empty even if the policy name is missing", async () => {
    const clients = await release({
      config: { ...CONFIG, reuseLease: true },
      leaseMetadata: leaseMetadata({
        acquiredForReuse: true,
        scopedNetworkPolicyName: null,
        scopedNetworkEgress: { allowFqdns: [], allowCidrs: ["203.0.113.0/24"] },
      }),
    });

    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalled();
  });

  it("treats an empty-string policy name as no grant and keeps the lease", async () => {
    const clients = await release({
      config: { ...CONFIG, reuseLease: true },
      leaseMetadata: leaseMetadata({ acquiredForReuse: true, scopedNetworkPolicyName: "" }),
    });

    expect(clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("destroys job-backend leases regardless of reuseLease", async () => {
    // The job backend has no resumable workload: a finished Job's pod is
    // terminal, so keeping it would strand a lease nothing can resume.
    const clients = await release({
      config: { inCluster: true, backend: "job", reuseLease: true },
      providerLeaseId: "pc-job",
      leaseMetadata: leaseMetadata({
        jobName: "pc-job",
        backend: "job",
        podName: "pc-job-pod",
        acquiredForReuse: true,
        scopedNetworkPolicyName: null,
      }),
    });

    expect(clients.batch.deleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-job" }),
    );
    expect(clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("keeps a sandbox-cr lease whose backend is only known from the config", async () => {
    const clients = await release({
      config: { ...CONFIG, reuseLease: true },
      leaseMetadata: { namespace: "paperclip-acme", acquiredForReuse: true },
    });

    expect(clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("destroys a lease acquired while reuse was off, even though reuseLease is on now", async () => {
    // paperclip-server stamped that lease `ephemeral` and will never resume it,
    // so keeping its workload would strand a pod nothing can reclaim.
    const clients = await release({
      config: { ...CONFIG, reuseLease: true },
      leaseMetadata: leaseMetadata({ acquiredForReuse: false, scopedNetworkPolicyName: null }),
    });

    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-abc" }),
    );
  });

  it("destroys a lease predating the acquiredForReuse stamp", async () => {
    const clients = await release({
      config: { ...CONFIG, reuseLease: true },
      leaseMetadata: leaseMetadata({ scopedNetworkPolicyName: null }),
    });

    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalled();
  });

  it("destroys a reuse-acquired lease once reuseLease is turned back off", async () => {
    const clients = await release({
      config: CONFIG,
      leaseMetadata: leaseMetadata({ acquiredForReuse: true, scopedNetworkPolicyName: null }),
    });

    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalled();
  });
});

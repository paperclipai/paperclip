import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the kube-client module so the plugin handlers run against injected
// fake API clients instead of a real cluster. h.clients is swapped per test.
const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown> }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

import plugin from "../../src/plugin.js";

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

describe("quota guard and pod-ready budget", () => {
  const FULL_QUOTA = {
    metadata: { name: "paperclip-quota" },
    spec: {
      hard: {
        pods: "20",
        "requests.cpu": "10",
        "requests.memory": "20Gi",
        "limits.cpu": "20",
        "limits.memory": "40Gi",
      },
    },
    status: { hard: { pods: "20" }, used: { pods: "20" } },
  };

  it("fails acquireLease immediately with an over-capacity error when the company quota is full", async () => {
    const exists = vi.fn().mockResolvedValue({});
    const create = vi.fn();
    h.clients = {
      core: {
        readNamespace: exists,
        readNamespacedServiceAccount: exists,
        readNamespacedLimitRange: exists,
        readNamespacedResourceQuota: vi.fn().mockResolvedValue(FULL_QUOTA),
      },
      rbac: { readNamespacedRole: exists, readNamespacedRoleBinding: exists },
      networking: { readNamespacedNetworkPolicy: exists },
      custom: { getNamespacedCustomObject: exists, createNamespacedCustomObject: create },
    };
    await expect(
      plugin.definition.onEnvironmentAcquireLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: { ...CONFIG, companySlug: "quota-full" },
        runId: "run-1",
      } as never),
    ).rejects.toThrow(/Over capacity/);
    // No Sandbox CR is created for a company that is already at its pod cap.
    expect(create).not.toHaveBeenCalled();
  });

  it("execute returns a clear over-capacity failure (not a hang) when the quota rejects the pod", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          status: {
            conditions: [
              { type: "Ready", status: "False", message: "pods is forbidden: exceeded quota: paperclip-quota" },
            ],
          },
        }),
      },
    };
    const result = await plugin.definition.onEnvironmentExecute!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      lease: { providerLeaseId: "pc-never-ready", metadata: leaseMetadata({ podName: null }) },
      command: "true",
      args: [],
      timeoutMs: 1_800_000,
    } as never);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Over capacity/);
  });

  it("bounds the pod-Ready wait by podReadyTimeoutSec, not the 30 minute run timeout", async () => {
    vi.useFakeTimers();
    try {
      h.clients = {
        custom: {
          getNamespacedCustomObject: vi.fn().mockResolvedValue({
            status: { conditions: [{ type: "Ready", status: "False", message: "Unschedulable" }] },
          }),
        },
        core: {
          readNamespacedResourceQuota: vi.fn().mockResolvedValue({
            status: { hard: { pods: "20" }, used: { pods: "3" } },
          }),
        },
      };
      const pending = plugin.definition.onEnvironmentExecute!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: { ...CONFIG, podReadyTimeoutSec: 5 },
        lease: { providerLeaseId: "pc-slow", metadata: leaseMetadata({ podName: null }) },
        command: "true",
        args: [],
        timeoutMs: 1_800_000,
      } as never);
      await vi.advanceTimersByTimeAsync(6_000);
      const result = await pending;
      expect(result.timedOut).toBe(true);
      expect(result.stderr).toMatch(/did not become Ready within 5s/);
      expect(result.stderr).toMatch(/Unschedulable/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call a slow pod start over capacity just because its own pod fills the quota", async () => {
    vi.useFakeTimers();
    try {
      h.clients = {
        custom: {
          getNamespacedCustomObject: vi.fn().mockResolvedValue({
            status: { conditions: [{ type: "Ready", status: "False", message: "ContainerCreating" }] },
          }),
        },
        core: {
          // The sandbox's pod exists (so it is counted in used) and is just slow.
          readNamespacedPod: vi.fn().mockResolvedValue({ metadata: { name: "pc-slow" } }),
          readNamespacedResourceQuota: vi.fn().mockResolvedValue({
            status: { hard: { pods: "20" }, used: { pods: "20" } },
          }),
        },
      };
      const pending = plugin.definition.onEnvironmentExecute!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: { ...CONFIG, podReadyTimeoutSec: 2 },
        lease: { providerLeaseId: "pc-slow", metadata: leaseMetadata({ podName: null }) },
        command: "true",
        args: [],
        timeoutMs: 1_800_000,
      } as never);
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await pending;
      expect(result.timedOut).toBe(true);
      expect(result.stderr).toMatch(/did not become Ready within 2s/);
      expect(result.stderr).not.toMatch(/Over capacity/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a Ready timeout against a full company quota as over capacity, not a run timeout", async () => {
    vi.useFakeTimers();
    try {
      h.clients = {
        custom: {
          getNamespacedCustomObject: vi.fn().mockResolvedValue({
            status: { conditions: [{ type: "Ready", status: "False", message: "starting" }] },
          }),
        },
        core: {
          readNamespacedResourceQuota: vi.fn().mockResolvedValue({
            status: { hard: { pods: "20" }, used: { pods: "20" } },
          }),
        },
      };
      const pending = plugin.definition.onEnvironmentExecute!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: { ...CONFIG, podReadyTimeoutSec: 2 },
        lease: { providerLeaseId: "pc-full", metadata: leaseMetadata({ podName: null }) },
        command: "true",
        args: [],
        timeoutMs: 1_800_000,
      } as never);
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await pending;
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/Over capacity/);
    } finally {
      vi.useRealTimers();
    }
  });
});

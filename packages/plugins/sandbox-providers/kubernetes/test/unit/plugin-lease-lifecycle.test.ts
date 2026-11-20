import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the kube-client module so the plugin handlers run against injected
// fake API clients instead of a real cluster. h.clients is swapped per test.
const h = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  scrub: vi.fn(),
  execInPod: vi.fn(),
}));

// The between-turn scrub and the exec channel talk to a real pod; mock them.
vi.mock("../../src/pod-scrub.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/pod-scrub.js")>()),
  scrubPod: h.scrub,
}));
vi.mock("../../src/pod-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/pod-exec.js")>()),
  execInPod: h.execInPod,
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

import plugin, { DEFAULT_WORKSPACE_REMOTE_DIR, leaseRemoteCwd, resolveSyncRemoteDir } from "../../src/plugin.js";
import { assertConfinedSandboxPath } from "../../src/file-sync.js";
import { isTracked, reapIdleLeases, resetReuseRegistry } from "../../src/reuse-registry.js";
import { invalidateTenantCache } from "../../src/tenant-orchestrator.js";

const CONFIG = { inCluster: true, backend: "sandbox-cr" };

// An existing tenant namespace, labelled for the company that owns it. The
// plugin refuses to use an existing namespace without a matching label.
function namespaceOwnedBy(companyId: string): Record<string, unknown> {
  return { metadata: { name: "paperclip-test", labels: { "paperclip.io/company-id": companyId } } };
}

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
  // Successful acquires are cached per namespace for 5 minutes at module level;
  // clear it so a test never skips the ownership check because of an earlier one.
  invalidateTenantCache();
  h.clients = {};
  h.scrub.mockReset();
  h.scrub.mockResolvedValue({ ok: true, detail: "" });
  h.execInPod.mockReset();
  resetReuseRegistry();
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
        readNamespace: vi.fn().mockResolvedValue(namespaceOwnedBy("acme")),
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

  const DEFAULT_HARD = { pods: "20", "requests.cpu": "5", "requests.memory": "10Gi", "limits.cpu": "40", "limits.memory": "80Gi" };

  const usedWith = (cpu: string, pods: string) => ({
    pods, "limits.cpu": cpu, "limits.memory": "40Gi", "requests.cpu": "2", "requests.memory": "5Gi",
  });

  function cpuFullClients(usedCpu: string, create = vi.fn().mockResolvedValue({ metadata: { uid: "uid-new" } })) {
    const exists = vi.fn().mockResolvedValue({});
    return {
      create,
      clients: {
        core: {
          readNamespace: vi.fn().mockResolvedValue(namespaceOwnedBy("acme")),
          readNamespacedServiceAccount: exists,
          readNamespacedLimitRange: exists,
          // Pod count has room (10 of 20) but CPU limits are at the cap.
          readNamespacedResourceQuota: vi.fn().mockResolvedValue({
            spec: { hard: DEFAULT_HARD },
            status: { hard: DEFAULT_HARD, used: usedWith(usedCpu, "10") },
          }),
          createNamespacedSecret: vi.fn().mockResolvedValue({}),
          deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
          deleteNamespacedPod: vi.fn().mockResolvedValue({}),
          readNamespacedPod: vi.fn().mockRejectedValue(notFound()),
          listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
        },
        rbac: { readNamespacedRole: exists, readNamespacedRoleBinding: exists },
        networking: { readNamespacedNetworkPolicy: exists },
        custom: {
          getNamespacedCustomObject: vi.fn().mockResolvedValue({ status: {} }),
          createNamespacedCustomObject: create,
          deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        },
      },
    };
  }

  it("fails the pod that would exceed the CPU limits quota immediately, not after the pod-ready wait", async () => {
    const { clients, create } = cpuFullClients("40");
    h.clients = clients;
    await expect(
      plugin.definition.onEnvironmentAcquireLease!({
        driverKey: "kubernetes", companyId: "acme", environmentId: "env-1",
        config: { ...CONFIG, companySlug: "cpu-full" }, runId: "run-1",
      } as never),
    ).rejects.toThrow(/Over capacity.*limits\.cpu/);
    expect(create).not.toHaveBeenCalled();
  });

  it("admits a pod when CPU limits still have room for one more default pod", async () => {
    const { clients, create } = cpuFullClients("38");
    h.clients = clients;
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes", companyId: "acme", environmentId: "env-1",
      config: { ...CONFIG, companySlug: "cpu-room" }, runId: "run-1",
    } as never);
    expect(lease.providerLeaseId).toMatch(/^pc-/);
    expect(create).toHaveBeenCalled();
  });

  it("evicts the longest-idle conversation pod when CPU limits (not the pod count) would be exceeded", async () => {
    const { clients, create } = cpuFullClients("40");
    // After the idle pod is deleted its CPU frees up.
    (clients.core.readNamespacedResourceQuota as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ spec: { hard: DEFAULT_HARD }, status: { hard: DEFAULT_HARD, used: usedWith("40", "10") } })
      .mockResolvedValueOnce({ spec: { hard: DEFAULT_HARD }, status: { hard: DEFAULT_HARD, used: usedWith("40", "10") } })
      .mockResolvedValue({ spec: { hard: DEFAULT_HARD }, status: { hard: DEFAULT_HARD, used: usedWith("38", "9") } });
    h.clients = clients;
    const { trackReusableLease } = await import("../../src/reuse-registry.js");
    trackReusableLease(
      {
        namespace: "paperclip-cpu-evict", name: "pc-idle-chat", secretName: "pc-idle-chat-env", podName: null,
        backend: "sandbox-cr", clients: clients as never, idleTtlMs: 300_000,
      },
      Date.now() - 120_000,
    );
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes", companyId: "acme", environmentId: "env-1",
      config: { ...CONFIG, companySlug: "cpu-evict" }, runId: "run-new",
    } as never);
    expect(lease.providerLeaseId).toMatch(/^pc-/);
    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({ name: "pc-idle-chat" }));
    expect(create).toHaveBeenCalled();
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

describe("lease remote working dir (TECH-8174: runs that never realize a workspace)", () => {
  // Any kube call resolves to a benign empty object, so acquire runs end to end.
  function permissiveClients(): Record<string, unknown> {
    const group = (overrides: Record<string, unknown> = {}) =>
      new Proxy({}, {
        get: (_target, prop) => {
          // Not thenable: an awaited client group must not look like a promise.
          if (prop === "then" || typeof prop !== "string") return undefined;
          if (prop in overrides) return overrides[prop];
          return vi.fn().mockResolvedValue({ metadata: { uid: "uid-1", name: "x" }, items: [], status: {} });
        },
      });
    // The tenant namespace already exists and belongs to this company.
    const core = group({ readNamespace: vi.fn().mockResolvedValue(namespaceOwnedBy("acme")) });
    return { core, batch: group(), custom: group(), rbac: group(), networking: group() };
  }

  it("records the pod's /workspace mount as remoteCwd at acquire, so sync works before any realizeWorkspace", async () => {
    h.clients = permissiveClients();
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { ...CONFIG, companySlug: "acme-remote-cwd" },
      runId: "run-1",
    } as never);
    expect(lease.metadata).toEqual(expect.objectContaining({ remoteCwd: DEFAULT_WORKSPACE_REMOTE_DIR }));
    // The native sync root resolves from that lease alone (no realized workspace).
    expect(resolveSyncRemoteDir(lease as never)).toBe("/workspace");
  });

  it("defaults remoteCwd on resume for a lease that never realized a workspace", async () => {
    h.clients = {
      custom: { getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")) },
      core: { readNamespacedPod: vi.fn().mockResolvedValue({ metadata: {}, status: { phase: "Running" } }) },
    };
    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });
    expect(lease.metadata).toEqual(expect.objectContaining({ remoteCwd: "/workspace" }));
    expect(resolveSyncRemoteDir(lease as never)).toBe("/workspace");
  });

  it("keeps an already-recorded remote dir across resume", async () => {
    h.clients = {
      custom: { getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")) },
      core: { readNamespacedPod: vi.fn().mockResolvedValue({ metadata: {}, status: { phase: "Running" } }) },
    };
    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata({ remoteCwd: "/workspace/project" }),
    });
    expect(lease.metadata).toEqual(expect.objectContaining({ remoteCwd: "/workspace/project" }));
  });

  it("still refuses to sync a lease with no remote dir at all, and confines runtime assets to the root", () => {
    expect(() => resolveSyncRemoteDir({ providerLeaseId: "x", metadata: {} } as never)).toThrow(/workspace remote dir/);
    // A recorded root that is not a confinable dir is refused at sync time too.
    for (const unsafe of ["/", "relative", "/workspace/../etc", "//workspace"]) {
      expect(() => resolveSyncRemoteDir({ providerLeaseId: "x", metadata: { remoteCwd: unsafe } } as never)).toThrow(
        /normalized absolute workspace remote dir/,
      );
    }
    expect(leaseRemoteCwd("  ")).toBe("/workspace");
    // Only a normalized absolute dir below / can become the confinement root.
    for (const unsafe of ["/", "", "relative/dir", "/workspace/../etc", "/workspace/./x", "/workspace/", "//workspace", 42]) {
      expect(leaseRemoteCwd(unsafe)).toBe("/workspace");
    }
    expect(leaseRemoteCwd(" /workspace/project ")).toBe("/workspace/project");
    // Runtime assets staged under the lease's working dir are inside the confinement root...
    expect(() =>
      assertConfinedSandboxPath("/workspace", "/workspace/.paperclip-runtime/hermes/hermesHome", "target"),
    ).not.toThrow();
    // ...and anything outside it (e.g. the server's old /tmp default) is still rejected.
    expect(() =>
      assertConfinedSandboxPath("/workspace", "/tmp/.paperclip-runtime/hermes/hermesHome", "target"),
    ).toThrow();
    expect(() => assertConfinedSandboxPath("/workspace", "/workspace/../etc/passwd", "target")).toThrow();
  });
});


describe("reusable conversation pods", () => {
  const RESUME_CLIENTS = () => ({
    custom: {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    },
    core: {
      readNamespacedPod: vi.fn().mockResolvedValue({ metadata: {}, status: { phase: "Running" } }),
      deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
      deleteNamespacedPod: vi.fn().mockResolvedValue({}),
    },
  });

  it("scrubs the pod on resume, before handing it to the next turn, and tracks it for the idle TTL", async () => {
    h.clients = RESUME_CLIENTS();
    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata({ remoteCwd: "/workspace", reusableSandboxLease: { version: 1, adapterType: "hermes_local" } }),
    });
    expect(lease.providerLeaseId).toBe("pc-abc");
    expect(h.scrub).toHaveBeenCalledWith(expect.anything(), "paperclip-acme", "pc-abc-pod", "/workspace");
    expect(isTracked("paperclip-acme", "pc-abc")).toBe(true);
  });

  it("does not reuse a pod that cannot be scrubbed: destroys it and reports the lease expired", async () => {
    const clients = RESUME_CLIENTS();
    h.clients = clients;
    h.scrub.mockResolvedValue({ ok: false, detail: "exec failed" });
    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata({ reusableSandboxLease: { version: 1, adapterType: "hermes_local" } }),
    });
    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata?.reason).toMatch(/scrub failed: exec failed/);
    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalled();
    expect(isTracked("paperclip-acme", "pc-abc")).toBe(false);
  });

  it("leaves paperclip_runner's warm sandboxes and one-shot leases alone: no scrub, no tracking", async () => {
    h.clients = RESUME_CLIENTS();
    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata({ reusableSandboxLease: { version: 1, adapterType: "paperclip_runner" } }),
    });
    expect(lease.providerLeaseId).toBe("pc-abc");
    expect(h.scrub).not.toHaveBeenCalled();
    expect(isTracked("paperclip-acme", "pc-abc")).toBe(false);

    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await plugin.definition.onEnvironmentExecute!({
      driverKey: "kubernetes", companyId: "acme", environmentId: "env-1", config: CONFIG, command: "true", args: [],
      lease: {
        providerLeaseId: "pc-runner",
        metadata: leaseMetadata({ jobName: "pc-runner", reusableSandboxLease: { version: 1, adapterType: "paperclip_runner" } }),
      },
    } as never);
    expect(isTracked("paperclip-acme", "pc-runner")).toBe(false);
  });

  it("also scrubs and tracks a kept-running pod of another legacy adapter, so a retained pod can never leak", async () => {
    h.clients = RESUME_CLIENTS();
    await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes", companyId: "acme", environmentId: "env-1", config: CONFIG, providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata({ reusableSandboxLease: { version: 1, adapterType: "claude_local" } }),
    });
    expect(h.scrub).toHaveBeenCalledWith(expect.anything(), "paperclip-acme", "pc-abc-pod", "/workspace");
    expect(isTracked("paperclip-acme", "pc-abc")).toBe(true);
  });

  it("returns the lease as expired even when destroying an unscrubbable pod fails", async () => {
    const clients = RESUME_CLIENTS();
    clients.custom.deleteNamespacedCustomObject.mockRejectedValue(new Error("apiserver down"));
    h.clients = clients;
    h.scrub.mockResolvedValue({ ok: false, detail: "exec failed" });
    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes", companyId: "acme", environmentId: "env-1", config: CONFIG, providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata({ reusableSandboxLease: { version: 1, adapterType: "hermes_local" } }),
    });
    expect(lease.providerLeaseId).toBeNull();
    // The failed delete leaves the pod tracked so the reaper retries it.
    expect(isTracked("paperclip-acme", "pc-abc")).toBe(true);
  });

  it("keeps the host-owned reuse flags when a config is validated and normalized on save", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, reuseLease: true, reuseLeaseScope: "conversations", conversationPodReuse: false, runnerIdleTimeoutMs: 120_000 },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toMatchObject({
      reuseLease: true,
      reuseLeaseScope: "conversations",
      conversationPodReuse: false,
      runnerIdleTimeoutMs: 120_000,
    });
  });

  it("does not persist an unset resourceQuota when normalizing a saved config", async () => {
    const unset = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "kubernetes", config: { inCluster: true } });
    expect(unset.normalizedConfig).not.toHaveProperty("resourceQuota");
    const set = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes", config: { inCluster: true, resourceQuota: { pods: "30" } },
    });
    expect(set.normalizedConfig?.resourceQuota).toEqual({ pods: "30" });
  });

  it("tracks idle time only for leases the server marked reusable, and the reaper deletes them after the TTL", async () => {
    const clients = RESUME_CLIENTS();
    h.clients = clients;
    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const base = {
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { ...CONFIG, runnerIdleTimeoutMs: 60_000 },
      command: "true",
      args: [],
    };
    await plugin.definition.onEnvironmentExecute!({
      ...base,
      lease: { providerLeaseId: "pc-oneshot", metadata: leaseMetadata({ jobName: "pc-oneshot" }) },
    } as never);
    expect(isTracked("paperclip-acme", "pc-oneshot")).toBe(false);

    await plugin.definition.onEnvironmentExecute!({
      ...base,
      lease: {
        providerLeaseId: "pc-chat",
        metadata: leaseMetadata({ jobName: "pc-chat", reusableSandboxLease: { version: 1, adapterType: "hermes_local" } }),
      },
    } as never);
    expect(isTracked("paperclip-acme", "pc-chat")).toBe(true);

    expect(await reapIdleLeases(Date.now() + 30_000)).toEqual([]);
    expect(await reapIdleLeases(Date.now() + 61_000)).toEqual(["pc-chat"]);
    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pc-chat" }),
    );
  });

  it("evicts the longest-idle conversation pod instead of failing a new run when the company is at its pod quota", async () => {
    const exists = vi.fn().mockResolvedValue({});
    const create = vi.fn().mockResolvedValue({ metadata: { uid: "uid-new" } });
    const clients = {
      core: {
        readNamespace: vi.fn().mockResolvedValue(namespaceOwnedBy("evict-co")),
        readNamespacedServiceAccount: exists,
        readNamespacedLimitRange: exists,
        // Full for the first checks (the existing pod), free once the evicted pod is gone.
        readNamespacedResourceQuota: vi
          .fn()
          .mockResolvedValue({
            spec: { hard: { pods: "1", "requests.cpu": "10", "requests.memory": "20Gi", "limits.cpu": "20", "limits.memory": "40Gi" } },
            status: { hard: { pods: "1" }, used: { pods: "0" } },
          })
          .mockResolvedValueOnce({
            spec: { hard: { pods: "1", "requests.cpu": "10", "requests.memory": "20Gi", "limits.cpu": "20", "limits.memory": "40Gi" } },
            status: { hard: { pods: "1" }, used: { pods: "1" } },
          })
          .mockResolvedValueOnce({
            spec: { hard: { pods: "1", "requests.cpu": "10", "requests.memory": "20Gi", "limits.cpu": "20", "limits.memory": "40Gi" } },
            status: { hard: { pods: "1" }, used: { pods: "1" } },
          }),
        createNamespacedSecret: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
        readNamespacedPod: vi.fn().mockRejectedValue(notFound()),
        listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
      },
      rbac: { readNamespacedRole: exists, readNamespacedRoleBinding: exists },
      networking: { readNamespacedNetworkPolicy: exists },
      custom: {
        getNamespacedCustomObject: vi.fn().mockImplementation(async (a: { plural: string }) =>
          a.plural === "sandboxes" ? { status: {} } : {},
        ),
        createNamespacedCustomObject: create,
        deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      },
    };
    h.clients = clients;
    // An idle conversation pod holding the quota (idle well past the 30 s eviction floor).
    const { trackReusableLease } = await import("../../src/reuse-registry.js");
    trackReusableLease(
      {
        namespace: "paperclip-evict-co",
        name: "pc-idle-chat",
        secretName: "pc-idle-chat-env",
        podName: null,
        backend: "sandbox-cr",
        clients: clients as never,
        idleTtlMs: 300_000,
      },
      Date.now() - 120_000,
    );
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes",
      companyId: "evict-co",
      environmentId: "env-1",
      config: { ...CONFIG, companySlug: "evict-co", resourceQuota: { pods: "1" } },
      runId: "run-new",
    } as never);
    expect(lease.providerLeaseId).toMatch(/^pc-/);
    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pc-idle-chat" }),
    );
    expect(create).toHaveBeenCalled();
  });
});

// A user interrupt cancels the run and releases its lease. The server can only
// treat the interrupted run as stopped, and start the user's queued message, if
// the plugin proves the agent process ended with a termination receipt.
describe("termination receipt on release and destroy (user interrupt of a sandbox run)", () => {
  const PARAMS = {
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    config: CONFIG,
    providerLeaseId: "pc-abc",
    leaseMetadata: leaseMetadata(),
  };

  function gone(over: Record<string, unknown> = {}) {
    return {
      custom: {
        deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()),
      },
      core: {
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
        readNamespacedPod: vi.fn().mockRejectedValue(notFound()),
      },
      batch: { deleteNamespacedJob: vi.fn() },
      ...over,
    };
  }

  it("release returns a destroyed receipt once the Sandbox CR and pod are gone", async () => {
    h.clients = gone();
    await expect(plugin.definition.onEnvironmentReleaseLease!(PARAMS)).resolves.toEqual({
      providerLeaseId: "pc-abc",
      state: "destroyed",
    });
  });

  it("release waits for a still-terminating pod before granting the receipt", async () => {
    const readPod = vi
      .fn()
      .mockResolvedValueOnce({ metadata: { deletionTimestamp: "now" } })
      .mockRejectedValue(notFound());
    h.clients = gone({
      core: {
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
        readNamespacedPod: readPod,
      },
    });
    await expect(plugin.definition.onEnvironmentReleaseLease!(PARAMS)).resolves.toEqual({
      providerLeaseId: "pc-abc",
      state: "destroyed",
    });
    // First poll: the pod named after the Sandbox is still terminating. Second
    // poll: it and the recorded pod name are both 404.
    expect(readPod).toHaveBeenCalledTimes(3);
    expect(readPod).toHaveBeenCalledWith({ namespace: "paperclip-acme", name: "pc-abc" });
    expect(readPod).toHaveBeenCalledWith({ namespace: "paperclip-acme", name: "pc-abc-pod" });
  });

  it("release grants no receipt (and does not throw) when termination cannot be confirmed", async () => {
    h.clients = gone({
      custom: {
        deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        getNamespacedCustomObject: vi.fn().mockRejectedValue(Object.assign(new Error("boom"), { code: 500 })),
      },
    });
    await expect(plugin.definition.onEnvironmentReleaseLease!(PARAMS)).resolves.toBeUndefined();
  });

  it("destroy returns a destroyed receipt once everything is gone", async () => {
    h.clients = gone();
    await expect(plugin.definition.onEnvironmentDestroyLease!(PARAMS)).resolves.toEqual({
      providerLeaseId: "pc-abc",
      state: "destroyed",
    });
  });

  it("the job backend grants no receipt (unchanged behaviour)", async () => {
    h.clients = gone({
      batch: { deleteNamespacedJob: vi.fn().mockResolvedValue({}) },
    });
    await expect(
      plugin.definition.onEnvironmentReleaseLease!({
        ...PARAMS,
        config: { inCluster: true, backend: "job" },
        leaseMetadata: leaseMetadata({ backend: "job" }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("tenant namespace ownership at the plugin boundary", () => {
  const ACQUIRE = {
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    config: { ...CONFIG, companySlug: "ownership-check" },
    runId: "run-1",
  };

  function clientsWith(core: Record<string, unknown>) {
    const create = vi.fn();
    const exists = vi.fn().mockResolvedValue({});
    h.clients = {
      core: {
        readNamespacedServiceAccount: exists,
        createNamespacedSecret: vi.fn().mockResolvedValue({}),
        ...core,
      },
      rbac: { readNamespacedRole: exists, readNamespacedRoleBinding: exists },
      networking: { readNamespacedNetworkPolicy: exists },
      custom: { getNamespacedCustomObject: exists, createNamespacedCustomObject: create },
    };
    return { create };
  }

  it("refuses to acquire in a namespace labelled for another company and creates no Sandbox or Secret", async () => {
    const createSecret = vi.fn();
    const { create } = clientsWith({
      readNamespace: vi.fn().mockResolvedValue(namespaceOwnedBy("some-other-company")),
      createNamespacedSecret: createSecret,
    });
    await expect(plugin.definition.onEnvironmentAcquireLease!(ACQUIRE as never)).rejects.toThrow(/labelled for a different company/);
    expect(create).not.toHaveBeenCalled();
    expect(createSecret).not.toHaveBeenCalled();
  });

  it("tells the operator an org is not enabled when its namespace is missing and cannot be created", async () => {
    const { create } = clientsWith({
      readNamespace: vi.fn().mockRejectedValue(notFound()),
      createNamespace: vi.fn().mockRejectedValue(Object.assign(new Error("forbidden"), { code: 403 })),
    });
    await expect(plugin.definition.onEnvironmentAcquireLease!(ACQUIRE as never)).rejects.toThrow(
      /not enabled for Kubernetes sandboxes/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("destroys a lease's resources even when the namespace's label no longer matches, without reading the namespace", async () => {
    // A pod the plugin created must always be cleanable, whatever happened to the label since.
    const readNamespace = vi.fn().mockResolvedValue(namespaceOwnedBy("some-other-company"));
    const deleteCr = vi.fn().mockResolvedValue({});
    const deletePod = vi.fn().mockResolvedValue({});
    const deleteSecret = vi.fn().mockResolvedValue({});
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr, getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: {
        readNamespace,
        deleteNamespacedPod: deletePod,
        deleteNamespacedSecret: deleteSecret,
        readNamespacedPod: vi.fn().mockRejectedValue(notFound()),
      },
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
    expect(deleteCr).toHaveBeenCalled();
    expect(deletePod).toHaveBeenCalledWith({ namespace: "paperclip-acme", name: "pc-abc-pod" });
    expect(deleteSecret).toHaveBeenCalledWith({ namespace: "paperclip-acme", name: "pc-abc-env" });
    expect(readNamespace).not.toHaveBeenCalled();
  });
});

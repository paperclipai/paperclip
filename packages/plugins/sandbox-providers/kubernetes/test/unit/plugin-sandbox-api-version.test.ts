import { describe, it, expect, vi, beforeEach } from "vitest";

// Acquisition is driven against injected fake API clients. Tenant bootstrap and
// per-run Secret creation are stubbed: this file is about ONE thing, which
// Sandbox API version every object acquisition emits is stamped with.
const h = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  ensureTenant: vi.fn(),
  createPerRunSecret: vi.fn(),
}));

vi.mock("../../src/kube-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/kube-client.js")>()),
  createKubeConfig: vi.fn(() => ({
    getCurrentCluster: () => ({ server: "https://test-cluster.example" }),
  })),
  makeKubeClients: vi.fn(() => h.clients),
}));

vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: h.ensureTenant }));
vi.mock("../../src/secret-manager.js", () => ({ createPerRunSecret: h.createPerRunSecret }));

import plugin from "../../src/plugin.js";
import { __clearSandboxApiVersionCache } from "../../src/sandbox-api-version.js";

function discovery(versions: string[]) {
  return {
    getAPIVersions: vi.fn().mockResolvedValue({
      groups: [
        { name: "agents.x-k8s.io", versions: versions.map((version) => ({ version })) },
      ],
    }),
  };
}

function clients(versions: string[]) {
  return {
    apis: discovery(versions),
    custom: {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({ metadata: { uid: "sandbox-uid" } }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { uid: "sandbox-uid" },
        status: { conditions: [{ type: "Ready", status: "True" }], podName: "pc-pod" },
      }),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    },
    core: { readNamespacedPod: vi.fn(), listNamespacedPod: vi.fn() },
    networking: { createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}) },
  };
}

async function acquire(config: Record<string, unknown> = { inCluster: true }) {
  return await plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    runId: "run-1",
    config,
    // A task-scoped grant makes the provider create the run-scoped egress
    // policy, whose ownerReference has to name the Sandbox by the same version.
    executionWorkspaceSettings: { networkEgress: { allowCidrs: ["10.9.0.0/16"] } },
  } as never);
}

beforeEach(() => {
  __clearSandboxApiVersionCache();
  h.ensureTenant.mockReset().mockResolvedValue(undefined);
  h.createPerRunSecret.mockReset().mockResolvedValue(undefined);
});

describe("onEnvironmentAcquireLease Sandbox API version", () => {
  it("creates the Sandbox through v1beta1 on a graduated controller and records it on the lease", async () => {
    const c = clients(["v1alpha1", "v1beta1"]);
    h.clients = c;

    const lease = await acquire();

    const created = c.custom.createNamespacedCustomObject.mock.calls[0]![0] as {
      version: string;
      body: { apiVersion: string };
    };
    expect(created.version).toBe("v1beta1");
    expect(created.body.apiVersion).toBe("agents.x-k8s.io/v1beta1");
    expect(lease.metadata?.sandboxApiVersion).toBe("v1beta1");
  });

  it("falls back to v1alpha1 on a controller that predates the graduation", async () => {
    const c = clients(["v1alpha1"]);
    h.clients = c;

    const lease = await acquire();

    const created = c.custom.createNamespacedCustomObject.mock.calls[0]![0] as {
      version: string;
      body: { apiVersion: string };
    };
    expect(created.version).toBe("v1alpha1");
    expect(created.body.apiVersion).toBe("agents.x-k8s.io/v1alpha1");
    expect(lease.metadata?.sandboxApiVersion).toBe("v1alpha1");
  });

  it("stamps the resolved version into both ownerReferences, so cascade delete still matches", async () => {
    const c = clients(["v1beta1"]);
    h.clients = c;

    await acquire();

    const policy = c.networking.createNamespacedNetworkPolicy.mock.calls[0]![0] as {
      body: { metadata: { ownerReferences: { apiVersion: string; kind: string }[] } };
    };
    expect(policy.body.metadata.ownerReferences[0]).toMatchObject({
      apiVersion: "agents.x-k8s.io/v1beta1",
      kind: "Sandbox",
    });
    expect(h.createPerRunSecret.mock.calls[0]![1]).toMatchObject({
      ownerApiVersion: "agents.x-k8s.io/v1beta1",
      ownerKind: "Sandbox",
    });
  });

  it("refuses the lease before provisioning anything when the controller is not installed", async () => {
    const c = clients([]);
    c.apis.getAPIVersions.mockResolvedValue({ groups: [{ name: "batch", versions: [{ version: "v1" }] }] });
    h.clients = c;

    await expect(acquire()).rejects.toThrow(/agent-sandbox/);
    // Failing this late would leave a tenant namespace, RBAC, quotas and network
    // policies behind for a cluster that can never run a sandbox lease.
    expect(h.ensureTenant).not.toHaveBeenCalled();
    expect(c.custom.createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("does not require the Sandbox CRD at all for the job backend", async () => {
    const c = clients([]);
    c.apis.getAPIVersions.mockResolvedValue({ groups: [] });
    h.clients = {
      ...c,
      batch: {
        createNamespacedJob: vi.fn().mockResolvedValue({ metadata: { uid: "job-uid" } }),
        readNamespacedJobStatus: vi.fn().mockResolvedValue({ status: {} }),
      },
      core: { ...c.core, listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }) },
    };

    const lease = await acquire({ inCluster: true, backend: "job" });

    expect(c.apis.getAPIVersions).not.toHaveBeenCalled();
    expect(lease.metadata?.sandboxApiVersion).toBeUndefined();
    expect(lease.metadata?.backend).toBe("job");
  });
});

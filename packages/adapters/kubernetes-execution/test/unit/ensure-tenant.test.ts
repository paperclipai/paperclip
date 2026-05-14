import { describe, it, expect, vi } from "vitest";
import { ensureTenantNamespace, type EnsureTenantInput } from "../../src/orchestrator/ensure-tenant.js";
import type { KubernetesApiClient } from "../../src/types.js";

function makeFakeClient(): KubernetesApiClient {
  const notFound = () => { const e: Error & { response?: { statusCode: number } } = new Error("not found"); e.response = { statusCode: 404 }; throw e; };
  return {
    core: {
      readNamespace: vi.fn(notFound),
      createNamespace: vi.fn(async () => ({})),
      patchNamespace: vi.fn(async () => ({})),
      readNamespacedServiceAccount: vi.fn(notFound),
      createNamespacedServiceAccount: vi.fn(async () => ({})),
      patchNamespacedServiceAccount: vi.fn(async () => ({})),
      readNamespacedResourceQuota: vi.fn(notFound),
      createNamespacedResourceQuota: vi.fn(async () => ({})),
      patchNamespacedResourceQuota: vi.fn(async () => ({})),
      readNamespacedLimitRange: vi.fn(notFound),
      createNamespacedLimitRange: vi.fn(async () => ({})),
      patchNamespacedLimitRange: vi.fn(async () => ({})),
      readNamespacedSecret: vi.fn(notFound),
      createNamespacedSecret: vi.fn(async () => ({})),
      patchNamespacedSecret: vi.fn(async () => ({})),
    } as unknown as KubernetesApiClient["core"],
    rbac: {
      readNamespacedRoleBinding: vi.fn(notFound),
      createNamespacedRoleBinding: vi.fn(async () => ({})),
      deleteNamespacedRoleBinding: vi.fn(async () => ({})),
    } as unknown as KubernetesApiClient["rbac"],
    networking: {
      readNamespacedNetworkPolicy: vi.fn(notFound),
      createNamespacedNetworkPolicy: vi.fn(async () => ({})),
      patchNamespacedNetworkPolicy: vi.fn(async () => ({})),
    } as unknown as KubernetesApiClient["networking"],
    apiext: {} as unknown as KubernetesApiClient["apiext"],
    batch: {} as unknown as KubernetesApiClient["batch"],
    describe: () => "fake",
    request: vi.fn(async () => ({})),
  } as unknown as KubernetesApiClient;
}

const baseInput: Omit<EnsureTenantInput, "connection"> = {
  company: { id: "11111111-1111-1111-1111-111111111111", slug: "acme-corp" },
  tenantPolicy: null,
  driverServiceAccount: { name: "paperclip-driver", namespace: "paperclip-system" },
  controlPlane: {
    topology: "in-cluster",
    namespaceLabels: { "paperclip.ai/role": "control-plane" },
    podLabels: { "app.kubernetes.io/name": "paperclip-server" },
  },
  adapterAllowFqdns: ["*.anthropic.com"],
  imagePullDockerConfigJson: null,
};

const baseConnection = {
  id: "c-1", label: "test", kind: "kubeconfig" as const, kubeconfigYaml: "<unused>",
  defaultNamespacePrefix: "paperclip-",
  allowAgentImageOverride: false,
  capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] as ("amd64" | "arm64")[] },
};

describe("ensureTenantNamespace", () => {
  it("derives the namespace name and creates objects in the correct order", async () => {
    const client = makeFakeClient();
    const result = await ensureTenantNamespace(client, { ...baseInput, connection: baseConnection });
    expect(result.namespace).toBe("paperclip-acme-corp");
    expect(result.ciliumApplied).toBe(false);
    expect(client.core.createNamespace).toHaveBeenCalledTimes(1);
    expect(client.core.createNamespacedServiceAccount).toHaveBeenCalledTimes(1);
    expect(client.core.createNamespacedResourceQuota).toHaveBeenCalledTimes(1);
    expect(client.core.createNamespacedLimitRange).toHaveBeenCalledTimes(1);
    // 2 default-deny (ingress + egress) + 1 agent egress
    expect(client.networking.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(3);
    // No Cilium without capability
    expect(client.request).not.toHaveBeenCalled();
    // No image pull secret without dockerConfigJson
    expect(client.core.createNamespacedSecret).not.toHaveBeenCalled();
  });

  it("creates namespace BEFORE any namespaced object", async () => {
    const client = makeFakeClient();
    const callOrder: string[] = [];
    (client.core.createNamespace as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push("ns"); return {}; });
    (client.core.createNamespacedServiceAccount as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push("sa"); return {}; });
    (client.networking.createNamespacedNetworkPolicy as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push("np"); return {}; });
    await ensureTenantNamespace(client, { ...baseInput, connection: baseConnection });
    expect(callOrder[0]).toBe("ns");
  });

  it("retries with a hash suffix when the naive namespace belongs to another company", async () => {
    const client = makeFakeClient();
    (client.core.readNamespace as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => ({
        body: {
          metadata: {
            name: "paperclip-acme-corp",
            labels: {
              "paperclip.ai/managed-by": "paperclip",
              "paperclip.ai/company-id": "22222222-2222-2222-2222-222222222222",
            },
          },
        },
      }))
      .mockImplementationOnce(() => {
        const e: Error & { response?: { statusCode: number } } = new Error("not found");
        e.response = { statusCode: 404 };
        throw e;
      });

    const result = await ensureTenantNamespace(client, { ...baseInput, connection: baseConnection });

    expect(result.namespace).toMatch(/^paperclip-acme-corp-[0-9a-z]{8}$/);
    expect(client.core.readNamespace).toHaveBeenNthCalledWith(1, "paperclip-acme-corp");
    expect(client.core.readNamespace).toHaveBeenNthCalledWith(2, result.namespace);
    expect(client.core.createNamespace).toHaveBeenCalledTimes(1);
  });

  it("emits a Cilium policy when cluster supports it", async () => {
    const client = makeFakeClient();
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) =>
      method === "GET" ? Promise.reject({ statusCode: 404, message: "404" }) : ({}),
    );
    const conn = { ...baseConnection, capabilities: { ...baseConnection.capabilities, cilium: true } };
    const result = await ensureTenantNamespace(client, { ...baseInput, connection: conn });
    expect(result.ciliumApplied).toBe(true);
    expect(client.request).toHaveBeenCalled();
  });

  it("creates an image pull secret when dockerConfigJson is supplied", async () => {
    const client = makeFakeClient();
    await ensureTenantNamespace(client, {
      ...baseInput, connection: baseConnection,
      imagePullDockerConfigJson: '{"auths":{"ghcr.io":{}}}',
    });
    expect(client.core.createNamespacedSecret).toHaveBeenCalledTimes(1);
  });

  it("emits cross-cluster NetworkPolicy without the in-cluster control-plane rule", async () => {
    const client = makeFakeClient();
    const callBodies: unknown[] = [];
    (client.networking.createNamespacedNetworkPolicy as ReturnType<typeof vi.fn>).mockImplementation(async (_ns: string, body: unknown) => {
      callBodies.push(body); return {};
    });
    await ensureTenantNamespace(client, {
      ...baseInput, connection: baseConnection,
      controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
    });
    const agentEgress = callBodies.find((b) => (b as { metadata?: { name?: string } }).metadata?.name === "paperclip-agent-egress");
    expect(agentEgress).toBeDefined();
    const egressRules = (agentEgress as { spec: { egress: Array<{ to?: Array<{ namespaceSelector?: { matchLabels?: Record<string, string> } }> }> } }).spec.egress;
    const hasControlPlaneRule = egressRules.some((r) =>
      r.to?.some((t) => t.namespaceSelector?.matchLabels?.["paperclip.ai/role"] === "control-plane"),
    );
    expect(hasControlPlaneRule).toBe(false);
  });
});

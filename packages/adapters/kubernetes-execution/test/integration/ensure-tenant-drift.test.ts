import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { createKubernetesApiClient, ensureTenantNamespace, type ResolvedClusterConnection } from "../../src/index.js";

let cluster: KindCluster;
beforeAll(() => { cluster = spinUpKind(); }, 240_000);
afterAll(() => cluster?.cleanup());

describe("ensureTenantNamespace drift correction", () => {
  it("recreates a NetworkPolicy that was deleted out-of-band", async () => {
    const connection: ResolvedClusterConnection = {
      id: "c-1", label: "kind", kind: "kubeconfig", kubeconfigYaml: cluster.kubeconfigYaml,
      defaultNamespacePrefix: "paperclip-",
      allowAgentImageOverride: false,
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
    };
    const client = createKubernetesApiClient(connection);
    const input = {
      connection,
      company: { id: "11111111-1111-1111-1111-111111111113", slug: "drift-co" },
      tenantPolicy: null,
      driverServiceAccount: { name: "default", namespace: "default" },
      controlPlane: { topology: "cross-cluster" as const, namespaceLabels: {}, podLabels: {} },
      adapterAllowFqdns: [],
      imagePullDockerConfigJson: null,
    };
    const { namespace } = await ensureTenantNamespace(client, input);
    await client.networking.deleteNamespacedNetworkPolicy("default-deny-egress", namespace);
    await ensureTenantNamespace(client, input);
    const policies = await client.networking.listNamespacedNetworkPolicy(namespace);
    expect(policies.body.items.find(p => p.metadata?.name === "default-deny-egress")).toBeDefined();
  }, 180_000);
});

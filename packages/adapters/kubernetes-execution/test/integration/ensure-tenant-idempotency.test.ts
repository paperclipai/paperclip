import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { createKubernetesApiClient, ensureTenantNamespace, type ResolvedClusterConnection } from "../../src/index.js";

let cluster: KindCluster;

describe.skipIf(!process.env["K8S_INTEGRATION"])("ensureTenantNamespace idempotency", () => {
  beforeAll(() => { cluster = spinUpKind(); }, 240_000);
  afterAll(() => cluster?.cleanup());

  it("a second call is a no-op-equivalent — exactly the same set of objects exist", async () => {
    const connection: ResolvedClusterConnection = {
      id: "c-1", label: "kind", kind: "kubeconfig", kubeconfigYaml: cluster.kubeconfigYaml,
      defaultNamespacePrefix: "paperclip-",
      allowAgentImageOverride: false,
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
    };
    const client = createKubernetesApiClient(connection);
    const input = {
      connection,
      company: { id: "11111111-1111-1111-1111-111111111112", slug: "idempotent-co" },
      tenantPolicy: null,
      driverServiceAccount: { name: "default", namespace: "default" },
      controlPlane: { topology: "cross-cluster" as const, namespaceLabels: {}, podLabels: {} },
      adapterAllowFqdns: [],
      imagePullDockerConfigJson: null,
    };
    const r1 = await ensureTenantNamespace(client, input);
    const r2 = await ensureTenantNamespace(client, input);
    expect(r1.namespace).toBe(r2.namespace);
    const policies = await client.networking.listNamespacedNetworkPolicy(r1.namespace);
    expect(policies.body.items.length).toBe(3);
  }, 180_000);
});

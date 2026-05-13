import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { createKubernetesApiClient, ensureTenantNamespace, type ResolvedClusterConnection } from "../../src/index.js";

let cluster: KindCluster;
let connection: ResolvedClusterConnection;

describe.skipIf(!process.env["K8S_INTEGRATION"])("ensureTenantNamespace against kind", () => {
  beforeAll(() => {
    cluster = spinUpKind();
    connection = {
      id: "c-1", label: "kind", kind: "kubeconfig", kubeconfigYaml: cluster.kubeconfigYaml,
      defaultNamespacePrefix: "paperclip-",
      allowAgentImageOverride: false,
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
    };
  }, 240_000);
  afterAll(() => cluster?.cleanup());

  it("provisions a fully isolated tenant namespace", async () => {
    const client = createKubernetesApiClient(connection);
    const result = await ensureTenantNamespace(client, {
      connection,
      company: { id: "11111111-1111-1111-1111-111111111111", slug: "acme-corp" },
      tenantPolicy: null,
      // kind doesn't have a "paperclip-driver" SA in any namespace by default; the
      // RoleBinding's ClusterRole reference is also fictional. The RoleBinding
      // creation will succeed (k8s allows forward-references in subjects/roleRef);
      // we just don't exercise the binding's actual permissions in this test.
      driverServiceAccount: { name: "default", namespace: "default" },
      controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
      adapterAllowFqdns: [],
      imagePullDockerConfigJson: null,
    });
    // Always-hash namespace shape: paperclip-<slug>-<8-char-hash(companyId)>.
    // See M3b Task 17 / orchestrator/naming.ts for the rationale.
    expect(result.namespace).toMatch(/^paperclip-acme-corp-[0-9a-z]{8}$/);
    expect(result.ciliumApplied).toBe(false);

    // Verify all primitives exist with the expected labels.
    const ns = await client.core.readNamespace(result.namespace);
    expect(ns.body.metadata?.labels?.["paperclip.ai/managed-by"]).toBe("paperclip");
    expect(ns.body.metadata?.labels?.["pod-security.kubernetes.io/enforce"]).toBe("restricted");

    const sa = await client.core.readNamespacedServiceAccount("paperclip-agent", result.namespace);
    expect(sa.body.automountServiceAccountToken).toBe(false);

    const quota = await client.core.readNamespacedResourceQuota("paperclip-tenant-quota", result.namespace);
    expect(quota.body.spec?.hard?.["requests.cpu"]).toBe("16");

    const limitRange = await client.core.readNamespacedLimitRange("paperclip-tenant-limits", result.namespace);
    expect(limitRange.body.spec?.limits?.length).toBeGreaterThan(0);
    // Container LimitRange must carry the `default` field on the wire (k8s
    // typed client renames JS `_default` → JSON `default` via attributeTypeMap).
    // Without this assertion, a typo in the JS field name would silently drop
    // the default container limits and the cluster would have no enforcement.
    const containerLimit = limitRange.body.spec?.limits?.find((l) => l.type === "Container");
    expect(containerLimit?._default?.cpu).toBeDefined();
    expect(containerLimit?._default?.memory).toBeDefined();
    expect(containerLimit?.defaultRequest?.cpu).toBeDefined();
    expect(containerLimit?.max?.cpu).toBeDefined();

    const policies = await client.networking.listNamespacedNetworkPolicy(result.namespace);
    const names = policies.body.items.map(p => p.metadata?.name).sort();
    expect(names).toEqual(["default-deny-egress", "default-deny-ingress", "paperclip-agent-egress"]);
  }, 180_000);
});

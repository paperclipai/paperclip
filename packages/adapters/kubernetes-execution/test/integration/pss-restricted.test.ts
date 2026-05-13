import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spinUpKind, type KindCluster } from "./_harness.js";
import {
  createKubernetesApiClient,
  ensureTenantNamespace,
  type ResolvedClusterConnection,
} from "../../src/index.js";

let cluster: KindCluster;

describe.skipIf(!process.env["K8S_INTEGRATION"])("PSS Restricted compliance for tenant namespace", () => {
  beforeAll(() => { cluster = spinUpKind(); }, 240_000);
  afterAll(() => cluster?.cleanup());

  it("admission rejects a privileged Pod and accepts a compliant Pod", async () => {
    const connection: ResolvedClusterConnection = {
      id: "c-1", label: "kind", kind: "kubeconfig", kubeconfigYaml: cluster.kubeconfigYaml,
      defaultNamespacePrefix: "paperclip-",
      allowAgentImageOverride: false,
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
    };
    const client = createKubernetesApiClient(connection);
    const { namespace } = await ensureTenantNamespace(client, {
      connection,
      company: { id: "11111111-1111-1111-1111-111111111114", slug: "pss-test" },
      tenantPolicy: null,
      driverServiceAccount: { name: "default", namespace: "default" },
      controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
      adapterAllowFqdns: [],
      imagePullDockerConfigJson: null,
    });

    // Privileged Pod — admission must reject.
    let rejected = false;
    try {
      await client.core.createNamespacedPod(namespace, {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: "evil" },
        spec: {
          containers: [{
            name: "x",
            image: "busybox",
            command: ["sleep", "1"],
            securityContext: { privileged: true },
          }],
        },
      });
    } catch (err) {
      const msg = String((err as { body?: { message?: string }; message?: string }).body?.message ?? (err as Error).message ?? err);
      expect(msg).toMatch(/violates PodSecurity|forbidden|restricted/i);
      rejected = true;
    }
    expect(rejected).toBe(true);

    // Compliant Pod — admission must accept.
    await client.core.createNamespacedPod(namespace, {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "good" },
      spec: {
        automountServiceAccountToken: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          fsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [{
          name: "x",
          image: "busybox",
          command: ["sleep", "1"],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
        }],
      },
    });

    // Verify the compliant pod actually exists.
    const pod = await client.core.readNamespacedPod("good", namespace);
    expect(pod.body.metadata?.name).toBe("good");
  }, 180_000);
});

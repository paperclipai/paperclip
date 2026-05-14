import type { KubernetesApiClient, ClusterCapabilities } from "../types.js";

export async function probeClusterCapabilities(client: KubernetesApiClient): Promise<ClusterCapabilities> {
  const cilium = await detectCilium(client);

  const nodes = await client.core.listNode();
  const archSet = new Set<"amd64" | "arm64">();
  for (const node of nodes.body.items) {
    const arch = node.status?.nodeInfo?.architecture;
    if (arch === "amd64" || arch === "arm64") archSet.add(arch);
  }
  const architectures: ("amd64" | "arm64")[] = archSet.size > 0 ? [...archSet] : ["amd64"];

  const storageClass = await detectStorageClass(client);

  return { cilium, storageClass, architectures };
}

async function detectCilium(client: KubernetesApiClient): Promise<boolean> {
  try {
    const res = await client.request<{ kind?: string } | null>("GET", "/apis/cilium.io/v2");
    return res != null && res.kind === "APIResourceList";
  } catch {
    return false;
  }
}

async function detectStorageClass(client: KubernetesApiClient): Promise<string> {
  type SCList = { items: Array<{ metadata: { name: string; annotations?: Record<string, string> } }> };
  try {
    const res = await client.request<SCList | null>("GET", "/apis/storage.k8s.io/v1/storageclasses");
    if (!res || !res.items.length) return "standard";
    const isDefault = (sc: SCList["items"][number]) =>
      sc.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true";
    return res.items.find(isDefault)?.metadata.name ?? res.items[0].metadata.name;
  } catch {
    return "standard";
  }
}

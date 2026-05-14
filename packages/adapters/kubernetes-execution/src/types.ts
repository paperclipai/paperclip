import type {
  CoreV1Api,
  BatchV1Api,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
  ApiextensionsV1Api,
} from "@kubernetes/client-node";

export interface ResolvedClusterConnection {
  id: string;
  label: string;
  kind: "in-cluster" | "kubeconfig";
  /** Already resolved kubeconfig blob if kind === "kubeconfig". */
  kubeconfigYaml?: string;
  apiServerUrl?: string | null;
  defaultNamespacePrefix: string;
  paperclipPublicUrl?: string | null;
  imageRegistry?: string | null;
  allowAgentImageOverride: boolean;
  capabilities: ClusterCapabilities;
}

export interface ClusterCapabilities {
  cilium: boolean;
  storageClass: string;
  architectures: ("amd64" | "arm64")[];
}

export interface KubernetesApiClient {
  core: CoreV1Api;
  batch: BatchV1Api;
  networking: NetworkingV1Api;
  rbac: RbacAuthorizationV1Api;
  apiext: ApiextensionsV1Api;
  /** kubeconfig context info for logging only. */
  describe: () => string;
  /** Throwaway dynamic client used for arbitrary CRDs (Cilium). */
  request: <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;
}

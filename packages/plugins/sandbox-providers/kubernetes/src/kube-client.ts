import { createHash } from "node:crypto";
import {
  KubeConfig,
  CoreV1Api,
  BatchV1Api,
  CustomObjectsApi,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
  KubernetesObjectApi,
  PatchStrategy,
} from "@kubernetes/client-node";

export interface CreateKubeConfigInput {
  inCluster?: boolean;
  kubeconfig?: string;
}

export function createKubeConfig(input: CreateKubeConfigInput): KubeConfig {
  const kc = new KubeConfig();
  if (input.inCluster) {
    kc.loadFromCluster();
    return kc;
  }
  if (input.kubeconfig && input.kubeconfig.trim().length > 0) {
    kc.loadFromString(input.kubeconfig);
    return kc;
  }
  throw new Error("createKubeConfig requires either inCluster=true or a kubeconfig string");
}

export interface KubeClients {
  core: CoreV1Api;
  batch: BatchV1Api;
  custom: CustomObjectsApi;
  networking: NetworkingV1Api;
  rbac: RbacAuthorizationV1Api;
  object?: KubernetesObjectApi;
  /** Stable identifier for the target cluster derived from the active KubeConfig. */
  clusterId?: string;
  applyServerSide?: (
    manifest: Record<string, unknown>,
    fieldManager?: string,
  ) => Promise<void>;
}

/**
 * Derives a stable, non-secret identifier for the active cluster in a KubeConfig
 * so in-process caches and locks are strictly isolated across clusters even when
 * different environments share the same tenant namespace name.
 */
export function deriveClusterId(kc: KubeConfig): string {
  const cluster = typeof kc.getCurrentCluster === "function" ? kc.getCurrentCluster() : null;
  const context = typeof kc.getCurrentContext === "function" ? kc.getCurrentContext() : "";
  const raw = JSON.stringify({
    server: cluster?.server ?? "",
    caData: cluster?.caData ?? "",
    caFile: cluster?.caFile ?? "",
    context: context ?? "",
  });
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function makeKubeClients(kc: KubeConfig): KubeClients {
  const object = KubernetesObjectApi.makeApiClient(kc);
  return {
    core: kc.makeApiClient(CoreV1Api),
    batch: kc.makeApiClient(BatchV1Api),
    custom: kc.makeApiClient(CustomObjectsApi),
    networking: kc.makeApiClient(NetworkingV1Api),
    rbac: kc.makeApiClient(RbacAuthorizationV1Api),
    object,
    clusterId: deriveClusterId(kc),
    applyServerSide: async (manifest, fieldManager = "paperclip-k8s-plugin") => {
      await object.patch(
        manifest as never,
        undefined,
        undefined,
        fieldManager,
        true,
        PatchStrategy.ServerSideApply,
      );
    },
  };
}

import {
  KubeConfig,
  ApisApi,
  CoreV1Api,
  BatchV1Api,
  CustomObjectsApi,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
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
  /** Discovery: which API groups/versions this cluster serves. */
  apis: ApisApi;
  core: CoreV1Api;
  batch: BatchV1Api;
  custom: CustomObjectsApi;
  networking: NetworkingV1Api;
  rbac: RbacAuthorizationV1Api;
}

export function makeKubeClients(kc: KubeConfig): KubeClients {
  return {
    apis: kc.makeApiClient(ApisApi),
    core: kc.makeApiClient(CoreV1Api),
    batch: kc.makeApiClient(BatchV1Api),
    custom: kc.makeApiClient(CustomObjectsApi),
    networking: kc.makeApiClient(NetworkingV1Api),
    rbac: kc.makeApiClient(RbacAuthorizationV1Api),
  };
}

/**
 * Cache key identifying the cluster behind a KubeConfig. Served API versions
 * are a property of the API server, so its URL is the right granularity: two
 * environments pointing at the same cluster share one discovery result, and a
 * kubeconfig switched to a different cluster gets its own.
 */
export function apiServerUrl(kc: KubeConfig): string {
  const server = kc.getCurrentCluster()?.server;
  return server && server.length > 0 ? server : "in-cluster";
}

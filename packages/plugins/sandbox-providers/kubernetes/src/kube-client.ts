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
  applyServerSide?: (
    manifest: Record<string, unknown>,
    fieldManager?: string,
  ) => Promise<void>;
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

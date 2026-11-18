import {
  KubeConfig,
  CoreV1Api,
  BatchV1Api,
  CustomObjectsApi,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
} from "@kubernetes/client-node";
import {
  EKS_IAM_AUTH_PROVIDER_NAME,
  EksIamAuthenticator,
  assertEksIamClusterAllowed,
  getEksTokenSource,
  type EksTokenSource,
} from "./eks-iam-auth.js";
import type { EksIamAuthConfig } from "./types.js";

export interface CreateKubeConfigInput {
  inCluster?: boolean;
  kubeconfig?: string;
  auth?: EksIamAuthConfig;
}

export function createKubeConfig(
  input: CreateKubeConfigInput,
  deps: { tokenSource?: EksTokenSource; env?: NodeJS.ProcessEnv } = {},
): KubeConfig {
  const kc = new KubeConfig();
  if (input.auth?.type === "eks-iam") {
    const { clusterName, region, endpoint, caData } = input.auth;
    assertEksIamClusterAllowed(input.auth, deps.env);
    kc.addAuthenticator(new EksIamAuthenticator(deps.tokenSource ?? getEksTokenSource(clusterName, region)));
    kc.loadFromClusterAndUser(
      { name: clusterName, server: endpoint, caData, skipTLSVerify: false },
      { name: "paperclip-server", authProvider: { name: EKS_IAM_AUTH_PROVIDER_NAME, config: {} } },
    );
    return kc;
  }
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
}

export function makeKubeClients(kc: KubeConfig): KubeClients {
  return {
    core: kc.makeApiClient(CoreV1Api),
    batch: kc.makeApiClient(BatchV1Api),
    custom: kc.makeApiClient(CustomObjectsApi),
    networking: kc.makeApiClient(NetworkingV1Api),
    rbac: kc.makeApiClient(RbacAuthorizationV1Api),
  };
}

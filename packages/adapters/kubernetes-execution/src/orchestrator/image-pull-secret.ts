import type { V1Secret } from "@kubernetes/client-node";
import type { KubernetesApiClient } from "../types.js";
import { tenantBaseLabels } from "./labels.js";

export interface BuildImagePullSecretInput {
  namespace: string;
  companyId: string;
  companySlug: string;
  /** Already-resolved docker config JSON string (from a Paperclip secret_ref). */
  dockerConfigJson: string;
}

export function buildImagePullSecret(input: BuildImagePullSecretInput): V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "paperclip-image-pull",
      namespace: input.namespace,
      labels: tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
    },
    type: "kubernetes.io/dockerconfigjson",
    data: {
      ".dockerconfigjson": Buffer.from(input.dockerConfigJson, "utf-8").toString("base64"),
    },
  };
}

export async function applyImagePullSecret(client: KubernetesApiClient, s: V1Secret): Promise<void> {
  const ns = s.metadata!.namespace!;
  const name = s.metadata!.name!;
  try {
    await client.core.readNamespacedSecret(name, ns);
    await client.core.patchNamespacedSecret(name, ns, s, undefined, undefined, undefined, undefined, undefined, {
      headers: { "Content-Type": "application/strategic-merge-patch+json" },
    } as never);
  } catch (err) {
    if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 404) {
      await client.core.createNamespacedSecret(ns, s);
      return;
    }
    throw err;
  }
}

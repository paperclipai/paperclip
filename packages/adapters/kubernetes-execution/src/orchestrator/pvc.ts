import type { V1PersistentVolumeClaim } from "@kubernetes/client-node";
import type { KubernetesApiClient } from "../types.js";
import {
  tenantBaseLabels, PAPERCLIP_AGENT_ID, PAPERCLIP_ROLE, ROLE_AGENT_WORKSPACE,
  PAPERCLIP_WORKSPACE_STRATEGY,
} from "./labels.js";

export interface BuildAgentWorkspacePvcInput {
  namespace: string;
  agentId: string;
  agentSlug: string;
  companyId: string;
  companySlug: string;
  storageClass: string;
  sizeGi?: number;
  strategyKey: string;
}

export function buildAgentWorkspacePvc(input: BuildAgentWorkspacePvcInput): V1PersistentVolumeClaim {
  const sizeGi = input.sizeGi ?? 10;
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: `agent-${input.agentSlug}-workspace`,
      namespace: input.namespace,
      labels: {
        ...tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
        [PAPERCLIP_AGENT_ID]: input.agentId,
        [PAPERCLIP_ROLE]: ROLE_AGENT_WORKSPACE,
      },
      annotations: {
        [PAPERCLIP_WORKSPACE_STRATEGY]: input.strategyKey,
        "paperclip.ai/created-at": new Date().toISOString(),
      },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: input.storageClass,
      resources: { requests: { storage: `${sizeGi}Gi` } },
    },
  };
}

export async function applyAgentWorkspacePvc(
  client: KubernetesApiClient, pvc: V1PersistentVolumeClaim,
): Promise<{ existed: boolean }> {
  const ns = pvc.metadata!.namespace!;
  const name = pvc.metadata!.name!;
  try {
    await client.core.readNamespacedPersistentVolumeClaim(name, ns);
    // PVC spec is immutable in critical fields (storage size CAN be expanded; class CAN'T change).
    // We don't patch on subsequent runs — the existing PVC carries forward.
    return { existed: true };
  } catch (err) {
    if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 404) {
      await client.core.createNamespacedPersistentVolumeClaim(ns, pvc);
      return { existed: false };
    }
    throw err;
  }
}

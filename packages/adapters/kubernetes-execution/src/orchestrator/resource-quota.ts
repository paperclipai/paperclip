import type { V1ResourceQuota, V1LimitRange } from "@kubernetes/client-node";
import type { KubernetesApiClient } from "../types.js";
import { tenantBaseLabels } from "./labels.js";

export const defaultTenantQuota = {
  requestsCpu: "16",
  requestsMemory: "64Gi",
  limitsCpu: "64",
  limitsMemory: "256Gi",
  requestsStorage: "200Gi",
  countJobs: 100,
  countPvcs: 50,
  countSecrets: 200,
  countConfigMaps: 200,
} as const;

export const defaultTenantLimits = {
  default: { cpu: "1", memory: "2Gi" },
  defaultRequest: { cpu: "250m", memory: "512Mi" },
  max: { cpu: "8", memory: "32Gi" },
  pvcMaxStorage: "20Gi",
} as const;

export interface QuotaOverride {
  requestsCpu?: string;
  requestsMemory?: string;
  limitsCpu?: string;
  limitsMemory?: string;
  requestsStorage?: string;
  countJobs?: number;
  countPvcs?: number;
  countSecrets?: number;
  countConfigMaps?: number;
}

export interface LimitRangeOverride {
  default?: { cpu?: string; memory?: string };
  defaultRequest?: { cpu?: string; memory?: string };
  max?: { cpu?: string; memory?: string };
  pvcMaxStorage?: string;
}

export interface BuildQuotaInput {
  namespace: string;
  companyId: string;
  companySlug: string;
  override: QuotaOverride | null;
}

export function buildResourceQuota(input: BuildQuotaInput): V1ResourceQuota {
  const o = { ...defaultTenantQuota, ...(input.override ?? {}) };
  return {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: {
      name: "paperclip-tenant-quota",
      namespace: input.namespace,
      labels: tenantBaseLabels({
        companyId: input.companyId,
        companySlug: input.companySlug,
      }),
    },
    spec: {
      hard: {
        "requests.cpu": o.requestsCpu,
        "requests.memory": o.requestsMemory,
        "limits.cpu": o.limitsCpu,
        "limits.memory": o.limitsMemory,
        "requests.storage": o.requestsStorage,
        "count/jobs.batch": String(o.countJobs),
        "count/persistentvolumeclaims": String(o.countPvcs),
        "count/secrets": String(o.countSecrets),
        "count/configmaps": String(o.countConfigMaps),
      },
    },
  };
}

export interface BuildLimitRangeInput {
  namespace: string;
  companyId: string;
  companySlug: string;
  override: LimitRangeOverride | null;
}

export function buildLimitRange(input: BuildLimitRangeInput): V1LimitRange {
  const o = {
    default: { ...defaultTenantLimits.default, ...(input.override?.default ?? {}) },
    defaultRequest: {
      ...defaultTenantLimits.defaultRequest,
      ...(input.override?.defaultRequest ?? {}),
    },
    max: { ...defaultTenantLimits.max, ...(input.override?.max ?? {}) },
    pvcMaxStorage:
      input.override?.pvcMaxStorage ?? defaultTenantLimits.pvcMaxStorage,
  };
  return {
    apiVersion: "v1",
    kind: "LimitRange",
    metadata: {
      name: "paperclip-tenant-limits",
      namespace: input.namespace,
      labels: tenantBaseLabels({
        companyId: input.companyId,
        companySlug: input.companySlug,
      }),
    },
    spec: {
      limits: [
        {
          type: "Container",
          _default: o.default,
          defaultRequest: o.defaultRequest,
          max: o.max,
        },
        { type: "PersistentVolumeClaim", max: { storage: o.pvcMaxStorage } },
      ],
    },
  };
}

async function upsertNamespaced<
  T extends { metadata?: { name?: string; namespace?: string } }
>(
  obj: T,
  read: (ns: string, name: string) => Promise<unknown>,
  patch: (ns: string, name: string, body: T) => Promise<unknown>,
  create: (ns: string, body: T) => Promise<unknown>,
): Promise<void> {
  const ns = obj.metadata!.namespace!;
  const name = obj.metadata!.name!;
  try {
    await read(ns, name);
    await patch(ns, name, obj);
  } catch (err) {
    if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 404) {
      await create(ns, obj);
      return;
    }
    throw err;
  }
}

export async function applyResourceQuota(
  client: KubernetesApiClient,
  q: V1ResourceQuota,
): Promise<void> {
  await upsertNamespaced(
    q,
    (ns, name) => client.core.readNamespacedResourceQuota(name, ns),
    (ns, name, body) =>
      client.core.patchNamespacedResourceQuota(
        name,
        ns,
        body,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: {
            "Content-Type": "application/strategic-merge-patch+json",
          },
        } as never,
      ),
    (ns, body) => client.core.createNamespacedResourceQuota(ns, body),
  );
}

export async function applyLimitRange(
  client: KubernetesApiClient,
  lr: V1LimitRange,
): Promise<void> {
  await upsertNamespaced(
    lr,
    (ns, name) => client.core.readNamespacedLimitRange(name, ns),
    (ns, name, body) =>
      client.core.patchNamespacedLimitRange(
        name,
        ns,
        body,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: {
            "Content-Type": "application/strategic-merge-patch+json",
          },
        } as never,
      ),
    (ns, body) => client.core.createNamespacedLimitRange(ns, body),
  );
}

import type { V1Namespace } from "@kubernetes/client-node";
import type { KubernetesApiClient } from "../types.js";
import {
  PSS_ENFORCE, PSS_AUDIT, PSS_WARN, PSS_RESTRICTED,
  tenantBaseLabels, PAPERCLIP_MANAGED_BY, PAPERCLIP_MANAGED_BY_VALUE,
  PAPERCLIP_COMPANY_ID,
} from "./labels.js";

export interface BuildNamespaceInput {
  name: string;
  companyId: string;
  companySlug: string;
  extraLabels?: Record<string, string>;
}

export function buildNamespace(input: BuildNamespaceInput): V1Namespace {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: input.name,
      labels: {
        ...tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
        [PSS_ENFORCE]: PSS_RESTRICTED,
        [PSS_AUDIT]:   PSS_RESTRICTED,
        [PSS_WARN]:    PSS_RESTRICTED,
        ...input.extraLabels,
      },
    },
  };
}

export class NamespaceCompanyMismatchError extends Error {
  constructor(
    readonly namespace: string,
    readonly existingCompanyId: string,
    readonly incomingCompanyId: string,
  ) {
    super(
      `Refusing to manage namespace "${namespace}": labeled for company ${existingCompanyId}, not ${incomingCompanyId}`,
    );
    this.name = "NamespaceCompanyMismatchError";
  }
}

/**
 * Idempotently apply a tenant namespace. Refuses to overwrite a namespace
 * that is not labeled `paperclip.ai/managed-by=paperclip` OR that belongs to
 * a different company than the one being applied. Without the company-id
 * check, two companies whose slugs collide on a short prefix (e.g. both
 * derive `paperclip-acme`) would silently take over each other's namespace
 * — a multi-tenancy isolation breach.
 */
export async function applyNamespace(
  client: KubernetesApiClient,
  ns: V1Namespace,
): Promise<{ created: boolean }> {
  const name = ns.metadata!.name!;
  const incomingCompanyId = ns.metadata?.labels?.[PAPERCLIP_COMPANY_ID];
  try {
    const existing = await client.core.readNamespace(name);
    const managed = existing.body.metadata?.labels?.[PAPERCLIP_MANAGED_BY];
    if (managed !== PAPERCLIP_MANAGED_BY_VALUE) {
      throw new Error(
        `Refusing to manage namespace "${name}": missing label ${PAPERCLIP_MANAGED_BY}=${PAPERCLIP_MANAGED_BY_VALUE}`,
      );
    }
    const existingCompanyId = existing.body.metadata?.labels?.[PAPERCLIP_COMPANY_ID];
    // We only enforce the cross-tenant check when both sides carry a
    // company-id label. A pre-existing managed-by=paperclip namespace without
    // a company-id (legacy / pre-M1) is treated as adoptable by the current
    // call. Once it's been written once with a company-id, every future
    // application must match — which is the lock we need.
    if (
      existingCompanyId !== undefined &&
      incomingCompanyId !== undefined &&
      existingCompanyId !== incomingCompanyId
    ) {
      throw new NamespaceCompanyMismatchError(name, existingCompanyId, incomingCompanyId);
    }
    await client.core.patchNamespace(name, ns, undefined, undefined, undefined, undefined, undefined, {
      headers: { "Content-Type": "application/strategic-merge-patch+json" },
    } as never);
    return { created: false };
  } catch (err: unknown) {
    if (isNotFound(err)) {
      await client.core.createNamespace(ns);
      return { created: true };
    }
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  const code = (err as { response?: { statusCode?: number } })?.response?.statusCode;
  return code === 404;
}

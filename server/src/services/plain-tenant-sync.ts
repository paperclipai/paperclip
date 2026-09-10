import { logger } from "../middleware/logger.js";

// Plain models "which account/workspace is this customer working in" as a
// **tenant** (https://www.plain.com/docs/product/platform/tenants). The chat
// widget can scope new threads to a tenant via
// `threadDetails.tenantIdentifier.tenantId`, but the tenant has to exist in
// the Plain workspace with a human-readable name — otherwise support agents
// see nothing useful (or, worse, thread creation references an unknown
// tenant; Plain does not document that failure mode). This module is the
// fail-closed bridge: the session route only hands a tenant ID to the
// browser after `ensurePlainTenant` has successfully upserted the tenant.
//
// The upsert goes through Plain's public GraphQL Core API
// (https://www.plain.com/docs/graphql/tenants/upsert) with an API key scoped
// to `tenant:read` + `tenant:create` + `tenant:edit`. The key is bearer-grade for those
// scopes: server-side env only, never logged, never in the session response.

export const PLAIN_GRAPHQL_ENDPOINT = "https://core-api.uk.plain.com/graphql/v1";

export const UPSERT_TENANT_MUTATION = `mutation upsertTenant($input: UpsertTenantInput!) {
  upsertTenant(input: $input) {
    tenant { id externalId name }
    error { message code }
  }
}`;

/**
 * The Plain tenant externalId mirroring a Paperclip company. Prefixed so the
 * shared Plain workspace (one per Cloud fleet) can tell company tenants apart
 * from any other externalId namespace at a glance; the UUID keeps it unique
 * across stacks.
 */
export function plainTenantExternalId(companyId: string): string {
  return `paperclip-company-${companyId}`;
}

// Successful upserts per process, externalId → name + Plain ID. A hit means Plain
// already holds this exact tenant name, so the session route skips the
// network round-trip; a company rename misses and re-upserts.
const ensuredTenants = new Map<string, { name: string; id: string }>();

export function resetPlainTenantSyncForTests() {
  ensuredTenants.clear();
}

export interface EnsurePlainTenantOptions {
  apiKey: string;
  externalId: string;
  name: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Make sure a tenant with this externalId and name exists in the Plain
 * workspace. Returns the Plain tenant ID only on a confirmed upsert; every failure path —
 * network error, timeout, non-200, GraphQL/mutation error — returns `null`
 * so the caller withholds tenant context rather than pointing the widget at
 * a tenant that may not exist. Never throws.
 */
export async function ensurePlainTenant(opts: EnsurePlainTenantOptions): Promise<string | null> {
  const { apiKey, externalId, name } = opts;
  const cached = ensuredTenants.get(externalId);
  if (cached?.name === name) return cached.id;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4_000);
  try {
    const response = await fetchImpl(PLAIN_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: UPSERT_TENANT_MUTATION,
        variables: {
          input: {
            identifier: { externalId },
            name,
            externalId,
          },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn(
        { externalId, status: response.status },
        "Plain tenant upsert answered a non-200 status",
      );
      return null;
    }
    const payload = (await response.json()) as {
      data?: { upsertTenant?: { tenant?: { id?: string } | null; error?: { message?: string; code?: string } | null } };
      errors?: Array<{ message?: string }>;
    };
    const mutationError = payload.data?.upsertTenant?.error;
    const requestErrors = payload.errors;
    if (requestErrors?.length || mutationError || !payload.data?.upsertTenant?.tenant?.id) {
      logger.warn(
        {
          externalId,
          errorCode: mutationError?.code ?? null,
          errorMessage: mutationError?.message ?? requestErrors?.[0]?.message ?? null,
        },
        "Plain tenant upsert was rejected",
      );
      return null;
    }
    const id = payload.data.upsertTenant.tenant.id;
    ensuredTenants.set(externalId, { name, id });
    return id;
  } catch (err) {
    logger.warn({ err, externalId }, "Plain tenant upsert failed");
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

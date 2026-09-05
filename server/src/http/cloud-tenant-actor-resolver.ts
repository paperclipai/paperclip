import type { Db } from "@paperclipai/db";
import { resolveCloudTenantActor } from "../middleware/auth.js";
import type { HttpActor } from "./actor-context.js";
import type { CredentialResolver } from "./credential-bridge.js";
import { toHeaderSource } from "./request-headers.js";

export type LegacyCloudTenantActorResolver = typeof resolveCloudTenantActor;

/**
 * Resolve only the cloud-tenant actor variant through the existing credential
 * implementation. This resolver must be composed with the remaining actor
 * resolvers before it can be used as a deployment's sole `resolveActor`.
 */
export function createCloudTenantActorResolver(
  db: Db,
  resolveLegacy: LegacyCloudTenantActorResolver = resolveCloudTenantActor,
): CredentialResolver {
  return async (request: Request): Promise<HttpActor | null> => {
    let legacy: Awaited<ReturnType<LegacyCloudTenantActorResolver>>;
    try {
      legacy = await resolveLegacy(db, toHeaderSource(request));
    } catch {
      // A malformed trusted-header request must fail closed in the new boundary.
      return null;
    }

    if (!legacy || legacy.type !== "board" || legacy.source !== "cloud_tenant") {
      return null;
    }

    return {
      type: "board",
      source: "cloud_tenant",
      userId: legacy.userId,
      userName: legacy.userName,
      userEmail: legacy.userEmail,
      companyIds: legacy.companyIds,
      memberships: legacy.memberships,
      isInstanceAdmin: legacy.isInstanceAdmin,
      runId: request.headers.get("x-paperclip-run-id") ?? undefined,
    };
  };
}

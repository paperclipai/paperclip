import type {
  BetterAuthSessionResolver,
  BetterAuthSessionResult,
} from "../auth/better-auth.js";
import { resolveBetterAuthSessionFromHeaders } from "../auth/better-auth.js";
import type { HttpMembership, HttpActor } from "./actor-context.js";
import type { CredentialResolver } from "./credential-bridge.js";

export type SessionAccess = {
  memberships: HttpMembership[];
  isInstanceAdmin: boolean;
};

export type SessionAccessResolver = (
  userId: string,
) => SessionAccess | Promise<SessionAccess>;

/**
 * Resolve a Better Auth browser session into the typed HTTP board actor.
 *
 * Credential/session verification stays in Better Auth. Company memberships
 * and instance-admin elevation stay in the injected access resolver, keeping
 * this transport boundary free of duplicate database authorization logic.
 * This resolver must be composed with agent and cloud resolvers before it is
 * used as a deployment's complete actor resolver.
 */
export function createSessionActorResolver(
  auth: BetterAuthSessionResolver,
  resolveAccess: SessionAccessResolver,
): CredentialResolver {
  return async (request: Request): Promise<HttpActor | null> => {
    let session: BetterAuthSessionResult | null;
    try {
      session = await resolveBetterAuthSessionFromHeaders(
        auth,
        new Headers(request.headers),
      );
    } catch {
      return null;
    }

    if (!session?.user?.id || !session.session?.id) return null;

    let access: SessionAccess;
    try {
      access = await resolveAccess(session.user.id);
    } catch {
      return null;
    }

    const memberships = access.memberships.filter(
      (membership) => membership.status === "active",
    );
    const companyIds = Array.from(
      new Set(memberships.map((membership) => membership.companyId)),
    );

    return {
      type: "board",
      source: "session",
      userId: session.user.id,
      userName: session.user.name ?? null,
      userEmail: session.user.email ?? null,
      sessionId: session.session.id,
      companyIds,
      memberships,
      isInstanceAdmin: access.isInstanceAdmin,
    };
  };
}

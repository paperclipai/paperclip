/**
 * Plugin worker actor-context security boundary.
 *
 * Extracted from `plugins.ts` into this dependency-free module (no express / db /
 * drizzle imports) so the security boundary can be imported and unit-tested in
 * isolation — including from the plugin packages whose worker RBAC relies on it —
 * without pulling the whole Express route module's runtime dependency graph.
 * `plugins.ts` re-exports both symbols, so existing importers are unaffected.
 */

/** Server-authenticated actor shape consumed by {@link mergeActorContext}. */
export interface ActorContextInput {
  type?: string;
  userId?: string | null;
  isInstanceAdmin?: boolean;
}

/**
 * Merge the server-authenticated actor into the params a plugin worker receives,
 * stripping any client-supplied identity keys first.
 *
 * This is the security boundary that scopes per-user reads to the calling
 * authenticated user only. A client request can carry an arbitrary
 * `params.userId` / `params.user_id`, but those keys are DROPPED here so a worker
 * can ONLY ever resolve the real caller from the trusted `__actor` envelope —
 * never from a client claim. This makes per-user exports (e.g. a plugin's
 * access-list feed) self-only: a caller can never coerce the worker into reading
 * another user's data by spoofing a user id in the request body.
 *
 * NOTE for plugin authors: because `user_id`/`userId` are stripped here, a worker
 * action that needs a SECOND, distinct user id (e.g. the grantee/TARGET of a
 * grant-access call — separate from the ACTOR who grants) MUST carry that target
 * under a different key (e.g. `target_user_id`), since this boundary removes only
 * the actor-identity keys and leaves every other param untouched.
 *
 * Additive and back-compatible: workers that don't read `__actor` simply ignore it.
 */
export function mergeActorContext(
  params: Record<string, unknown> | undefined,
  actor: ActorContextInput | undefined | null,
  companyId?: string,
): Record<string, unknown> {
  const { userId: _u, user_id: _us, ...clientParams } = (params ?? {}) as Record<
    string,
    unknown
  >;
  return {
    ...clientParams,
    __actor: {
      userId: actor?.userId ?? null,
      isInstanceAdmin: Boolean(actor?.isInstanceAdmin),
      type: actor?.type ?? "none",
      companyId: companyId ?? null,
    },
  };
}

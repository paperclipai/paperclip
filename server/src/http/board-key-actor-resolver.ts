import type { Db } from "@paperclipai/db";
import { unauthorized, HttpError } from "../errors.js";
import type { HttpActor, HttpMembership } from "./actor-context.js";
import type { CredentialResolver } from "./credential-bridge.js";
import type { ActorResolution, ActorResolutionResolver } from "./actor-resolvers.js";
import { classifyBearerRequest } from "./bearer-dispatch.js";

export type BoardAuthResolver = {
  findByToken(token: string): Promise<{ id: string; userId: string } | null>;
  resolveAccess(userId: string): Promise<{
    user: { name?: string | null; email?: string | null } | null;
    companyIds: string[];
    memberships: HttpMembership[];
    isInstanceAdmin: boolean;
  }>;
  touchKey(keyId: string): Promise<void>;
};

function requestPath(request: Request): string {
  return new URL(request.url).pathname;
}

/**
 * Adapt board API-key authentication to a discriminated resolution result.
 *
 * A missing credential or an unrelated MCP gateway request is a `miss` and may
 * continue to another authority. A present but empty bearer is a rejection,
 * preserving the existing fail-closed 401 contract instead of falling through.
 */
export function createBoardKeyActorResolutionResolver(
  _db: Db,
  boardAuth: BoardAuthResolver,
): ActorResolutionResolver {
  return async (request: Request): Promise<ActorResolution> => {
    const classification = classifyBearerRequest(
      requestPath(request),
      request.headers.get("authorization") ?? undefined,
    );

    if (classification.kind === "none" || classification.kind === "gateway") {
      return { kind: "miss" };
    }
    if (classification.kind === "empty") {
      return {
        kind: "rejected",
        error: unauthorized("Empty bearer token; provide valid agent credentials and retry"),
      };
    }

    let key: { id: string; userId: string } | null;
    try {
      key = await boardAuth.findByToken(classification.token);
    } catch {
      return {
        kind: "rejected",
        error: new HttpError(500, "Board credential resolver failed"),
      };
    }
    if (!key) return { kind: "miss" };

    try {
      const access = await boardAuth.resolveAccess(key.userId);
      if (!access.user) return { kind: "miss" };
      await boardAuth.touchKey(key.id);
      return {
        kind: "matched",
        actor: {
          type: "board",
          source: "board_key",
          userId: key.userId,
          userName: access.user.name ?? null,
          userEmail: access.user.email ?? null,
          companyIds: access.companyIds,
          memberships: access.memberships,
          isInstanceAdmin: access.isInstanceAdmin,
          keyId: key.id,
          runId: request.headers.get("x-paperclip-run-id") ?? undefined,
        },
      };
    } catch {
      return {
        kind: "rejected",
        error: new HttpError(500, "Board credential resolver failed"),
      };
    }
  };
}

/**
 * Backward-compatible nullable resolver for isolated callers. New composed
 * authentication code must use `createBoardKeyActorResolutionResolver` so an
 * invalid bearer cannot be mistaken for an absent credential.
 */
export function createBoardKeyActorResolver(
  db: Db,
  boardAuth: BoardAuthResolver,
): CredentialResolver {
  const resolve = createBoardKeyActorResolutionResolver(db, boardAuth);
  return async (request: Request): Promise<HttpActor | null> => {
    const result = await resolve(request);
    return result.kind === "matched" ? result.actor : null;
  };
}

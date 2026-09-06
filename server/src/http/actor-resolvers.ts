import type { HttpActor } from "./actor-context.js";
import type { CredentialResolver } from "./credential-bridge.js";
import { HttpError } from "../errors.js";

export type ActorResolution =
  | { kind: "miss" }
  | { kind: "matched"; actor: HttpActor }
  | { kind: "rejected"; error: HttpError };

export type ActorResolutionResolver = (
  request: Request,
) => ActorResolution | Promise<ActorResolution>;

/**
 * Compose authentication sources without treating invalid credentials as a
 * miss. A resolver must explicitly return `miss` when it does not own a
 * request; `rejected` stops the chain and preserves the denial. This prevents a
 * malformed bearer from falling through into a different authority.
 */
export function composeActorResolvers(
  ...resolvers: readonly ActorResolutionResolver[]
): ActorResolutionResolver {
  return async (request: Request): Promise<ActorResolution> => {
    for (const resolve of resolvers) {
      try {
        const result = await resolve(request);
        if (result.kind !== "miss") return result;
      } catch (error) {
        return {
          kind: "rejected",
          error: error instanceof HttpError
            ? error
            : new HttpError(500, "Credential resolver failed"),
        };
      }
    }
    return { kind: "miss" };
  };
}

/**
 * Adapt the legacy nullable resolver shape for sources that intentionally only
 * match a subset of requests. Errors remain explicit rejections; a null result
 * remains an explicit miss.
 */
export function asActorResolutionResolver(
  resolver: CredentialResolver,
): ActorResolutionResolver {
  return async (request) => {
    const actor = await resolver(request);
    return actor ? { kind: "matched", actor } : { kind: "miss" };
  };
}

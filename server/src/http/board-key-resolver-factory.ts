import type { Db } from "@paperclipai/db";
import { boardAuthService } from "../services/board-auth.js";
import type { CredentialResolver } from "./credential-bridge.js";
import { createBoardKeyActorResolver, type BoardAuthResolver } from "./board-key-actor-resolver.js";

/**
 * Build the HTTP board-key resolver from Paperclip's existing board auth
 * service. This factory is intentionally dormant until the complete resolver
 * composition and production parity gates are complete.
 */
export function createBoardKeyActorResolverFromService(
  db: Db,
  serviceOverride?: {
    findBoardApiKeyByToken: BoardAuthResolver["findByToken"];
    resolveBoardAccess: BoardAuthResolver["resolveAccess"];
    touchBoardApiKey: BoardAuthResolver["touchKey"];
  },
): CredentialResolver {
  const service = serviceOverride ?? boardAuthService(db);
  return createBoardKeyActorResolver(db, {
    findByToken: service.findBoardApiKeyByToken,
    resolveAccess: service.resolveBoardAccess,
    touchKey: service.touchBoardApiKey,
  });
}

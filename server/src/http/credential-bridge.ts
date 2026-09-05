import { unauthorized } from "../errors.js";
import type { HttpActor } from "./actor-context.js";

export type CredentialResolver = (
  request: Request,
) => HttpActor | null | Promise<HttpActor | null>;

export type CredentialBridge = {
  resolve(request: Request): Promise<HttpActor>;
};

/**
 * Boundary for reusing Paperclip's existing credential verification from an
 * HTTP-native request. The bridge does not parse tokens or create actors; the
 * injected resolver remains the sole authentication authority.
 */
export function createCredentialBridge(
  resolveCredentials: CredentialResolver,
): CredentialBridge {
  return {
    async resolve(request) {
      const actor = await resolveCredentials(request);
      if (!actor) throw unauthorized();
      return actor;
    },
  };
}

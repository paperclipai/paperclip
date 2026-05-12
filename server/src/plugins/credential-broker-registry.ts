import {
  __consumeRegisteredCredentialBrokerFactory,
  type CredentialBroker,
  type RegisterCredentialBrokerCtx,
} from "@paperclipai/plugin-sdk";

/**
 * Server-side resolution of the registered credential broker plugin.
 *
 * Exactly one broker may be registered per server process via the
 * SDK's `registerCredentialBroker()` helper. This module reads the
 * registration once at first call and caches the resolved broker
 * for the remainder of the process lifetime.
 *
 * If no broker is registered (the M1 default — the in-tree
 * `@paperclipai/credential-broker-builtin` is a placeholder until
 * M2 ships), `resolveCredentialBroker()` returns `undefined` and
 * the smart resolver (see `oauth/resolve-credential-delivery.ts`)
 * falls back to plaintext `env` delivery.
 */

let cached: CredentialBroker | undefined;
let resolved = false;

export async function resolveCredentialBroker(
  ctx: RegisterCredentialBrokerCtx,
): Promise<CredentialBroker | undefined> {
  if (resolved) return cached;
  const factory = __consumeRegisteredCredentialBrokerFactory();
  if (!factory) {
    resolved = true;
    return undefined;
  }
  cached = await factory(ctx);
  resolved = true;
  return cached;
}

/** @internal — test helper; clears the cache so a fresh registration is honored. */
export function __resetResolvedBrokerForTests(): void {
  cached = undefined;
  resolved = false;
}

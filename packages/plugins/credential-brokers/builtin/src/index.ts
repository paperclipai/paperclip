/**
 * `@paperclipai/credential-broker-builtin` — default credential broker plugin for Paperclip.
 *
 * **M1 placeholder.** Full implementation lands in M2 per the design spec
 * (`docs/superpowers/specs/2026-05-12-credential-broker-design.md` §3) and
 * the M2 implementation plan.
 *
 * Until M2 ships, this package exists so that the workspace resolves
 * cleanly and consumers can take the dependency without breakage.
 * No broker is registered; `resolveCredentialBroker()` on the server
 * returns `undefined`, and the smart resolver falls back to env delivery.
 */

export const PACKAGE_NAME = "@paperclipai/credential-broker-builtin";

/** Surface-stable placeholder constant; will be replaced by `registerBuiltinCredentialBroker()` in M2. */
export const PACKAGE_STATUS = "m1-placeholder" as const;

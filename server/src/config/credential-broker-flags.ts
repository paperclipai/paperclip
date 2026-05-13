/**
 * Feature flags for the credential broker subsystem.
 *
 * Both flags default to disabled. Until they're flipped on (and a broker
 * plugin is installed and reachable), the OAuth resolution path is the
 * legacy plaintext-in-env behavior from #5805.
 *
 * Per-deployment rollout plan: enable
 * `PAPERCLIP_FEATURE_CREDENTIAL_BROKER=1` first to activate the smart
 * resolver and observability (warn-log on every fallback). High-assurance
 * deployments can additionally set `PAPERCLIP_REQUIRE_BROKER=1` to make
 * the resolver throw `CredentialBrokerRequiredError` rather than fall
 * back — useful as a guard rail in production after providers have been
 * end-to-end validated against the broker.
 */

function parseFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * `true` when the smart resolver should run. With this flag off, the
 * legacy oauth_token resolution path from #5805 is used unconditionally.
 */
export function credentialBrokerFeatureEnabled(): boolean {
  return parseFlag(process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER);
}

/**
 * `true` when the resolver should throw `CredentialBrokerRequiredError`
 * instead of falling back to `env` delivery. Only honored when
 * `credentialBrokerFeatureEnabled()` is also true.
 */
export function credentialBrokerRequired(): boolean {
  return parseFlag(process.env.PAPERCLIP_REQUIRE_BROKER);
}

/** @internal — test helper for tests that need to reset both flags. */
export function __clearCredentialBrokerFlagsForTests(): void {
  delete process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER;
  delete process.env.PAPERCLIP_REQUIRE_BROKER;
}

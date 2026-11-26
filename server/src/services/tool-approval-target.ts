import { canonicalToolArguments } from "./tool-content-guards.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Refresh bookkeeping does not change the OAuth authorization being reviewed. */
export function oauthApprovalIdentity(value: unknown): Record<string, unknown> {
  const { expiresAt, accessTokenExpiresAt, refreshTokenExpiresAt, refreshedAt, refreshLease,
    scope, scopeSource, unrequestedScopes,
    ...identity } = record(value) ?? {};
  for (const key of ["scopes", "requestedScopes"]) {
    if (Array.isArray(identity[key])) identity[key] = [...new Set(identity[key])].sort();
  }
  return identity;
}

export function oauthApprovalConfig(value: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value };
  if (record(value.oauth)) result.oauth = oauthApprovalIdentity(value.oauth);
  const metadata = record(value.providerMetadata);
  if (metadata && record(metadata.oauth)) {
    result.providerMetadata = { ...metadata, oauth: oauthApprovalIdentity(metadata.oauth) };
  }
  return result;
}

export function oauthGrantApprovalIdentity(value: unknown, connectionOAuth: unknown) {
  const grant = oauthApprovalIdentity(value);
  const connection = record(connectionOAuth) ?? {};
  const tokenType = grant.tokenType ?? connection.tokenType ?? "Bearer";
  return { ...grant, strategy: grant.strategy ?? connection.strategy ?? "direct_oauth",
    tokenType: typeof tokenType === "string" ? tokenType.toLowerCase() : tokenType };
}

export function approvalGrantTenantIdentity(value: unknown, connectionOAuth: unknown) {
  const tenant: Record<string, unknown> = { ...record(value), oauth: oauthGrantApprovalIdentity(record(value)?.oauth, connectionOAuth) };
  const github = record(tenant.github);
  if (github) {
    const { lastAccessRefreshAt, bindingSync, continuityRetry, lastWebhookAt, webhookHealth, ...identity } = github;
    tenant.github = identity;
  }
  return tenant;
}

export function externalCredentialApprovalIdentity(value: unknown) {
  const fields = record(value);
  if (fields?.provider !== "vercel_connect") return value;
  const { expiresAt, lastVerifiedAt, ...identity } = fields;
  return identity;
}

function credentials(value: unknown, durable: boolean): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(entry => {
    const fields = record(entry);
    if (!fields) return entry;
    const { identityEpoch, resolvedVersion, ...rest } = fields;
    // Only current, verified OAuth token identities can survive version changes.
    // Fixed versions and non-OAuth secrets retain exact version comparisons.
    return durable && Number.isSafeInteger(identityEpoch) && Number(identityEpoch) >= 0
      ? { ...rest, identityEpoch }
      : { ...rest, resolvedVersion };
  });
}

function comparable(snapshot: Record<string, unknown>, durable: boolean) {
  const { approvalSnapshotVersion, connectionIdentityHash, connectionAuthorizationConfigHash,
    connectionAuthorizationTransportConfigHash, credentialGrantIdentityHash, ...legacy } = snapshot;
  const result = durable ? { ...snapshot } : legacy;
  if (durable) {
    delete result.connectionConfigHash;
    delete result.connectionTransportConfigHash;
  }
  for (const key of ["headerCredentialVersions", "credentialSecretVersions"]) {
    if (key in result) result[key] = credentials(result[key], durable);
  }
  return result;
}

export function approvalSnapshotsMatch(reviewed: unknown, live: Record<string, unknown> | null): boolean {
  const saved = record(reviewed);
  if (!saved || !live) return !saved && !live;
  if (saved.approvalSnapshotVersion !== undefined && saved.approvalSnapshotVersion !== 2) return false;
  // Old signed requests retain their exact-version contract. Never infer
  // continuity for credentials that changed before this contract was recorded.
  const durable = saved.approvalSnapshotVersion === 2;
  if (durable && live.approvalSnapshotVersion !== 2) return false;
  return canonicalToolArguments(comparable(saved, durable)) === canonicalToolArguments(comparable(live, durable));
}

export function approvalTargetChangeMessage(reviewed: unknown, live: Record<string, unknown> | null): string {
  const saved = record(reviewed);
  if (saved && live) {
    const durable = saved.approvalSnapshotVersion === 2;
    const before = comparable(saved, durable), after = comparable(live, durable);
    const changed = (keys: string[]) => keys.some(key => canonicalToolArguments(before[key]) !== canonicalToolArguments(after[key]));
    if (changed(["credentialGrantId", "credentialGrantIdentityHash", "credentialGrantRefsHash",
      "credentialSecretVersions", "headerCredentialVersions"]))
      return "The connected account, credentials, or permissions changed. A new review is required.";
    if (changed(["catalogEntryId", "catalogVersionHash", "catalogSchemaHash", "upstreamToolName", "riskLevel"]))
      return "The tool definition changed. A new review is required.";
    if (changed(["connectionId", "connectionIdentityHash", "connectionConfigHash", "connectionTransportConfigHash",
      "connectionAuthorizationConfigHash", "connectionAuthorizationTransportConfigHash"]))
      return "The app connection or destination changed. A new review is required.";
  }
  return "The reviewed action is no longer current. A new review is required.";
}

import { describe, expect, it } from "vitest";
import { approvalSnapshotsMatch, approvalTargetChangeMessage, oauthApprovalConfig, oauthGrantApprovalIdentity,
  approvalGrantTenantIdentity, externalCredentialApprovalIdentity } from "./tool-approval-target.js";

function snapshot() {
  return { approvalSnapshotVersion: 2, connectionConfigHash: "old expiry", connectionTransportConfigHash: "old expiry",
    connectionIdentityHash: "oauth-vault-owner", connectionAuthorizationConfigHash: "same endpoint and client",
    connectionAuthorizationTransportConfigHash: "same transport", credentialGrantIdentityHash: "same consent and scopes",
    credentialGrantId: "owner-grant", catalogSchemaHash: "reviewed-schema", catalogVersionHash: "reviewed-tool",
    credentialSecretVersions: [{ refHash: "access-token", versionSelector: "latest", resolvedVersion: 1480, identityEpoch: 1479 }],
    headerCredentialVersions: [] };
}

describe("durable tool approval target", () => {
  it.each([
    ["credentialGrantIdentityHash", "account, credentials, or permissions"],
    ["catalogVersionHash", "tool definition"],
    ["connectionAuthorizationConfigHash", "connection or destination"],
  ] as const)("explains a changed %s without telling the person to retry", (field, reason) => {
    const saved = snapshot(), live = { ...snapshot(), [field]: "changed" };
    expect(approvalTargetChangeMessage(saved, live)).toContain(reason);
    expect(approvalTargetChangeMessage(saved, live)).not.toMatch(/try again/i);
  });
  it("accepts refresh versions under the same authenticated credential identity", () => {
    const reviewed = snapshot(), live = snapshot();
    live.connectionConfigHash = live.connectionTransportConfigHash = "new expiry";
    live.credentialSecretVersions[0].resolvedVersion = 1483;
    expect(approvalSnapshotsMatch(reviewed, live)).toBe(true);
  });

  it.each(["connectionIdentityHash", "connectionAuthorizationConfigHash", "connectionAuthorizationTransportConfigHash",
    "credentialGrantIdentityHash", "credentialGrantId", "catalogSchemaHash", "catalogVersionHash"] as const)(
    "refuses a changed %s even after routine refresh", field => {
      const reviewed = snapshot(), live = snapshot();
      live[field] = "changed";
      expect(approvalSnapshotsMatch(reviewed, live)).toBe(false);
    });

  it("refuses manual OAuth credential replacement", () => {
    const reviewed = snapshot(), live = snapshot();
    live.credentialSecretVersions[0].identityEpoch++;
    live.credentialSecretVersions[0].resolvedVersion++;
    expect(approvalSnapshotsMatch(reviewed, live)).toBe(false);
  });

  it("keeps fixed versions and non-OAuth credentials bound to their exact versions", () => {
    for (const versionSelector of ["1", "latest"]) {
      const reviewed = { ...snapshot(), credentialSecretVersions: [{ refHash: "api-key", versionSelector, resolvedVersion: 1 }] };
      expect(approvalSnapshotsMatch(reviewed, { ...reviewed,
        credentialSecretVersions: [{ refHash: "api-key", versionSelector, resolvedVersion: 2 }] })).toBe(false);
    }
  });

  it("carries an old signed snapshot forward only while its exact versions and configuration still match", () => {
    const current = snapshot();
    const { approvalSnapshotVersion, connectionIdentityHash, connectionAuthorizationConfigHash,
      connectionAuthorizationTransportConfigHash, credentialGrantIdentityHash, ...legacy } = current;
    const reviewed = { ...legacy,
      credentialSecretVersions: [{ refHash: "access-token", versionSelector: "latest", resolvedVersion: 1480 }] };
    expect(approvalSnapshotsMatch(reviewed, current)).toBe(true);
    current.credentialSecretVersions[0].resolvedVersion++;
    expect(approvalSnapshotsMatch(reviewed, current)).toBe(false);
  });

  it("refuses an unknown saved snapshot version", () => {
    expect(approvalSnapshotsMatch({ ...snapshot(), approvalSnapshotVersion: 3 }, snapshot())).toBe(false);
  });

  it("ignores only OAuth lifecycle bookkeeping, retaining audience, issuer, scope and consent", () => {
    const config = { url: "https://notebook.example/mcp", oauth: { issuer: "https://id.example", resource: "notebook",
      consentedAt: "first consent", scopes: ["write", "read"], expiresAt: "old", refreshedAt: "old" },
      providerMetadata: { oauth: { expiresAt: "old", scope: "read write" } }, methodConfig: { expiresAt: "meaningful setting" } };
    const refreshed = { ...config, oauth: { ...config.oauth, expiresAt: "new", refreshedAt: "new", scopes: ["read", "write"] },
      providerMetadata: { oauth: { ...config.providerMetadata.oauth, expiresAt: "new", scope: "write read" } } };
    expect(oauthApprovalConfig(config)).toEqual(oauthApprovalConfig(refreshed));
    for (const field of ["issuer", "resource", "consentedAt"]) {
      expect(oauthApprovalConfig(config)).not.toEqual(oauthApprovalConfig({ ...refreshed,
        oauth: { ...refreshed.oauth, [field]: "changed" } }));
    }
    expect(oauthGrantApprovalIdentity({ scopes: ["read"] }, { tokenType: "Bearer" }))
      .toEqual(oauthGrantApprovalIdentity({ scopes: ["read"], strategy: "direct_oauth", tokenType: "Bearer", refreshedAt: "new" }, {}));
  });

  it("compares effective permissions when a refresh starts or stops reporting scope", () => {
    const consent = { scopes: ["read", "write"], requestedScopes: ["read", "write"], scopeSource: "requested_fallback" };
    const reported = { ...consent, scopes: ["write", "read", "read"], scopeSource: "provider", scope: "write read", unrequestedScopes: [] };
    expect(oauthGrantApprovalIdentity(consent, {})).toEqual(oauthGrantApprovalIdentity(reported, {}));
    expect(oauthGrantApprovalIdentity(consent, {})).not.toEqual(oauthGrantApprovalIdentity({ ...reported, scopes: ["read"] }, {}));
  });

  it("retains external account and token identity while ignoring verification timestamps", () => {
    const credential = { provider: "vercel_connect", tokenId: "reviewed-token", teamId: "reviewed-team", expiresAt: 1, lastVerifiedAt: 1 };
    expect(externalCredentialApprovalIdentity(credential)).toEqual(externalCredentialApprovalIdentity({ ...credential, expiresAt: 2, lastVerifiedAt: 2 }));
    for (const key of ["tokenId", "teamId"]) {
      expect(externalCredentialApprovalIdentity(credential)).not.toEqual(externalCredentialApprovalIdentity({ ...credential, [key]: "changed" }));
    }
  });

  it("retains installation identity while ignoring GitHub health and refresh bookkeeping", () => {
    const tenant = { github: { installationId: 123, accountId: 456, lastAccessRefreshAt: "old", bindingSync: { status: "pending" } } };
    expect(approvalGrantTenantIdentity(tenant, {})).toEqual(approvalGrantTenantIdentity({ github: {
      ...tenant.github, lastAccessRefreshAt: "new", bindingSync: { status: "complete" }, lastWebhookAt: "new", webhookHealth: "healthy" } }, {}));
    expect(approvalGrantTenantIdentity(tenant, {})).not.toEqual(approvalGrantTenantIdentity({ github: { ...tenant.github, installationId: 789 } }, {}));
  });
});

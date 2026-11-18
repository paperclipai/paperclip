import { describe, expect, it } from "vitest";
import { providerRetryAt } from "./provider-retry-after.js";
import { githubContinuityRevision, githubGrantContinuityDeadline } from "./tool-access/github-grant-continuity.js";
const now = Date.parse("2026-01-01T00:00:00Z");
describe("provider and credential deadlines", () => {
  it("accepts bounded Retry-After seconds/dates and ignores malformed or expired advice", () => {
    expect(providerRetryAt("120", now)).toBe(now + 120_000);
    expect(providerRetryAt(new Date(now + 60_000).toUTCString(), now)).toBe(now + 60_000);
    expect(providerRetryAt("999999999999", now)).toBe(now + 24 * 3600_000);
    for (const value of [null, "", "unknown", "-3", new Date(now - 1).toUTCString()]) expect(providerRetryAt(value, now)).toBeUndefined();
  });
  it("reconstructs expiry, continuity and saved retries and preempts a retry when credentials change", () => {
    const connection = { config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } } };
    const github = { userId: "42", login: "owner", installationCount: 1, repositoryCount: 1, repositorySelection: "all" as const,
      installationIds: ["101"], installationOwnerLogins: ["owner"], lastAccessRefreshAt: new Date(now).toISOString() };
    const grant = { providerTenant: { github, oauth: { accessTokenExpiresAt: new Date(now + 8 * 3600_000).toISOString(), refreshedAt: new Date(now).toISOString() } } };
    expect(githubGrantContinuityDeadline(connection, grant)).toBe(now + 7 * 3600_000);
    const retried = { providerTenant: { ...grant.providerTenant, github: { ...github,
      continuityRetry: { at: new Date(now + 10 * 3600_000).toISOString(), attempts: 2, revision: githubContinuityRevision(grant) } } } };
    expect(githubGrantContinuityDeadline(connection, retried)).toBe(now + 10 * 3600_000);
    retried.providerTenant.oauth.accessTokenExpiresAt = new Date(now + 2 * 3600_000).toISOString();
    expect(githubGrantContinuityDeadline(connection, retried)).toBe(now + 3600_000);
    expect(githubGrantContinuityDeadline(connection, { providerTenant: { github } })).toBe(now + 30 * 24 * 3600_000);
    expect(githubGrantContinuityDeadline({ config: {} }, grant)).toBeNull();
  });
});

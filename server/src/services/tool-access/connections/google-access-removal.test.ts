import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const resolveConnectionGrantSecret = vi.hoisted(() => vi.fn());
vi.mock("../../connection-credentials.js", () => ({ resolveConnectionGrantSecret }));

import { createManagedGoogleAccessRemoval, summarizeManagedGoogleAccess } from "./google-access-removal.js";
import type { PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";
import { logger } from "../../../middleware/logger.js";

const companyId = "company-1";

function connection(oauth: Record<string, unknown>, authKind = "oauth") {
  return { id: "connection-1", companyId, authKind, config: { oauth } } as never;
}

const managedGoogle = { strategy: "paperclip_cloud_connector", connectorProfile: "workspace.all", connectorSubjectUserId: "org-owner" };

function grant(
  id: string,
  kind: string,
  subject: { subjectUserId?: string; subjectAgentId?: string; consentSubject?: string },
  refreshSecretId = `${id}-refresh`,
) {
  return {
    id, companyId, connectionId: "connection-1", kind,
    subjectUserId: subject.subjectUserId ?? null,
    subjectAgentId: subject.subjectAgentId ?? null,
    providerTenant: subject.consentSubject ? { externalId: subject.consentSubject } : null,
    credentialSecretRefs: [
      { configPath: "oauth.access_token", secretId: `${id}-access` },
      { configPath: "oauth.refresh_token", secretId: refreshSecretId },
    ],
  } as never;
}

type RevokeValues = Parameters<PaperclipCloudConnector["revoke"]>[0];

function connectorWith(revoke: (values: RevokeValues) => Promise<{ outcome?: string }>) {
  return { revoke: vi.fn(revoke) } as unknown as PaperclipCloudConnector & { revoke: ReturnType<typeof vi.fn> };
}

async function run(
  removal: ReturnType<typeof createManagedGoogleAccessRemoval>,
  oauth: Record<string, unknown>,
  grants: never[],
  authKind?: string,
) {
  const prepared = await removal.prepare(connection(oauth, authKind), grants, undefined);
  return prepared ? prepared.send() : null;
}

describe("managed Google access removal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resolveConnectionGrantSecret.mockReset();
    resolveConnectionGrantSecret.mockImplementation(async (_db, _connection, _grant, ref: { secretId: string }) => ({ value: `token-for-${ref.secretId}` }));
  });

  it("revokes per-user, per-agent and organization grants each under the subject that consented", async () => {
    const connector = connectorWith(async () => ({ outcome: "revoked" }));
    const removal = createManagedGoogleAccessRemoval({} as Db, { currentCloudConnector: () => connector });
    await expect(run(removal, managedGoogle, [
      grant("user-grant", "user", { subjectUserId: "user-1", consentSubject: "user-1" }),
      grant("agent-grant", "agent", { subjectAgentId: "agent-1", consentSubject: "agent:agent-1" }),
      grant("org-grant", "organization", { consentSubject: "first-consenter" }),
      grant("old-org-grant", "organization", {}),
    ])).resolves.toEqual({ provider: "google", result: "ended", outcomes: ["revoked", "revoked", "revoked", "revoked"] });
    expect(connector.revoke.mock.calls.map(([values]) => [values.subject, values.token, values.profile])).toEqual([
      ["user-1", "token-for-user-grant-refresh", "workspace.all"],
      ["agent:agent-1", "token-for-agent-grant-refresh", "workspace.all"],
      ["first-consenter", "token-for-org-grant-refresh", "workspace.all"],
      ["org-owner", "token-for-old-org-grant-refresh", "workspace.all"],
    ]);
  });

  it("sends a refresh token shared by two grants once", async () => {
    const connector = connectorWith(async () => ({ outcome: "revoked" }));
    const removal = createManagedGoogleAccessRemoval({} as Db, { currentCloudConnector: () => connector });
    await run(removal, managedGoogle, [
      grant("org-grant", "organization", {}, "shared-refresh"),
      grant("user-grant", "user", { subjectUserId: "org-owner" }, "shared-refresh"),
    ]);
    expect(connector.revoke).toHaveBeenCalledTimes(1);
  });

  it("sends two grants of one subject one after the other and reports access ended once the last one is revoked", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const outcomes = ["other_connections_remain", "revoked"];
    const connector = connectorWith(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { outcome: outcomes.shift() };
    });
    const removal = createManagedGoogleAccessRemoval({} as Db, { currentCloudConnector: () => connector });
    await expect(run(removal, managedGoogle, [
      grant("org-grant", "organization", { consentSubject: "user-1" }),
      grant("user-grant", "user", { subjectUserId: "user-1", consentSubject: "user-1" }),
    ])).resolves.toEqual({ provider: "google", result: "ended", outcomes: ["other_connections_remain", "revoked"] });
    expect(maxInFlight).toBe(1);
    expect(connector.revoke.mock.calls.map(([values]) => values.token)).toEqual([
      "token-for-org-grant-refresh", "token-for-user-grant-refresh",
    ]);
  });

  it.each([
    "binding_not_known", "provider_revocation_failed", "revocation_in_progress",
  ])("keeps a subject's ended access when a later grant of that subject reports %s", async (later) => {
    const outcomes = ["revoked", later];
    const connector = connectorWith(async () => ({ outcome: outcomes.shift() }));
    const removal = createManagedGoogleAccessRemoval({} as Db, { currentCloudConnector: () => connector });
    await expect(run(removal, managedGoogle, [
      grant("a", "user", { consentSubject: "user-1" }),
      grant("b", "organization", { consentSubject: "user-1" }),
    ])).resolves.toMatchObject({ result: "ended" });
  });

  it.each([
    ["a customer-owned Google client", { strategy: "authorization_code", provider: "google" }, "oauth"],
    ["a managed GitHub connection", { strategy: "paperclip_cloud_connector", connectorProfile: "github.code" }, "oauth"],
    ["a non-OAuth connection", managedGoogle, "api_key"],
  ])("makes no broker call for %s", async (_label, oauth, authKind) => {
    const connector = connectorWith(async () => ({ outcome: "revoked" }));
    const removal = createManagedGoogleAccessRemoval({} as Db, { currentCloudConnector: () => connector });
    await expect(run(removal, oauth, [grant("user-grant", "user", { subjectUserId: "user-1" })], authKind)).resolves.toBeNull();
    expect(connector.revoke).not.toHaveBeenCalled();
    expect(resolveConnectionGrantSecret).not.toHaveBeenCalled();
  });

  it("reports access not ended when Paperclip Cloud is not configured or the token is unreadable", async () => {
    resolveConnectionGrantSecret.mockRejectedValueOnce(new Error("missing"));
    const removal = createManagedGoogleAccessRemoval({} as Db, { currentCloudConnector: () => null });
    await expect(run(removal, managedGoogle, [
      grant("user-grant", "user", { subjectUserId: "user-1" }),
      grant("agent-grant", "agent", { subjectAgentId: "agent-1" }),
    ])).resolves.toEqual({ provider: "google", result: "not_ended", outcomes: ["credential_unavailable", "broker_unavailable"] });
  });

  it("reports access not ended when creating the Paperclip Cloud client throws", async () => {
    const removal = createManagedGoogleAccessRemoval({} as Db, {
      currentCloudConnector: () => { throw new Error("instance key is invalid"); },
    });
    await expect(run(removal, managedGoogle, [grant("user-grant", "user", { subjectUserId: "user-1" })]))
      .resolves.toEqual({ provider: "google", result: "not_ended", outcomes: ["broker_unavailable"] });
  });

  it("logs an unexpected failure without the token and reports access not ended", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    const broken = { ...(grant("user-grant", "user", { subjectUserId: "user-1" }) as object) };
    Object.defineProperty(broken, "credentialSecretRefs", { get() { throw new TypeError("token-for-user-grant-refresh"); } });
    const connector = connectorWith(async () => ({ outcome: "revoked" }));
    const removal = createManagedGoogleAccessRemoval({} as Db, { currentCloudConnector: () => connector });
    await expect(run(removal, managedGoogle, [broken as never]))
      .resolves.toEqual({ provider: "google", result: "not_ended", outcomes: ["unexpected_error"] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("token-for-user-grant-refresh");
    expect(connector.revoke).not.toHaveBeenCalled();
  });

  it("bounds all broker calls of one removal by a single deadline", async () => {
    let clock = 0;
    const connector = connectorWith(async (values) => {
      clock += values.timeoutMs ?? 0;
      return { outcome: "other_connections_remain" };
    });
    const removal = createManagedGoogleAccessRemoval({} as Db, { currentCloudConnector: () => connector, timeoutMs: 5_000, now: () => clock });
    await expect(run(removal, managedGoogle, [
      grant("a", "user", { consentSubject: "user-1" }),
      grant("b", "user", { consentSubject: "user-2" }),
    ])).resolves.toEqual({ provider: "google", result: "not_ended", outcomes: ["other_connections_remain", "broker_unavailable"] });
    expect(connector.revoke).toHaveBeenCalledTimes(1);
  });

  it("summarizes subjects toward the least complete result", () => {
    expect(summarizeManagedGoogleAccess([
      { subject: "a", outcome: "revoked" }, { subject: "b", outcome: "other_connections_remain" },
    ]).result).toBe("other_connections_remain");
    expect(summarizeManagedGoogleAccess([
      { subject: "a", outcome: "revoked" }, { subject: "b", outcome: "binding_not_known" },
    ]).result).toBe("not_ended");
    expect(summarizeManagedGoogleAccess([
      { subject: "a", outcome: "other_connections_remain" }, { subject: "a", outcome: "binding_not_known" },
    ]).result).toBe("not_ended");
  });
});

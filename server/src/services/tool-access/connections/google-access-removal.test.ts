import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const resolveConnectionGrantSecret = vi.hoisted(() => vi.fn());
vi.mock("../../connection-credentials.js", () => ({ resolveConnectionGrantSecret }));

import { createManagedGoogleAccessRemoval, summarizeManagedGoogleAccess } from "./google-access-removal.js";
import type { PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";

const companyId = "company-1";

function connection(oauth: Record<string, unknown>, authKind = "oauth") {
  return { id: "connection-1", companyId, authKind, config: { oauth } } as never;
}

const managedGoogle = { strategy: "paperclip_cloud_connector", connectorProfile: "workspace.all", connectorSubjectUserId: "org-owner" };

function grant(id: string, kind: string, subject: { subjectUserId?: string; subjectAgentId?: string }, refreshSecretId = `${id}-refresh`) {
  return {
    id, companyId, connectionId: "connection-1", kind,
    subjectUserId: subject.subjectUserId ?? null,
    subjectAgentId: subject.subjectAgentId ?? null,
    credentialSecretRefs: [
      { configPath: "oauth.access_token", secretId: `${id}-access` },
      { configPath: "oauth.refresh_token", secretId: refreshSecretId },
    ],
  } as never;
}

function connectorWith(revoke: PaperclipCloudConnector["revoke"]) {
  return { revoke: vi.fn(revoke) } as unknown as PaperclipCloudConnector & { revoke: ReturnType<typeof vi.fn> };
}

describe("managed Google access removal", () => {
  beforeEach(() => {
    resolveConnectionGrantSecret.mockReset();
    resolveConnectionGrantSecret.mockImplementation(async (_db, _connection, _grant, ref: { secretId: string }) => ({ value: `token-for-${ref.secretId}` }));
  });

  it("revokes per-user, per-agent and organization grants each with their own subject and token", async () => {
    const connector = connectorWith(async () => ({ outcome: "revoked" }));
    const removal = createManagedGoogleAccessRemoval({} as Db, { currentCloudConnector: () => connector });
    const pending = await removal.begin(connection(managedGoogle), [
      grant("user-grant", "user", { subjectUserId: "user-1" }),
      grant("agent-grant", "agent", { subjectAgentId: "agent-1" }),
      grant("org-grant", "organization", {}),
    ], undefined);
    await expect(pending!.settled).resolves.toEqual({ provider: "google", result: "ended", outcomes: ["revoked", "revoked", "revoked"] });
    expect(connector.revoke.mock.calls.map(([values]) => [values.subject, values.token, values.profile])).toEqual([
      ["user-1", "token-for-user-grant-refresh", "workspace.all"],
      ["agent:agent-1", "token-for-agent-grant-refresh", "workspace.all"],
      ["org-owner", "token-for-org-grant-refresh", "workspace.all"],
    ]);
  });

  it("sends a refresh token shared by two grants once", async () => {
    const connector = connectorWith(async () => ({ outcome: "revoked" }));
    const removal = createManagedGoogleAccessRemoval({} as Db, { currentCloudConnector: () => connector });
    await (await removal.begin(connection(managedGoogle), [
      grant("org-grant", "organization", {}, "shared-refresh"),
      grant("user-grant", "user", { subjectUserId: "org-owner" }, "shared-refresh"),
    ], undefined))!.settled;
    expect(connector.revoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a customer-owned Google client", { strategy: "authorization_code", provider: "google" }, "oauth"],
    ["a managed GitHub connection", { strategy: "paperclip_cloud_connector", connectorProfile: "github.code" }, "oauth"],
    ["a non-OAuth connection", managedGoogle, "api_key"],
  ])("makes no broker call for %s", async (_label, oauth, authKind) => {
    const connector = connectorWith(async () => ({ outcome: "revoked" }));
    const removal = createManagedGoogleAccessRemoval({} as Db, { currentCloudConnector: () => connector });
    await expect(removal.begin(connection(oauth, authKind), [grant("user-grant", "user", { subjectUserId: "user-1" })], undefined)).resolves.toBeNull();
    expect(connector.revoke).not.toHaveBeenCalled();
    expect(resolveConnectionGrantSecret).not.toHaveBeenCalled();
  });

  it("reports access not ended when Paperclip Cloud is not configured or the token is unreadable", async () => {
    resolveConnectionGrantSecret.mockRejectedValueOnce(new Error("missing"));
    const removal = createManagedGoogleAccessRemoval({} as Db, { currentCloudConnector: () => null });
    await expect((await removal.begin(connection(managedGoogle), [
      grant("user-grant", "user", { subjectUserId: "user-1" }),
      grant("agent-grant", "agent", { subjectAgentId: "agent-1" }),
    ], undefined))!.settled).resolves.toEqual({ provider: "google", result: "not_ended", outcomes: ["credential_unavailable", "broker_unavailable"] });
  });

  it("summarizes mixed outcomes toward the least complete result", () => {
    expect(summarizeManagedGoogleAccess(["revoked", "other_connections_remain"]).result).toBe("other_connections_remain");
    expect(summarizeManagedGoogleAccess(["revoked", "provider_revocation_failed"]).result).toBe("not_ended");
    expect(summarizeManagedGoogleAccess(["other_connections_remain", "broker_unavailable"]).result).toBe("not_ended");
  });
});

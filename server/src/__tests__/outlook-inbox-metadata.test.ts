import { describe, expect, it, vi } from "vitest";
import {
  OutlookInboxMetadataError,
  executeOutlookInboxMetadata,
  validateOutlookInboxMetadataConnection,
} from "../services/outlook-inbox-metadata.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";

function fixtureConnection(overrides: Partial<Parameters<typeof executeOutlookInboxMetadata>[0]["connection"]> = {}) {
  return {
    id: connectionId,
    companyId,
    config: { outlookInboxMetadata: { mailbox: "approved@example.test" } },
    credentialSecretRefs: [
      { secretId: "33333333-3333-4333-8333-333333333333", configPath: "oauth.tenant_id", required: true },
      { secretId: "44444444-4444-4444-8444-444444444444", configPath: "oauth.client_id", required: true },
      { secretId: "55555555-5555-4555-8555-555555555555", configPath: "oauth.client_secret", required: true },
    ],
    ...overrides,
  };
}

describe("Outlook Inbox metadata operation", () => {
  it("resolves only the three company-scoped OAuth bindings and sends the fixed token form and Graph route", async () => {
    const resolveSecret = vi.fn(async (_companyId: string, secretId: string, _version: "latest" | number, context: { configPath: string }) => {
      expect(_companyId).toBe(companyId);
      expect(context).toMatchObject({ consumerType: "tool_connection", consumerId: connectionId });
      return new Map([
        ["33333333-3333-4333-8333-333333333333", "tenant-id"],
        ["44444444-4444-4444-8444-444444444444", "client-id"],
        ["55555555-5555-4555-8555-555555555555", "synthetic-client-secret"],
      ]).get(secretId)!;
    });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token") {
        const body = init?.body as URLSearchParams;
        expect([...body.keys()].sort()).toEqual(["client_id", "client_secret", "grant_type", "scope"]);
        expect(Object.fromEntries(body)).toEqual({
          client_id: "client-id",
          client_secret: "synthetic-client-secret",
          grant_type: "client_credentials",
          scope: "https://graph.microsoft.com/.default",
        });
        return new Response(JSON.stringify({ access_token: "synthetic-access-token" }), { status: 200 });
      }
      expect(url).toBe("https://graph.microsoft.com/v1.0/users/approved%40example.test/mailFolders/inbox/messages?$top=1&$select=id,receivedDateTime");
      expect(init).toMatchObject({ method: "GET", headers: { Authorization: "Bearer synthetic-access-token" } });
      return new Response(JSON.stringify({ value: [{ id: "fixture-id", receivedDateTime: "2026-08-05T00:00:00Z", subject: "must not survive" }] }), { status: 200 });
    });
    const storeAccessToken = vi.fn(async () => undefined);

    await expect(executeOutlookInboxMetadata({ connection: fixtureConnection(), resolveSecret, fetch, storeAccessToken })).resolves.toEqual({
      messages: [{ id: "fixture-id", receivedDateTime: "2026-08-05T00:00:00Z" }],
    });
    expect(resolveSecret.mock.calls.map((call) => call[3].configPath).sort()).toEqual([
      "oauth.client_id",
      "oauth.client_secret",
      "oauth.tenant_id",
    ]);
    expect(storeAccessToken).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(resolveSecret.mock.calls)).not.toContain("synthetic-client-secret");
  });

  it("fails closed before dispatch for arbitrary mailbox, input, or credential binding", async () => {
    const fetch = vi.fn();
    const resolveSecret = vi.fn();
    await expect(executeOutlookInboxMetadata({
      connection: fixtureConnection(),
      mailbox: "other@example.test",
      resolveSecret,
      fetch,
    })).rejects.toMatchObject({ code: "outlook_mailbox_not_approved" });
    await expect(executeOutlookInboxMetadata({
      connection: fixtureConnection(),
      parameters: { select: "subject" },
      resolveSecret,
      fetch,
    })).rejects.toMatchObject({ code: "outlook_operation_parameters_forbidden" });
    expect(() => validateOutlookInboxMetadataConnection(fixtureConnection({
      credentialSecretRefs: [{ secretId: "33333333-3333-4333-8333-333333333333", configPath: "oauth.access_token" }],
    }))).toThrow(OutlookInboxMetadataError);
    expect(resolveSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns redacted errors without including secret values or endpoint response bodies", async () => {
    const audit = vi.fn();
    await expect(executeOutlookInboxMetadata({
      connection: fixtureConnection(),
      resolveSecret: async () => "synthetic-client-secret",
      fetch: async () => new Response("token response with synthetic-client-secret", { status: 401 }),
      audit,
    })).rejects.toMatchObject({ code: "outlook_token_exchange_failed", message: "Outlook token exchange failed." });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failure",
      reasonCode: "outlook_token_exchange_failed",
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("synthetic-client-secret");
  });
});

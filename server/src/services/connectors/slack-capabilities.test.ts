import { afterEach, describe, expect, it, vi } from "vitest";
import { chatEndpoints, toolCatalogEntries, type Db } from "@paperclipai/db";
import { slackCapabilities } from "./slack-capabilities.js";

const auth = vi.hoisted(() => vi.fn());
vi.mock("./slack-client.js", () => ({ slackClient: () => auth }));
vi.mock("./slack-catalog.js", async importOriginal => ({
  ...await importOriginal<typeof import("./slack-catalog.js")>(),
  ensureSlackBotCatalogCurrent: vi.fn(async () => undefined),
}));
vi.mock("../secrets.js", () => ({ secretService: () => ({ resolveSecretValue: async () => "test-token" }) }));
afterEach(() => vi.resetAllMocks());

describe("Slack capabilities runtime agreement", () => {
  function fixture(setup: Record<string, unknown> | null, status = "active") {
    const endpoint = { id: "endpoint", companyId: "company", connectionId: "connection", status: "active", setup };
    const db = { select: () => ({ from: (table: unknown) => ({
      innerJoin: () => ({ where: async () => table === toolCatalogEntries
        ? status === "active" ? [{ toolName: "slack_upload_file" }] : []
        : [{ endpoint, connection: { id: "connection", enabled: true,
        credentialSecretRefs: [{ configPath: "credentials.botToken", secretId: "secret" }] } }] }),
      where: async () => {
        if (table === chatEndpoints) return [{ ...endpoint, botExternalId: null }];
        if (table === toolCatalogEntries) return [{ toolName: "slack_upload_file", status, quarantinedAt: null }];
        throw new Error("Unexpected capability query");
      },
    }) }) } as unknown as Db;
    return db;
  }

  it.each(["disabled", "quarantined", "removed"])("does not advertise a %s tool as available", async status => {
    auth.mockResolvedValue({ grantedScopes: ["files:write"] });
    const db = fixture({ slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: ["file_upload"] }, status);
    const result = await slackCapabilities(db, "company", "endpoint");
    expect(result.tools.find(tool => tool.name === "slack_upload_file")?.available).toBe(false);
  });

  it("retains database-derived reconnect guidance when live scopes are unknown", async () => {
    auth.mockResolvedValue({});
    const result = await slackCapabilities(fixture({ slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: [] }), "company", "endpoint");
    expect(result.grantedScopes).toBeNull();
    expect(result.missingGroups?.find(group => group.group === "file_upload")?.action).toBe("reconnect");
  });

  it("handles a null setup without losing enable guidance", async () => {
    auth.mockResolvedValue({ grantedScopes: [] });
    const result = await slackCapabilities(fixture(null), "company", "endpoint");
    expect(result.missingGroups?.find(group => group.group === "file_upload")?.action).toBe("enable");
  });

  describe("dmReconnectRequired", () => {
    it("reports dmReconnectRequired=false when im:write is present in grantedScopes", async () => {
      auth.mockResolvedValue({ grantedScopes: ["chat:write", "im:write"] });
      const result = await slackCapabilities(fixture({}), "company", "endpoint");
      expect(result.dmReconnectRequired).toBe(false);
    });

    it("reports dmReconnectRequired=true when im:write is absent from grantedScopes", async () => {
      auth.mockResolvedValue({ grantedScopes: ["chat:write"] });
      const result = await slackCapabilities(fixture({}), "company", "endpoint");
      expect(result.dmReconnectRequired).toBe(true);
    });

    it("reports dmReconnectRequired=false when live scopes are null / unknown", async () => {
      auth.mockResolvedValue({});
      const result = await slackCapabilities(fixture({}), "company", "endpoint");
      expect(result.grantedScopes).toBeNull();
      expect(result.dmReconnectRequired).toBe(false);
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { toolConnections } from "@paperclipai/db";
import { APP_DEFINITIONS } from "@paperclipai/shared";
import { configuredOAuthClientForConnection } from "./client-settings.js";

type Connection = typeof toolConnections.$inferSelect;

function connection(config: Record<string, unknown>): Connection {
  return {
    id: "connection-1",
    companyId: "company-1",
    transport: "mcp_remote",
    config,
    transportConfig: {},
    credentialSecretRefs: [],
  } as unknown as Connection;
}

const slack = (oauth: Record<string, unknown> = {}) =>
  connection({ sourceTemplateKey: "slack", connectionMethodKey: "mcp-oauth", oauth });
const generic = (oauth: Record<string, unknown> = {}) =>
  connection({ url: "https://mcp.example.test/mcp", oauth });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("instance OAuth clients", () => {
  it("uses the instance client only at the token endpoint its app definition fixes", () => {
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_ID", "instance-slack-id");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_SECRET", "instance-slack-secret");

    expect(configuredOAuthClientForConnection(slack(), "slack", "https://slack.com/api/oauth.v2.user.access")).toMatchObject({
      clientId: "instance-slack-id",
      clientSecret: "instance-slack-secret",
    });
  });

  it.each([
    ["a different host", "https://attacker.example/token"],
    ["a lookalike path on the vendor host", "https://slack.com/api/oauth.v2.user.access/../../collect"],
    ["plain http on the vendor host", "http://slack.com/api/oauth.v2.user.access"],
    ["a vendor subdomain", "https://evil.slack.com/api/oauth.v2.user.access"],
    ["no token endpoint", null],
  ])("never returns the instance secret for %s", (_label, tokenUrl) => {
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_ID", "instance-slack-id");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_SECRET", "instance-slack-secret");

    const client = configuredOAuthClientForConnection(slack({ tokenUrl }), "slack", tokenUrl);
    expect(client.clientId).toBeNull();
    expect(client.clientSecret).toBeNull();
  });

  it("never gives a custom connection the instance client of a provider it names", () => {
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_ID", "instance-slack-id");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_SECRET", "instance-slack-secret");

    const client = configuredOAuthClientForConnection(
      generic({ provider: "slack", tokenUrl: "https://attacker.example/token" }),
      "slack",
      "https://attacker.example/token",
    );
    expect(client.clientId).toBeNull();
    expect(client.clientSecret).toBeNull();
  });

  it("never gives a custom connection the unsuffixed instance client", () => {
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_ID", "instance-generic-id");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET", "instance-generic-secret");

    const client = configuredOAuthClientForConnection(generic(), "mcp_example_test", "https://mcp.example.test/token");
    expect(client.clientId).toBeNull();
    expect(client.clientSecret).toBeNull();
  });

  it("never gives a custom server a host-named instance client, even at that host", () => {
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_MCP_EXAMPLE_TEST_CLIENT_ID", "instance-host-id");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_MCP_EXAMPLE_TEST_CLIENT_SECRET", "instance-host-secret");

    expect(configuredOAuthClientForConnection(generic(), "mcp_example_test", "https://mcp.example.test/oauth/token").clientId).toBeNull();
    const lookalike = connection({ url: "https://mcp-example.test/mcp", oauth: {} });
    expect(configuredOAuthClientForConnection(lookalike, "mcp_example_test", "https://mcp-example.test/oauth/token").clientId).toBeNull();
  });

  it.each(["", " ", " slack"])("never treats the gallery marker %j as an app definition", (marker) => {
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_ID", "instance-generic-id");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET", "instance-generic-secret");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_ID", "instance-slack-id");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_SLACK_CLIENT_SECRET", "instance-slack-secret");
    const marked = connection({ sourceTemplateKey: marker, url: "https://attacker.example/mcp", oauth: {} });

    for (const provider of [marker, "slack", "attacker_example"]) {
      const client = configuredOAuthClientForConnection(marked, provider, "https://attacker.example/token");
      expect(client.clientId).toBeNull();
      expect(client.clientSecret).toBeNull();
    }
    expect(configuredOAuthClientForConnection(marked, "slack", "https://slack.com/api/oauth.v2.user.access").clientId).toBeNull();
  });

  it("never uses one app's instance client for a connection that claims another provider", () => {
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_GMAIL_CLIENT_ID", "instance-gmail-id");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_GMAIL_CLIENT_SECRET", "instance-gmail-secret");

    const client = configuredOAuthClientForConnection(
      slack({ provider: "gmail" }),
      "gmail",
      "https://oauth2.googleapis.com/token",
    );
    expect(client.clientId).toBeNull();
    expect(client.clientSecret).toBeNull();
  });

  it("allows a discovered token endpoint only on a host the definition fixes when it fixes no token endpoint", () => {
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_NOTION_CLIENT_ID", "instance-notion-id");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_NOTION_CLIENT_SECRET", "instance-notion-secret");
    const notion = connection({ sourceTemplateKey: "notion", connectionMethodKey: "mcp-oauth" });

    expect(configuredOAuthClientForConnection(notion, "notion", "https://mcp.notion.com/token").clientId).toBe("instance-notion-id");
    for (const tokenUrl of [
      "https://api.notion.com/v1/oauth/token",
      "https://evil.notion.com/token",
      "https://mcp.notion.com:8443/token",
      "https://attacker.example/token",
    ]) {
      expect(configuredOAuthClientForConnection(notion, "notion", tokenUrl).clientId).toBeNull();
    }
  });

  it.each([
    ["asana", "mcp-own-oauth", "https://app.asana.com/-/oauth_token"],
    ["railway", "mcp-oauth", "https://backboard.railway.com/oauth/token"],
  ])("allows the token endpoint that the %s definition pins", (slug, methodKey, tokenUrl) => {
    vi.stubEnv(`PAPERCLIP_TOOL_OAUTH_${slug.toUpperCase()}_CLIENT_ID`, "instance-id");
    vi.stubEnv(`PAPERCLIP_TOOL_OAUTH_${slug.toUpperCase()}_CLIENT_SECRET`, "instance-secret");
    const pinned = connection({ sourceTemplateKey: slug, connectionMethodKey: methodKey });

    expect(configuredOAuthClientForConnection(pinned, slug, tokenUrl).clientId).toBe("instance-id");
    expect(configuredOAuthClientForConnection(pinned, slug, "https://attacker.example/token").clientId).toBeNull();
  });

  it("makes every customer OAuth method pin its token endpoint or name its same-host fallback", () => {
    const sameHostFallback = new Set(["box:mcp-own-oauth", "notion:mcp-oauth", "posthog:mcp-oauth", "sentry:mcp-oauth", "xero:mcp-own-oauth"]);
    const noFixedEndpoint = new Set(["oauth-generic:oauth"]);
    const unpinned = APP_DEFINITIONS.flatMap((app) => app.methods
      .filter((method) => method.auth === "oauth" && !method.oauthStrategy && method.ownershipModes.includes("customer")
        && method.purpose !== "ai" && method.transport !== "runtime_auth" && !method.defaults?.tokenEndpoint)
      .map((method) => `${app.slug}:${method.key}`));
    expect(unpinned.sort()).toEqual([...sameHostFallback, ...noFixedEndpoint].sort());
  });
});

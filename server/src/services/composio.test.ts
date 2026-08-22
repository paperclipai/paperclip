import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ComposioApiError, createComposioClient } from "./composio.js";

type Fixture = {
  baseUrl: string;
  requests: Array<{ method: string; url: string; apiKey: string | undefined }>;
  close(): Promise<void>;
};

async function startFixture(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Fixture> {
  const requests: Fixture["requests"] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      apiKey: Array.isArray(request.headers["x-api-key"])
        ? request.headers["x-api-key"]?.[0]
        : request.headers["x-api-key"],
    });
    handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v3.1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("Composio REST client", () => {
  it("serializes every supported REST operation", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ items: [], session_id: "session-1", mcp: { url: "https://mcp.test" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = createComposioClient({
      apiKey: "ak_fixture",
      baseUrl: "https://composio.test/api/v3.1",
      fetch: fetchMock,
    });

    await client.listAuthConfigs({
      cursor: "auth-page",
      limit: 25,
      toolkitSlugs: ["github", "slack"],
      showDisabled: true,
    });
    await client.createConnectLink({
      authConfigId: "ac_1",
      userId: "user-1",
      alias: "primary",
      callbackUrl: "https://paperclip.test/callback",
    });
    await client.listConnectedAccounts({
      cursor: "account-page",
      limit: 10,
      toolkitSlugs: ["github", "slack"],
      statuses: ["ACTIVE", "EXPIRED"],
      userIds: ["user-1", "user-2"],
      authConfigIds: ["ac_1", "ac_2"],
    });
    await client.createSession("user-1", {
      mcp: true,
      toolkits: ["github"],
      tools: { github: { enable: ["GITHUB_LIST_REPOS"] } },
      authConfigs: { github: "ac_1" },
      connectedAccounts: { github: ["ca_1"] },
    });
    await client.resumeSession("session/with spaces", { mcp: true });

    expect(requests).toEqual([
      {
        url: "https://composio.test/api/v3.1/auth_configs?cursor=auth-page&limit=25&show_disabled=true&toolkit_slug=github%2Cslack",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://composio.test/api/v3.1/connected_accounts/link",
        method: "POST",
        body: {
          auth_config_id: "ac_1",
          user_id: "user-1",
          alias: "primary",
          callback_url: "https://paperclip.test/callback",
        },
      },
      {
        url: "https://composio.test/api/v3.1/connected_accounts?cursor=account-page&limit=10&toolkit_slugs=github&toolkit_slugs=slack&statuses=ACTIVE&statuses=EXPIRED&user_ids=user-1&user_ids=user-2&auth_config_ids=ac_1&auth_config_ids=ac_2",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://composio.test/api/v3.1/tool_router/session",
        method: "POST",
        body: {
          user_id: "user-1",
          toolkits: { enabled: ["github"] },
          tools: { github: { enable: ["GITHUB_LIST_REPOS"] } },
          auth_configs: { github: "ac_1" },
          connected_accounts: { github: ["ca_1"] },
        },
      },
      {
        url: "https://composio.test/api/v3.1/tool_router/session/session%2Fwith%20spaces/attach",
        method: "POST",
        body: {},
      },
    ]);
  });

  it("validates an API key with the cheap toolkit-list call", async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: [] }));
    });
    fixtures.push(fixture);

    const client = createComposioClient({ apiKey: "ak_fixture", baseUrl: fixture.baseUrl });
    await expect(client.validateApiKey()).resolves.toBeUndefined();

    expect(fixture.requests).toEqual([{
      method: "GET",
      url: "/api/v3.1/toolkits?limit=1",
      apiKey: "ak_fixture",
    }]);
  });

  it("rejects an invalid key without reflecting the provider response body", async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "provider-controlled secret detail" }));
    });
    fixtures.push(fixture);

    const client = createComposioClient({ apiKey: "bad_fixture", baseUrl: fixture.baseUrl });
    const error = await client.validateApiKey().catch((caught) => caught);

    expect(error).toBeInstanceOf(ComposioApiError);
    expect(error).toMatchObject({ status: 401, message: "Composio rejected the API key." });
    expect(String(error)).not.toContain("provider-controlled");
  });

  it("lists typed toolkits from the project behind the key", async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        items: [{
          slug: "github",
          name: "GitHub",
          auth_schemes: ["oauth2"],
          meta: { tools_count: 42, logo: "https://example.test/github.png" },
        }],
        next_cursor: "next-page",
      }));
    });
    fixtures.push(fixture);

    const client = createComposioClient({ apiKey: "ak_fixture", baseUrl: fixture.baseUrl });
    const result = await client.listToolkits({ limit: 10, cursor: "page-1" });

    expect(result).toEqual({
      items: [{
        slug: "github",
        name: "GitHub",
        auth_schemes: ["oauth2"],
        meta: { tools_count: 42, logo: "https://example.test/github.png" },
      }],
      next_cursor: "next-page",
    });
    expect(fixture.requests[0]?.url).toBe("/api/v3.1/toolkits?cursor=page-1&limit=10");
  });
});

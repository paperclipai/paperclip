import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "./fixtures/fake-google.js";
import { FULL_MESSAGE } from "./gmail/fixtures/gmail-rest.js";
import { GOOGLE_AUTH_ERROR_CODE, callGoogleWorkspaceRestTool, createGoogleWorkspaceRestServer, GoogleWorkspaceAuthError } from "./index.js";

async function connect(route: Parameters<typeof fakeGoogle>[0], token?: string) {
  const fake = fakeGoogle(route);
  const server = createGoogleWorkspaceRestServer("gmail", { fetch: fake.fetch });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => send(message, { ...options, ...(token ? { authInfo: { token, clientId: "test", scopes: [] } } : {}) });
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientTransport);
  return { client, calls: fake.calls };
}

describe("MCP server", () => {
  it("lists the service's tools with input and output schemas", async () => {
    const { client } = await connect(() => json({}));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["get_message", "search_threads", "create_draft"]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
    }
  });

  it("calls a tool with the bearer token from the transport", async () => {
    const { client, calls } = await connect(() => json(FULL_MESSAGE), "user-token");
    const result = await client.callTool({ name: "get_message", arguments: { messageId: FULL_MESSAGE.id } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { subject: string }).subject).toBe("Quarterly plan");
    expect(calls[0]!.headers.authorization).toBe("Bearer user-token");
  });

  it("answers a missing token and a refused token with a JSON-RPC auth error", async () => {
    const missing = await connect(() => json(FULL_MESSAGE));
    await expect(missing.client.callTool({ name: "get_message", arguments: { messageId: "x1" } }))
      .rejects.toMatchObject({ code: GOOGLE_AUTH_ERROR_CODE, data: { code: "unauthenticated", httpStatus: 401 } });

    const scoped = await connect(() => json({ error: { details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403), "narrow-token");
    const error = await scoped.client.callTool({ name: "get_message", arguments: { messageId: "x1" } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: GOOGLE_AUTH_ERROR_CODE, data: { code: "insufficient_scope", httpStatus: 403 } });
  });
});

describe("callGoogleWorkspaceRestTool", () => {
  it("is the in-process equivalent of tools/call", async () => {
    const { fetch } = fakeGoogle(() => json(FULL_MESSAGE));
    const result = await callGoogleWorkspaceRestTool({ service: "gmail", name: "get_message", arguments: { messageId: FULL_MESSAGE.id, messageFormat: "MINIMAL" }, accessToken: "t", fetch });
    expect(result.structuredContent).toMatchObject({ id: FULL_MESSAGE.id, subject: "Quarterly plan" });
  });

  it("throws for an unknown tool and for a refused token", async () => {
    const { fetch } = fakeGoogle(() => json({}, 401));
    await expect(callGoogleWorkspaceRestTool({ service: "gmail", name: "send_message", accessToken: "t", fetch })).rejects.toThrow(/Unknown tool/);
    await expect(callGoogleWorkspaceRestTool({ service: "gmail", name: "get_message", arguments: { messageId: "x1" }, accessToken: "t", fetch }))
      .rejects.toBeInstanceOf(GoogleWorkspaceAuthError);
  });
});

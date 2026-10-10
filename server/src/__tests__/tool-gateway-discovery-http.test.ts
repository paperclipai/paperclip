import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectionGrants, createDb, toolMcpGatewayTokens, toolPolicies, startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import { createListingFixture } from "./helpers/tool-gateway-listing-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("MCP discovery over HTTP", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-discovery-http-");
    db = createDb(temp.connectionString);
  });
  afterAll(async () => { await temp?.cleanup(); });

  it("finishes an admitted provider call when token cleanup runs during dispatch", async () => {
    const fixture = await createListingFixture(db, 6);
    await db.insert(connectionGrants).values({ companyId: fixture.company.id, connectionId: fixture.connection.id,
      kind: "organization", status: "active", isDefault: true });
    let calls = 0;
    const gateway = createToolGatewayService(db, { remoteHttpRequest: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "tools/call") {
        calls += 1;
        await db.update(toolMcpGatewayTokens).set({ expiresAt: new Date(Date.now() - 1) })
          .where(eq(toolMcpGatewayTokens.id, fixture.token.id));
        await gateway.cleanupExpiredSessions();
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
        : { content: [{ type: "text", text: "fixture result" }] } }), { headers: { "content-type": "application/json" } });
    } });
    const { tools } = await gateway.listToolsForNamedGateway({ gatewayId: fixture.namedGateway.id, bearerToken: fixture.token.token });
    const tool = tools.find((entry) => entry.catalogEntryId === fixture.entries[4]!.id)!;
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(gateway));
    const post = () => request(app).post(`/mcp/gateways/${fixture.namedGateway.gatewayPublicId}`)
      .set("Authorization", `Bearer ${fixture.token.token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: {} } });
    const response = await post();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(calls).toBe(1);
    await post().expect(401);
    expect(calls).toBe(1);
  });

  it("discovers a large catalog concurrently, calls a tool, and rechecks changed policy", async () => {
    const fixture = await createListingFixture(db, 500);
    await db.insert(connectionGrants).values({
      companyId: fixture.company.id, connectionId: fixture.connection.id,
      kind: "organization", status: "active", isDefault: true,
    });
    const calls: string[] = [];
    const gateway = createToolGatewayService(db, {
      remoteHttpRequest: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (body.method === "tools/call") calls.push(body.params.name);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id,
          result: body.method === "initialize"
            ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
            : { content: [{ type: "text", text: "fixture result" }] },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(gateway));
    const url = `/mcp/gateways/${fixture.namedGateway.gatewayPublicId}`;
    const post = (method: string, params?: unknown) => request(app).post(url)
      .set("Authorization", `Bearer ${fixture.token.token}`)
      .send({ jsonrpc: "2.0", id: 1, method, params });
    await post("initialize").expect(200);
    await request(app).get(url).set("Accept", "text/event-stream").expect("Allow", "POST").expect(405);
    const listings = await Promise.all(Array.from({ length: 16 }, () => post("tools/list").expect(200)));
    const tools = listings[0]!.body.result.tools as Array<{ name: string; description: string }>;
    expect(listings.every((response) => JSON.stringify(response.body.result.tools) === JSON.stringify(tools))).toBe(true);
    const { tools: descriptors } = await gateway.listToolsForNamedGateway({ gatewayId: fixture.namedGateway.id, bearerToken: fixture.token.token });
    expect(descriptors.filter((tool) => tool.connectionId === fixture.connection.id)).toHaveLength(498);
    const readName = descriptors.find((tool) => tool.catalogEntryId === fixture.entries[4]!.id)!.name;
    const read = tools.find((tool) => tool.name === readName)!;
    expect(read).toBeDefined();
    const called = await post("tools/call", { name: read.name, arguments: {} });
    expect(called.status, JSON.stringify(called.body)).toBe(200);
    expect(calls).toEqual(["tool_0004"]);
    await db.insert(toolPolicies).values({
      companyId: fixture.company.id, name: `Revoke ${randomUUID()}`, policyType: "block", priority: 0,
      selectors: { catalogEntryId: fixture.entries[4]!.id },
    });
    await post("tools/call", { name: read.name, arguments: {} }).expect(403);
    expect(calls).toHaveLength(1);
    const after = await post("tools/list").expect(200);
    expect(after.body.result.tools.some((tool: { name: string }) => tool.name === read.name)).toBe(false);
  });
});

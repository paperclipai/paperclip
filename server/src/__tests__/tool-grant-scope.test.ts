import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { connectionGrants, createDb, principalPermissionGrants, toolPolicies, toolProfiles, startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "@paperclipai/db";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import { createListingFixture } from "./helpers/tool-gateway-listing-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("tool grant restrictions", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-grant-scope-");
    db = createDb(temp.connectionString);
  });
  afterAll(async () => { await temp?.cleanup(); });

  it.each([
    { name: "exact tool", scope: { allow: ["tool:tool_0004"] }, allowed: true },
    { name: "other tool", scope: { allow: ["tool:tool_0005"] }, allowed: false },
    { name: "empty allow list", scope: { allow: [] }, allowed: false },
    { name: "malformed allow list", scope: { allow: [42] }, allowed: false },
    { name: "unknown selector", scope: { unsupported: true }, allowed: false },
    { name: "empty selector list", scope: { toolNames: [] }, allowed: false },
    { name: "exact selector", scope: { toolName: "tool_0004" }, allowed: true },
    { name: "other selector", scope: { toolName: "tool_0005" }, allowed: false },
    { name: "combined mismatch", scope: { allow: ["tool:tool_0004"], toolName: "tool_0005" }, allowed: false },
    { name: "unknown combined selector", scope: { allow: ["tool:tool_0004"], unsupported: true }, allowed: false },
    { name: "unrestricted empty scope", scope: {}, allowed: true },
    { name: "unrestricted null scope", scope: null, allowed: true },
    { name: "invalid scope array", scope: [] as unknown as Record<string, unknown>, allowed: false },
    { name: "invalid scope number", scope: 42 as unknown as Record<string, unknown>, allowed: false },
    { name: "invalid scope boolean", scope: false as unknown as Record<string, unknown>, allowed: false },
  ])("enforces $name", async ({ scope, allowed }) => {
    const fixture = await createListingFixture(db, 6);
    await db.update(principalPermissionGrants).set({ scope }).where(eq(principalPermissionGrants.principalId, fixture.agent.id));
    const result = await toolAccessPolicyService(db).decide({
      companyId: fixture.company.id,
      actor: { actorType: "agent", actorId: fixture.agent.id, agentId: fixture.agent.id },
      runContext: { heartbeatRunId: fixture.run.id },
      request: { connectionId: fixture.connection.id, catalogEntryId: fixture.entries[4]!.id, toolName: "tool_0004" },
    });
    expect(result.allowed).toBe(allowed);
  });

  it("lists and calls only granted tools through the HTTP gateway, then observes revocation", async () => {
    const fixture = await createListingFixture(db, 6);
    await db.update(toolProfiles).set({ defaultAction: "deny" }).where(eq(toolProfiles.id, fixture.namedGateway.profileId));
    await db.delete(toolPolicies).where(eq(toolPolicies.companyId, fixture.company.id));
    await db.update(principalPermissionGrants).set({ scope: { allow: ["tool:tool_0004"] } })
      .where(eq(principalPermissionGrants.principalId, fixture.agent.id));
    await db.insert(connectionGrants).values({ companyId: fixture.company.id, connectionId: fixture.connection.id,
      kind: "organization", status: "active", isDefault: true });
    const calls: string[] = [];
    const service = createToolGatewayService(db, { remoteHttpRequest: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "tools/call") calls.push(body.params.name);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
        : { content: [{ type: "text", text: "fixture result" }] } }), { headers: { "content-type": "application/json" } });
    } });
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(service));
    const post = (method: string, params?: unknown) => request(app).post(`/mcp/gateways/${fixture.namedGateway.gatewayPublicId}`)
      .set("Authorization", `Bearer ${fixture.token.token}`).send({ jsonrpc: "2.0", id: 1, method, params });
    const names = await service.listToolsForNamedGateway({ gatewayId: fixture.namedGateway.id, bearerToken: fixture.token.token });
    const granted = names.filter((entry) => entry.connectionId === fixture.connection.id);
    expect(granted.map((entry) => entry.catalogEntryId)).toEqual([fixture.entries[4]!.id]);
    const listing = await post("tools/list").expect(200);
    expect(listing.body.result.tools.some((entry: { name: string }) => entry.name === granted[0]!.name)).toBe(true);
    await post("tools/call", { name: granted[0]!.name, arguments: {} }).expect(200);
    expect(calls).toEqual(["tool_0004"]);
    await db.update(principalPermissionGrants).set({ scope: { allow: ["tool:tool_0005"] } })
      .where(eq(principalPermissionGrants.principalId, fixture.agent.id));
    await post("tools/call", { name: granted[0]!.name, arguments: {} }).expect(403);
    expect(calls).toHaveLength(1);
  });
});

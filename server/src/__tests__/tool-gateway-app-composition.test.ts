import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  toolProfiles,
} from "@paperclipai/db";
import type { Express } from "express";
import { createApp } from "../app.js";
import type { StorageService } from "../storage/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * Regression coverage for the gateway/auth composition, exercised through the
 * real exported `createApp` rather than a bare gateway router. The
 * defect only existed in the wired app — `actorMiddleware` is mounted globally
 * there and used to consume every bearer credential before the named-gateway
 * and tool-session routes could validate their own `pcgw_`/`pcgt_` tokens.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const ACTOR_TOKEN_401 = "Agent token did not verify; obtain fresh credentials and retry";

const storageService: StorageService = {
  provider: "local_disk",
  putFile: async () => {
    throw new Error("storage is not used by this test");
  },
  getObject: async () => {
    throw new Error("storage is not used by this test");
  },
  headObject: async () => ({ exists: false }),
  deleteObject: async () => undefined,
};

/**
 * Supertest binds an ephemeral IPv6 loopback listener, so the Host header
 * arrives as `[::1]:<port>` and the private-hostname guard — mounted ahead of
 * the actor middleware in the real composition — would answer 403 before any
 * authentication runs. Pin a loopback Host so every request under test reaches
 * the authentication boundary it is about.
 */
function get(app: Express, path: string) {
  return request(app).get(path).set("host", "127.0.0.1");
}

function post(app: Express, path: string) {
  return request(app).post(path).set("host", "127.0.0.1");
}

async function buildApp(db: Db, deploymentMode: "local_trusted" | "authenticated"): Promise<Express> {
  return createApp(db, {
    uiMode: "none",
    serverPort: 0,
    storageService,
    deploymentMode,
    deploymentExposure: "private",
    allowedHostnames: ["127.0.0.1"],
    bindHost: "127.0.0.1",
    authReady: deploymentMode === "authenticated",
    companyDeletionEnabled: false,
    decisionServiceOptions: { wakeOriginAgent: async () => undefined },
  }) as unknown as Promise<Express>;
}

describeEmbeddedPostgres("tool gateway authentication in the real app composition", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let localApp!: Express;
  let authenticatedApp!: Express;
  let companyId!: string;
  let profileId!: string;
  let agentId!: string;
  let runId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-gateway-composition-");
    db = createDb(tempDb.connectionString);
    localApp = await buildApp(db, "local_trusted");
    authenticatedApp = await buildApp(db, "authenticated");

    const company = await db
      .insert(companies)
      .values({ name: `Gateway ${randomUUID()}`, issuePrefix: `GC${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
    const profile = await db
      .insert(toolProfiles)
      .values({
        companyId,
        profileKey: `composition-${randomUUID()}`,
        name: `Composition profile ${randomUUID()}`,
        defaultAction: "deny",
      })
      .returning()
      .then((rows) => rows[0]!);
    profileId = profile.id;
    const agent = await db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    agentId = agent.id;
    const project = await db
      .insert(projects)
      .values({ companyId, name: `Project ${randomUUID()}` })
      .returning()
      .then((rows) => rows[0]!);
    const issue = await db
      .insert(issues)
      .values({
        companyId,
        projectId: project.id,
        title: `Composition issue ${randomUUID()}`,
        status: "in_progress",
        assigneeAgentId: agentId,
      })
      .returning()
      .then((rows) => rows[0]!);
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: { issueId: issue.id, projectId: project.id },
      })
      .returning()
      .then((rows) => rows[0]!);
    runId = run.id;
  }, 120_000);

  afterAll(async () => {
    await (localApp?.locals as { paperclipShutdown?: () => Promise<void> } | undefined)?.paperclipShutdown?.();
    await (authenticatedApp?.locals as { paperclipShutdown?: () => Promise<void> } | undefined)?.paperclipShutdown?.();
    await tempDb?.cleanup();
  });

  /** Mints a named gateway plus a client token through the real HTTP API. */
  async function mintNamedGateway() {
    const gateway = await post(localApp, `/api/companies/${companyId}/tools/gateways`)
      .send({ name: `External reader ${randomUUID().slice(0, 8)}`, profileId })
      .expect(201);
    const token = await post(localApp, `/api/tool-gateway/gateways/${gateway.body.id}/tokens`)
      .send({
        companyId,
        name: "Cursor",
        clientLabel: "Cursor desktop",
        ownerNote: "composition regression fixture",
      })
      .expect(201);
    expect(token.body.token).toMatch(/^pcgw_[0-9a-f-]{36}\./);
    return { gateway: gateway.body as { id: string; gatewayPublicId: string }, token: token.body.token as string };
  }

  /** Mints a tool-gateway session token through the real HTTP API. */
  async function mintSessionToken() {
    const session = await post(localApp, "/api/tool-gateway/sessions")
      .send({ companyId, agentId, runId })
      .expect(201);
    expect(session.body.token).toMatch(/^pcgt_[0-9a-f-]{36}\./);
    return session.body.token as string;
  }

  it("initializes a named MCP gateway with a product-minted pcgw_ bearer on both endpoints", async () => {
    const { gateway, token } = await mintNamedGateway();

    const publicIdInitialize = await post(localApp, `/mcp/gateways/${gateway.gatewayPublicId}`)
      .set("authorization", `Bearer ${token}`)
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa", version: "1" } },
      })
      .expect(200);
    expect(publicIdInitialize.body.result.serverInfo.name).toBe("Paperclip MCP Gateway");

    const idInitialize = await post(localApp, `/api/tool-gateway/gateways/${gateway.id}/mcp`)
      .set("authorization", `Bearer ${token}`)
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa", version: "1" } },
      })
      .expect(200);
    expect(idInitialize.body.result.serverInfo.name).toBe("Paperclip MCP Gateway");

    // tools/list is the other client-visible protocol method: the gateway
    // profile denies everything, so an empty tool list still proves the
    // credential reached route-owned validation.
    const listed = await post(localApp, `/mcp/gateways/${gateway.gatewayPublicId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 3, method: "tools/list" })
      .expect(200);
    expect(listed.body.result.tools).toEqual([]);
  });

  it("returns the gateway diagnostic shape for an invalid named-gateway credential", async () => {
    const { gateway } = await mintNamedGateway();
    const bogus = `pcgw_${randomUUID()}.notasecret`;

    for (const [label, path] of [
      ["public id", `/mcp/gateways/${gateway.gatewayPublicId}`],
      ["internal id", `/api/tool-gateway/gateways/${gateway.id}/mcp`],
    ] as const) {
      const res = await post(authenticatedApp, path)
        .set("authorization", `Bearer ${bogus}`)
        .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
        .expect(401);
      expect(res.body.error?.data?.reasonCode, label).toBe("gateway_token_invalid");
      expect(JSON.stringify(res.body), label).not.toContain(ACTOR_TOKEN_401);
    }
  });

  it("lists tools for a product-minted pcgt_ session over both supported transports", async () => {
    const sessionToken = await mintSessionToken();

    const viaHeader = await get(authenticatedApp, "/api/tool-gateway/tools")
      .set("x-paperclip-tool-gateway-token", sessionToken)
      .expect(200);
    expect(Array.isArray(viaHeader.body)).toBe(true);

    const viaBearer = await get(authenticatedApp, "/api/tool-gateway/tools")
      .set("authorization", `Bearer ${sessionToken}`)
      .expect(200);
    expect(viaBearer.body).toEqual(viaHeader.body);

    const revokedSession = `pcgt_${randomUUID()}.notasecret`;
    const rejected = await get(authenticatedApp, "/api/tool-gateway/tools")
      .set("authorization", `Bearer ${revokedSession}`)
      .expect(401);
    expect(rejected.body.reasonCode).toBe("session_invalid");
  });

  it("still fails an unrelated invalid bearer in global actor authentication", async () => {
    const bogus = `pcgw_${randomUUID()}.notasecret`;

    const normalRoute = await get(authenticatedApp, "/api/companies")
      .set("authorization", `Bearer ${bogus}`)
      .expect(401);
    expect(normalRoute.body.error).toBe(ACTOR_TOKEN_401);

    // Management endpoints are not on the route-owned allowlist: the bearer is
    // still consumed and rejected globally, before any handler runs.
    for (const [method, path] of [
      ["post", "/api/tool-gateway/sessions"],
      ["post", `/api/tool-gateway/gateways/${randomUUID()}/tokens`],
      ["post", `/api/tool-gateway/sessions/${randomUUID()}/revoke`],
      ["post", `/api/tool-gateway/action-requests/${randomUUID()}/approve`],
      ["get", "/api/tool-gateway/audit"],
      ["get", "/api/tool-gateway/runtime-slots"],
    ] as const) {
      const res = await (method === "get"
        ? get(authenticatedApp, path).set("authorization", `Bearer ${bogus}`)
        : post(authenticatedApp, path).set("authorization", `Bearer ${bogus}`).send({ companyId }));
      expect(res.status, path).toBe(401);
      expect(res.body.error, path).toBe(ACTOR_TOKEN_401);
    }
  });

  it("keeps management endpoints authenticated when no credential is supplied", async () => {
    const unauthenticated = await post(authenticatedApp, "/api/tool-gateway/sessions")
      .send({ companyId, agentId, runId });
    expect(unauthenticated.status).toBe(403);
    expect(unauthenticated.body.error).not.toBe(ACTOR_TOKEN_401);
  });
});

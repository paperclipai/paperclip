import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, companyMemberships, createDb, toolConnections, toolOauthStates } from "@paperclipai/db";
import { and, eq, ne } from "drizzle-orm";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("cancelling an unfinished first sign-in", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let keyDir: string;
  let provider: Server;
  let origin: string;
  let holdToken: Promise<void> | null = null;
  let tokenRequested: (() => void) | null = null;

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "tool-cancelled-sign-in-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "http://127.0.0.1:3100");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_ID", "");
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET", "");
    fixture = await startEmbeddedPostgresTestDatabase("tool-cancelled-sign-in-");
    db = createDb(fixture.connectionString);
    provider = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const path = new URL(req.url!, origin).pathname;
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (path.startsWith("/.well-known/oauth-protected-resource")) return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      if (path === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["tools.write", "offline_access"],
          grant_types_supported: ["authorization_code", "refresh_token"],
        });
      }
      if (path === "/register") return json({ ...JSON.parse(body), client_id: "fixture-client" });
      if (path === "/token") {
        if (holdToken) { tokenRequested?.(); await holdToken; }
        return json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, token_type: "Bearer", scope: "tools.write offline_access" });
      }
      if (path === "/mcp") {
        if (req.headers.authorization !== "Bearer fixture-access") {
          res.setHeader("www-authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
          return json({}, 401);
        }
        const rpc = JSON.parse(body);
        if (rpc.method === "notifications/initialized") { res.writeHead(202).end(); return; }
        return json({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
          : { tools: [{ name: "read_fixture", description: "Read", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] } });
      }
      json({}, 404);
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => provider?.close(() => resolve()));
    await fixture?.cleanup();
    vi.unstubAllEnvs();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  async function setup(grantKind: "organization" | "user" = "organization", source: "local_implicit" | "session" = "local_implicit") {
    const userId = `cancel-user-${randomUUID()}`;
    const [company] = await db.insert(companies).values({ name: "Cancelled sign-in", issuePrefix: `C${randomUUID().slice(0, 5)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "admin" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = source === "local_implicit"
        ? { type: "board", userId, source, isInstanceAdmin: true }
        : { type: "board", userId, source, isInstanceAdmin: false, companyIds: [company.id],
          memberships: [{ companyId: company.id, membershipRole: "admin", status: "active" }] };
      next();
    });
    app.use("/api", toolAccessRoutes(db, { deploymentMode: "local_trusted", deploymentExposure: "private", paperclipCloudConnector: null }));
    app.use(errorHandler);
    const connect = async () => {
      const connected = await request(app).post(`/api/companies/${company.id}/tools/apps/connect`)
        .send({ link: `${origin}/mcp`, name: "Local OAuth", grantKind }).expect(201);
      return { connectionId: connected.body.connectionId as string, state: new URL(connected.body.auth.startUrl).searchParams.get("state")! };
    };
    const listed = async () => (await request(app).get(`/api/companies/${company.id}/tools/connections`).expect(200)).body.connections as Array<{ id: string; status: string; firstSignInPending?: boolean }>;
    const visible = async () => (await listed()).filter((connection) => connection.status !== "archived" && !connection.firstSignInPending);
    return { app, company, connect, listed, visible };
  }

  it("marks a never-finished sign-in as pending and removes it on cancel", async () => {
    const { app, company, connect, listed, visible } = await setup();
    const { connectionId, state } = await connect();
    expect((await listed()).find((connection) => connection.id === connectionId)).toMatchObject({ status: "draft", firstSignInPending: true });
    expect(await visible()).toEqual([]);

    const cancelled = await request(app).post(`/api/tool-connections/${connectionId}/sign-in/cancel`).expect(200);
    expect(cancelled.body).toMatchObject({ abandoned: true, connection: { id: connectionId, status: "archived" } });
    expect(await db.select().from(toolOauthStates).where(eq(toolOauthStates.connectionId, connectionId))).toEqual([]);
    expect((await listed()).filter((connection) => connection.status !== "archived")).toEqual([]);
    const [logged] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, company.id), eq(activityLog.action, "tool_connection.sign_in_cancelled")));
    expect(logged).toMatchObject({ entityType: "tool_connection", entityId: connectionId });
    await request(app).get("/api/tools/oauth/callback").query({ state, code: "late-code", iss: origin }).expect(400);
  });

  it.each(["organization", "user"] as const)("retries a cancelled %s sign-in into exactly one connection", async (grantKind) => {
    const { app, company, connect, visible } = await setup(grantKind);
    const first = await connect();
    await request(app).post(`/api/tool-connections/${first.connectionId}/sign-in/cancel`).expect(200);
    const retry = await connect();
    await request(app).get("/api/tools/oauth/callback").query({ state: retry.state, code: "fixture-code", iss: origin }).expect(200);

    const shown = await visible();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ id: retry.connectionId, status: "active" });
    const live = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, company.id), ne(toolConnections.status, "archived")));
    expect(live.map((row) => row.id)).toEqual([retry.connectionId]);
  });

  it("leaves a connection that once signed in unchanged when its reconnect is cancelled", async () => {
    const { app, connect, listed } = await setup();
    const { connectionId, state } = await connect();
    await request(app).get("/api/tools/oauth/callback").query({ state, code: "fixture-code", iss: origin }).expect(200);
    const [active] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(active.status).toBe("active");

    const untouched = await request(app).post(`/api/tool-connections/${connectionId}/sign-in/cancel`).expect(200);
    expect(untouched.body).toMatchObject({ abandoned: false, connection: { id: connectionId, status: "active" } });

    await db.update(toolConnections).set({ status: "draft", enabled: false, credentialRefs: [], credentialSecretRefs: [] }).where(eq(toolConnections.id, connectionId));
    expect((await listed()).find((connection) => connection.id === connectionId)?.firstSignInPending).toBeUndefined();
    const needsReconnect = await request(app).post(`/api/tool-connections/${connectionId}/sign-in/cancel`).expect(200);
    expect(needsReconnect.body).toMatchObject({ abandoned: false, connection: { id: connectionId, status: "draft" } });
    const [after] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(after.status).toBe("draft");
  });

  it("keeps a sign-in refused at the provider hidden and cancellable", async () => {
    const { app, connect, listed, visible } = await setup();
    const { connectionId, state } = await connect();
    await request(app).get("/api/tools/oauth/callback").query({ state, error: "access_denied", iss: origin }).expect(400);
    expect((await listed()).find((connection) => connection.id === connectionId)).toMatchObject({ status: "draft", firstSignInPending: true });
    expect(await visible()).toEqual([]);
    await request(app).post(`/api/tool-connections/${connectionId}/sign-in/cancel`).expect(200).expect(({ body }) => expect(body.abandoned).toBe(true));
  });

  it("keeps a retry that starts while the cancel is still removing the draft", async () => {
    const { app, company, connect, visible } = await setup();
    const first = await connect();
    const [cancelled, retry] = await Promise.all([
      request(app).post(`/api/tool-connections/${first.connectionId}/sign-in/cancel`).expect(200),
      connect(),
    ]);
    expect(cancelled.body.abandoned).toBe(true);
    await request(app).get("/api/tools/oauth/callback").query({ state: retry.state, code: "fixture-code", iss: origin }).expect(200);
    const live = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, company.id), ne(toolConnections.status, "archived")));
    expect(live.map((row) => [row.id, row.status])).toEqual([[retry.connectionId, "active"]]);
    expect((await visible()).map((connection) => connection.id)).toEqual([retry.connectionId]);
  });

  it("refuses a sign-in that finishes after the user cancelled it", async () => {
    const { app, connect, visible } = await setup();
    const { connectionId, state } = await connect();
    let release!: () => void;
    holdToken = new Promise<void>((resolve) => { release = resolve; });
    const requested = new Promise<void>((resolve) => { tokenRequested = resolve; });
    try {
      const callback = request(app).get("/api/tools/oauth/callback").query({ state, code: "fixture-code", iss: origin }).then((response) => response);
      await requested;
      await request(app).post(`/api/tool-connections/${connectionId}/sign-in/cancel`).expect(200).expect(({ body }) => expect(body.abandoned).toBe(true));
      release();
      expect((await callback).status).toBe(409);
    } finally {
      holdToken = null;
      tokenRequested = null;
    }
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(row.status).toBe("archived");
    expect(await visible()).toEqual([]);
  });

  it("keeps a draft whose cancel is still being removed hidden and closed to sign-in", async () => {
    const { app, company, connect, listed, visible } = await setup();
    const { connectionId } = await connect();
    await db.update(toolConnections).set({ status: "disabled", enabled: false, lastError: "oauth_sign_in_cancelled" }).where(eq(toolConnections.id, connectionId));
    expect((await listed()).find((connection) => connection.id === connectionId)?.firstSignInPending).toBe(true);
    expect(await visible()).toEqual([]);
    await request(app).post(`/api/tools/oauth/${connectionId}/start`).send({}).expect(409);
    for (const grantKind of ["user", "organization"]) {
      await request(app).post(`/api/companies/${company.id}/tools/apps/${connectionId}/finalize-oauth-access`).send({ grantKind }).expect(409);
    }
    await request(app).post(`/api/tool-connections/${connectionId}/sign-in/cancel`).expect(200).expect(({ body }) => expect(body).toMatchObject({ abandoned: true, connection: { status: "archived" } }));
  });

  it("keeps a saved machine sign-in draft listed and in place", async () => {
    const { app, connect, listed } = await setup();
    const { connectionId } = await connect();
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    const config = { ...row.config, oauth: { ...(row.config.oauth as Record<string, unknown>), grantType: "client_credentials" } };
    await db.update(toolConnections).set({ config, transportConfig: config }).where(eq(toolConnections.id, connectionId));
    expect((await listed()).find((connection) => connection.id === connectionId)?.firstSignInPending).toBeUndefined();
    await request(app).post(`/api/tool-connections/${connectionId}/sign-in/cancel`).expect(200).expect(({ body }) => expect(body.abandoned).toBe(false));
  });

  it("treats a legacy draft with an inline token as a real connection", async () => {
    const { app, connect } = await setup();
    const { connectionId } = await connect();
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    const config = { ...row.config, oauth: { ...(row.config.oauth as Record<string, unknown>), access_token: "legacy-inline" } };
    await db.update(toolConnections).set({ config, transportConfig: config }).where(eq(toolConnections.id, connectionId));
    const response = await request(app).post(`/api/tool-connections/${connectionId}/sign-in/cancel`).expect(200);
    expect(response.body.abandoned).toBe(false);
    const [after] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(after.status).toBe("draft");
  });

  it("does not let another company cancel the draft", async () => {
    const owner = await setup();
    const other = await setup("organization", "session");
    const { connectionId } = await owner.connect();
    const response = await request(other.app).post(`/api/tool-connections/${connectionId}/sign-in/cancel`);
    expect([403, 404]).toContain(response.status);
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(row.status).toBe("draft");
  });
});

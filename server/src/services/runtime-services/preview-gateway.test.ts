import { startTaskDrain, stopTaskDrain } from "../task-admission.js";
import { runtimeServiceControllerRequirements } from "./drain.js";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { previewIngressPayload } from "./preview-ingress.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import express, { type Request } from "express";
import { eq } from "drizzle-orm";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authUsers, companies, companyMemberships, createDb, runtimeServiceAllocations, runtimeServiceCompanyPolicies, runtimeServices, runtimeServicePreviewSessions, runtimeServiceShares, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createRuntimeServiceSchema } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/error-handler.js";
import { createRuntimeServiceManager } from "./manager.js";
import { createLocalRuntimeServiceProvider } from "./local-provider.js";
import { createRuntimeServicePreviewGateway, type RuntimeServicePreviewGateway } from "./preview-gateway.js";
import { runtimeServicePreviewConfig, type RuntimeServicePreviewConfig } from "./preview-config.js";
import { PREVIEW_COOKIE, previewHash } from "./preview-access.js";

describe("private preview gateway with real HTTP, WebSockets and durable authorization", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string; let origin: string; let config: RuntimeServicePreviewConfig;
  let server: http.Server; let manager: ReturnType<typeof createRuntimeServiceManager>; let gateway: RuntimeServicePreviewGateway;
  let companyId: string; let serviceId: string; let previewOrigin: string;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "preview-test-only-secret");
    database = await startEmbeddedPostgresTestDatabase("paperclip-preview-gateway-"); db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preview-gateway-"));
    const app = express(); server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    origin = `http://127.0.0.1:${port}`; config = runtimeServicePreviewConfig(`http://localhost:${port}`, true)!;
    manager = createRuntimeServiceManager(db, { providers: [createLocalRuntimeServiceProvider({ root: path.join(root, "supervisors") })], exposeEndpoint: (...args) => gateway.exposeEndpoint(...args) });
    gateway = createRuntimeServicePreviewGateway(db, manager, { config, allowLocalBoard: true, boardBaseURL: () => origin });
    app.use(gateway.middleware); app.use(gateway.publicRoutes); gateway.attach(server);
    app.use(express.json()); app.use((req, _res, next) => {
      req.actor = req.header("x-test-preview-actor") === "anonymous" ? { type: "none", source: "none" }
        : req.header("x-test-preview-actor") === "outside-user" ? { type: "board", source: "session", userId: "outside-user", companyIds: [], memberships: [] }
        : { type: "board", source: "local_implicit", userId: "test-board", isInstanceAdmin: true };
      next();
    });
    app.use("/api", gateway.routes); app.get("/api/companies", (_req, res) => res.json({ controlPlane: true })); app.use(errorHandler);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Preview acceptance", issuePrefix: "PREV" });
    await fs.writeFile(path.join(root, "app.cjs"), `const http=require('node:http'),crypto=require('node:crypto');const server=http.createServer(async(q,s)=>{if(q.url==='/html'){s.setHeader('Content-Type','text/html');s.setHeader('Content-Security-Policy',"script-src 'self'; connect-src 'self'");s.end('<html><head><title>App</title></head><body>App</body></html>');return}const chunks=[];for await(const c of q)chunks.push(c);s.setHeader('Content-Type','application/json');s.end(JSON.stringify({upstream:true,url:q.url,headers:q.headers,body:Buffer.concat(chunks).toString()}))});server.on('upgrade',(q,s)=>{const key=crypto.createHash('sha1').update(q.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');s.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+key+'\\r\\n\\r\\n');const timer=setInterval(()=>s.write(Buffer.from([129,2,111,107])),100);s.on('error',()=>{});s.on('close',()=>clearInterval(timer))});server.listen(Number(process.env.PORT),'127.0.0.1');`);
    const service = await manager.create(companyId, { type: "board", id: "test-board" }, createRuntimeServiceSchema.parse({ requestId: randomUUID(), name: "Preview", command: "node app.cjs", cwd: root, endpoints: [{ name: "web" }] }), { provider: "local", cwd: root, reuseKey: randomUUID() });
    serviceId = service.id; previewOrigin = config.origin(serviceId, "web");
    await ready();
  }, 35_000);
  afterAll(async () => {
    if (serviceId) { const row = await manager.get(companyId, serviceId); await manager.control(companyId, serviceId, { type: "board", id: "cleanup" }, { requestId: randomUUID(), expectedRevision: row.revision, action: "stop" }); await manager.reconcile(companyId, serviceId); }
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    await database?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
  });
  async function ready() {
    for (let attempt = 0; attempt < 50; attempt++) {
      await manager.reconcile(companyId, serviceId);
      const current = await manager.get(companyId, serviceId);
      if (current.endpoints[0]?.status === "ready" && current.state === "ready") return current;
      if (current.state === "failed") throw new Error(current.error ?? "Service failed");
      await delay(50);
    }
    throw new Error("Preview did not become ready");
  }
  async function request(pathname: string, init: RequestInit = {}, host = new URL(previewOrigin).host) {
    // Modern fetch controls Host itself; use a raw HTTP client to test virtual
    // hosting, including deliberately malformed headers, without DNS rewrites.
    return new Promise<Response>((resolve, reject) => {
      const req = http.request(`${origin}${pathname}`, { method: init.method ?? "GET", headers: { ...Object.fromEntries(new Headers(init.headers)), host } }, async (res) => {
        try {
          const headers = new Headers();
          for (const [name, values] of Object.entries(res.headers)) for (const value of Array.isArray(values) ? values : values ? [values] : []) headers.append(name, value);
          const chunks: Buffer[] = []; for await (const chunk of res) chunks.push(Buffer.from(chunk));
          resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode, headers }));
        } catch (error) { reject(error); }
      });
      req.once("error", reject); req.end(init.body ?? undefined);
    });
  }
  async function handoff(ticket?: string) {
    let url: URL;
    if (ticket) url = new URL(`/.paperclip/handoff?ticket=${ticket}&next=%2Fdeep%3Fq%3D1`, previewOrigin);
    else {
      const grant = await fetch(`${origin}/api/companies/${companyId}/runtime-services/${serviceId}/preview-access?endpoint=web&next=%2Fdeep%3Fq%3D1`, { redirect: "manual" });
      expect(grant.status).toBe(303); url = new URL(grant.headers.get("location")!);
    }
    const response = await request(url.pathname + url.search);
    expect(response.status).toBe(303); expect(response.headers.get("location")).toBe("/deep?q=1");
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    return { cookie, url };
  }
  it("authenticates signed Cloud ingress before preview access and rejects partial proofs before board routes", async () => {
    const pair = generateKeyPairSync("ed25519");
    const app = express();
    let claimedGateway: RuntimeServicePreviewGateway;
    const previous = { keys: process.env.PAPERCLIP_SERVICE_PREVIEW_INGRESS_PUBLIC_KEYS, stack: process.env.PAPERCLIP_CLOUD_STACK_ID, token: process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN };
    try {
      process.env.PAPERCLIP_SERVICE_PREVIEW_INGRESS_PUBLIC_KEYS = JSON.stringify([pair.publicKey.export({ type: "spki", format: "pem" }).toString()]);
      process.env.PAPERCLIP_CLOUD_STACK_ID = "fixture-stack"; process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "fixture-token";
      claimedGateway = createRuntimeServicePreviewGateway(db, manager, { config, allowLocalBoard: true, boardBaseURL: () => origin });
    } finally {
      for (const [name, value] of [["PAPERCLIP_SERVICE_PREVIEW_INGRESS_PUBLIC_KEYS", previous.keys], ["PAPERCLIP_CLOUD_STACK_ID", previous.stack], ["PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", previous.token]]) {
        if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
      }
    }
    app.use(claimedGateway!.middleware); app.get("/api/companies", (_req, res) => res.json({ controlPlane: true }));
    const edge = http.createServer(app); claimedGateway!.attach(edge);
    await new Promise<void>((resolve) => edge.listen(0, "127.0.0.1", resolve));
    const port = (edge.address() as import("node:net").AddressInfo).port;
    const targetHost = new URL(previewOrigin).host; const rawPath = "/api/companies?app=%2F";
    const time = String(Date.now()); const proof = {
      "x-paperclip-preview-host": targetHost, "x-paperclip-preview-ingress-time": time,
      "x-paperclip-preview-ingress-signature": sign(null, Buffer.from(previewIngressPayload("fixture-stack", "GET", rawPath, targetHost, time)), pair.privateKey).toString("base64url"),
    };
    try {
      const unauthenticated = await fetch(`http://127.0.0.1:${port}${rawPath}`, { headers: proof });
      expect(unauthenticated.status).toBe(401); expect(await unauthenticated.text()).not.toContain("controlPlane");
      const { cookie } = await handoff();
      const valid = await fetch(`http://127.0.0.1:${port}${rawPath}`, { headers: { ...proof, cookie: `${cookie}; app=ok` } });
      expect(valid.status).toBe(200); const echoed = await valid.json();
      expect(echoed.headers.cookie).toBe("app=ok"); expect(echoed.headers["x-paperclip-preview-host"]).toBeUndefined();
      for (const headers of [{ "x-paperclip-preview-host": targetHost }, { ...proof, "x-paperclip-preview-ingress-signature": "forged" }]) {
        const rejected = await fetch(`http://127.0.0.1:${port}${rawPath}`, { headers });
        expect(rejected.status).toBe(403); expect(await rejected.text()).not.toContain("controlPlane");
      }
    } finally { edge.closeAllConnections(); await new Promise<void>((resolve) => edge.close(() => resolve())); }
  });

  it("keeps the instance controller alive for a running service and fences service changes during idle drain", async () => {
    expect(await runtimeServiceControllerRequirements(db)).toEqual({ runtimeServiceControllerRequired: true });
    const { cookie } = await handoff();
    startTaskDrain({ ttlMs: 60_000, purpose: "idle" });
    try {
      expect((await manager.wake(companyId, serviceId)).desiredState).toBe("running");
      expect((await request("/html", { headers: { cookie, accept: "text/html", "sec-fetch-dest": "document" } })).status).toBe(200);
      expect((await request("/.paperclip/activity", { method: "POST", headers: { cookie, origin: previewOrigin, "content-type": "application/json" }, body: '{"visible":true}' })).status).toBe(204);
      expect(await manager.reconciliationCandidates("observe", 10)).toEqual([]);
      expect((await manager.get(companyId, serviceId)).desiredState).toBe("running");
    } finally { stopTaskDrain(); }
  });

  it("protects every app path, preserves raw request bodies and verifies the public route", async () => {
    expect((await manager.get(companyId, serviceId)).endpoints[0]).toMatchObject({ url: previewOrigin, status: "ready" });
    expect((await request("/api/companies")).status).toBe(401);
    const { cookie, url } = await handoff();
    expect((await request(url.pathname + url.search)).status).toBe(401); // one-time ticket
    const response = await request("/api/companies?app=1", { method: "POST", headers: { cookie: `${cookie}; app=mine`, "content-type": "application/json", "x-paperclip-cloud-token": "must-not-forward" }, body: '{"raw":  "spacing"}' });
    expect(await response.json()).toMatchObject({ upstream: true, url: "/api/companies?app=1", body: '{"raw":  "spacing"}', headers: { cookie: "app=mine" } });
    const echoed = await (await request("/", { headers: { cookie } })).json();
    expect(echoed.headers).not.toHaveProperty("cookie"); expect(echoed.headers).not.toHaveProperty("x-paperclip-cloud-token");
    const html = await request("/html", { headers: { cookie } });
    expect(html.headers.get("content-security-policy")).toBe("script-src 'self'; connect-src 'self'");
    expect(await html.text()).toContain('src="/.paperclip/visibility.js"');
    expect((await request("/sw.js", { headers: { cookie, "service-worker": "script" } })).status).toBe(403);
  });
  it("never falls through to Paperclip for malformed preview hosts or endpoints", async () => {
    const host = new URL(previewOrigin).host;
    for (const altered of [host.toUpperCase(), host.replace(".localhost:", ".localhost.:"), `unknown.${config.base.host}`, host.replace(/:\d+$/, ":9999")]) {
      const response = await request("/api/companies", {}, altered); expect(response.status).toBe(404); expect(await response.text()).not.toContain("controlPlane");
    }
    const { cookie } = await handoff();
    const unknown = new URL(config.origin(serviceId, "missing")).host;
    expect((await request("/", { headers: { cookie } }, unknown)).status).toBe(404);
    expect((await request("/.paperclip/verify")).status).toBe(401);
  });
  it("keeps background traffic idle and requires same-origin visible activity", async () => {
    const { cookie } = await handoff();
    const before = (await manager.get(companyId, serviceId)).lastActivityAt;
    await request("/", { headers: { cookie } }); await request("/.paperclip/status", { headers: { cookie } });
    expect((await manager.get(companyId, serviceId)).lastActivityAt).toBe(before);
    expect((await request("/.paperclip/activity", { method: "POST", headers: { cookie, origin: "https://other.example", "content-type": "application/json" }, body: '{"visible":true}' })).status).toBe(403);
    expect((await request("/.paperclip/activity", { method: "POST", headers: { cookie, origin: previewOrigin, "content-type": "application/json" }, body: '{"visible":false}' })).status).toBe(204);
    expect((await manager.get(companyId, serviceId)).lastActivityAt).toBe(before);
    expect((await request("/.paperclip/activity", { method: "POST", headers: { cookie, origin: previewOrigin, "content-type": "application/json" }, body: '{"visible":true}' })).status).toBe(204);
    expect((await manager.get(companyId, serviceId)).lastActivityAt).not.toBe(before);
  });
  it("expires sessions, scopes them to one endpoint, and rechecks current membership", async () => {
    const userId = randomUUID(); const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Member", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    const [membership] = await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" }).returning();
    const actor: Request["actor"] = { type: "board", source: "session", userId, companyIds: [companyId], memberships: [membership!] };
    const scope = { companyId, serviceId, endpointName: "web" };
    const ticket = await gateway.access.grant({ method: "GET", actor } as Request, scope);
    await expect(gateway.access.consume({ ...scope, endpointName: "api" }, ticket)).rejects.toMatchObject({ status: 401 });
    const { cookie } = await handoff(ticket);
    expect((await request("/", { headers: { cookie } })).status).toBe(200);
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.id, membership!.id));
    expect((await request("/", { headers: { cookie } })).status).toBe(403);
    const local = await handoff();
    await db.update(runtimeServicePreviewSessions).set({ expiresAt: new Date(0) }).where(eq(runtimeServicePreviewSessions.sessionHash, previewHash(local.cookie.slice(PREVIEW_COOKIE.length + 1))));
    expect((await request("/", { headers: { cookie: local.cookie } })).status).toBe(401);
  });

  it("preserves the app destination through login and distinguishes a signed-in access denial", async () => {
    const endpoint = `/api/companies/${companyId}/runtime-services/${serviceId}/preview-access`;
    const denied = await fetch(`${origin}${endpoint}?endpoint=web`, { headers: { "x-test-preview-actor": "outside-user" } });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("company administrator");
    const anonymous = await fetch(`${origin}${endpoint}?endpoint=web&next=${encodeURIComponent("/nested/page?check=1")}`, { headers: { "x-test-preview-actor": "anonymous" } });
    expect(anonymous.status).toBe(401);
    const html = await anonymous.text();
    const link = html.match(/<a href="([^"]+)"/u)?.[1]?.replaceAll("&amp;", "&");
    const login = new URL(link!);
    expect(login.origin).toBe(origin); expect(login.pathname).toBe("/auth");
    const callback = new URL(login.searchParams.get("next")!, origin);
    expect(callback.origin).toBe(origin); expect(callback.pathname).toBe(endpoint);
    expect(callback.searchParams.get("endpoint")).toBe("web");
    expect(callback.searchParams.get("next")).toBe("/nested/page?check=1");
    for (const untrusted of ["https://other.test/", "//other.test/", "/\\other.test/"]) {
      const response = await fetch(`${origin}${endpoint}?endpoint=web&next=${encodeURIComponent(untrusted)}`, { headers: { "x-test-preview-actor": "anonymous" } });
      const body = await response.text();
      const href = body.match(/<a href="([^"]+)"/u)?.[1]?.replaceAll("&amp;", "&");
      const destination = new URL(new URL(href!).searchParams.get("next")!, origin);
      expect(destination.origin).toBe(origin);
      expect(destination.searchParams.get("next")).toBe("/");
    }
  });
  it("revokes active shared WebSockets and rejects cross-origin upgrades", async () => {
    const token = randomUUID();
    const [share] = await db.insert(runtimeServiceShares).values({ companyId, serviceId, endpointName: "web", tokenHash: previewHash(token), expiresAt: new Date(Date.now() + 60_000) }).returning();
    const ticket = await gateway.access.grantShare({ companyId, serviceId, endpointName: "web" }, token);
    const { cookie } = await handoff(ticket);
    const socket = new WebSocket(origin.replace("http:", "ws:"), { headers: { host: new URL(previewOrigin).host, origin: previewOrigin, cookie } });
    const text = await new Promise<string>((resolve, reject) => { socket.once("message", (data) => resolve(data.toString())); socket.once("error", reject); });
    expect(text).toBe("ok");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await db.update(runtimeServiceShares).set({ revokedAt: new Date() }).where(eq(runtimeServiceShares.id, share!.id));
    await closed;
    expect((await request("/", { headers: { cookie } })).status).toBe(401);
    const local = await handoff();
    const denied = new WebSocket(origin.replace("http:", "ws:"), { headers: { host: new URL(previewOrigin).host, origin: "https://other.example", cookie: local.cookie } });
    expect(await new Promise<number>((resolve, reject) => { denied.once("unexpected-response", (_req, res) => { res.resume(); denied.terminate(); resolve(res.statusCode!); }); denied.on("error", () => {}); denied.once("open", () => reject(new Error("Cross-origin socket opened"))); })).toBe(403);
  });
  it("creates expiring share links idempotently, without granting control-plane access", async () => {
    const base = `${origin}/api/companies/${companyId}/runtime-services/${serviceId}/shares`;
    const input = { requestId: randomUUID(), endpointName: "web", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const create = (body = input) => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const response = await create(); expect(response.status).toBe(201);
    const share = await response.json(); expect((await (await create()).json()).id).toBe(share.id);
    expect((await create({ ...input, expiresAt: new Date(Date.now() + 90_000).toISOString() })).status).toBe(409);
    const grant = await fetch(share.url, { redirect: "manual" }); expect(grant.status).toBe(303);
    const target = new URL(grant.headers.get("location")!);
    const consumed = await request(target.pathname + target.search); expect(consumed.status).toBe(303);
    const cookie = consumed.headers.get("set-cookie")!.split(";")[0]!;
    expect((await request("/", { headers: { cookie } })).status).toBe(200);
    await db.update(runtimeServiceShares).set({ expiresAt: new Date(0) }).where(eq(runtimeServiceShares.id, share.id));
    expect((await request("/", { headers: { cookie } })).status).toBe(401);
    expect((await fetch(share.url, { redirect: "manual" })).status).toBe(404);
    expect((await fetch(`${base}/${share.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/${share.id}`, { method: "DELETE" })).status).toBe(200);
    const invalid = await create({ ...input, requestId: randomUUID(), expiresAt: new Date(Date.now() + 31 * 24 * 3600_000).toISOString() });
    expect(invalid.status).toBe(422);
  });
  it("allows stopped retained service data to sleep, but protects uncertain processes and recoverable states", async () => {
    const current = await manager.get(companyId, serviceId);
    await manager.control(companyId, serviceId, { type: "board", id: "test-board" }, { requestId: randomUUID(), expectedRevision: current.revision, action: "stop" });
    await manager.reconcile(companyId, serviceId);
    expect(await runtimeServiceControllerRequirements(db)).toEqual({ runtimeServiceControllerRequired: false });
    await db.update(runtimeServices).set({ desiredState: "sleeping", state: "sleeping" }).where(eq(runtimeServices.id, serviceId));
    startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
    try { await expect(manager.wake(companyId, serviceId)).rejects.toMatchObject({ status: 409 }); }
    finally { stopTaskDrain(); await db.update(runtimeServices).set({ desiredState: "stopped", state: "stopped" }).where(eq(runtimeServices.id, serviceId)); }
    const [{ processRef: saved }] = await db.select({ processRef: runtimeServices.processRef }).from(runtimeServices).where(eq(runtimeServices.id, serviceId));
    try {
      await db.update(runtimeServices).set({ state: "failed", processRef: { ...saved!, retired: false } }).where(eq(runtimeServices.id, serviceId));
      expect(await runtimeServiceControllerRequirements(db)).toEqual({ runtimeServiceControllerRequired: true });
      await db.update(runtimeServices).set({ state: "pending", processRef: saved }).where(eq(runtimeServices.id, serviceId));
      expect(await runtimeServiceControllerRequirements(db)).toEqual({ runtimeServiceControllerRequired: true });
    } finally {
      await db.update(runtimeServices).set({ state: "stopped", processRef: saved }).where(eq(runtimeServices.id, serviceId));
    }
    const policy = await manager.companyPolicy(companyId);
    await db.insert(runtimeServiceCompanyPolicies).values({ companyId, config: { ...policy.config, retainedDataSeconds: 86400 } });
    expect(await runtimeServiceControllerRequirements(db)).toEqual({ runtimeServiceControllerRequired: true });
    const { allocation } = await manager.getRecord(companyId, serviceId);
    await db.update(runtimeServiceAllocations).set({ metadata: { ...allocation.metadata, retentionReleased: true } }).where(eq(runtimeServiceAllocations.id, allocation.id));
    expect(await runtimeServiceControllerRequirements(db)).toEqual({ runtimeServiceControllerRequired: false });
    await db.update(runtimeServiceAllocations).set({ metadata: allocation.metadata }).where(eq(runtimeServiceAllocations.id, allocation.id));
    await db.update(runtimeServiceCompanyPolicies).set({ config: { ...policy.config, retainedDataSeconds: null } }).where(eq(runtimeServiceCompanyPolicies.companyId, companyId));
    expect(await runtimeServiceControllerRequirements(db)).toEqual({ runtimeServiceControllerRequired: false });
  });

});

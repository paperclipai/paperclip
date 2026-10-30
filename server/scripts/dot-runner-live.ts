/** Disposable real-Dot transport lab. Not production scheduling or admission.
 * Only the MCP listener may be tunneled. Control stays on a separate loopback
 * port with a random bearer credential stored in a mode-0600 local file.
 * No existing Paperclip database, user, API key, or company is loaded. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { z } from "zod";
import { activityLog, authUsers, companies, companyMemberships, createDb, issues, mcpEventSubscriptions, mcpEventDeliveries, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { DotHarnessDriver } from "../../packages/paperclip-runner/src/drivers/dot/dot-harness-driver.js";
import { HarnessDriverBackend } from "../../packages/paperclip-runner/src/backends/harness-driver-backend.js";
import { publicMcpIngressRoutes } from "../src/routes/public-mcp.js";
import { createPublicMcpOAuth } from "../src/services/public-mcp/oauth.js";
import { createPublicMcpEvents } from "../src/services/public-mcp/events.js";
import { createPublicMcpExecutor, McpApiError, type ApiDispatch } from "../src/services/public-mcp/capabilities.js";
import { createDotRunnerMcpBridge } from "../src/services/public-mcp/dot-runner.js";
import { instanceSettingsService } from "../src/services/instance-settings.js";

const origin = new URL(process.env.DOT_LAB_ORIGIN ?? "").origin;
assert(origin.startsWith("https://"), "DOT_LAB_ORIGIN must be the public HTTPS tunnel origin");
const port = z.coerce.number().int().min(1024).max(65534).parse(process.env.DOT_LAB_PORT ?? 43127);
const requestIdSchema = z.string().regex(/^pcmcp_request_[A-Za-z0-9_-]{43}$/);
const scratch = await mkdtemp(join(tmpdir(), "paperclip-dot-live-"));
process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(scratch, "master.key");
delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
delete process.env.PAPERCLIP_CLOUD_API_ORIGIN;
const controlToken = randomBytes(32).toString("base64url");
const app = express(); app.use(express.json({ limit: "256kb" }));
const control = express(); control.use(express.json({ limit: "16kb" }));
const http = createServer(app), admin = createServer(control);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let service: ReturnType<typeof createPublicMcpEvents> | undefined;
let unregister: (() => void) | undefined;
let active = true;
async function listen(server: Server, listenPort: number) { server.listen(listenPort, "127.0.0.1"); await once(server, "listening"); }
async function close(server: Server) { server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
try {
  database = await startEmbeddedPostgresTestDatabase("paperclip-dot-live-");
  const db = createDb(database.connectionString);
  const oauth = createPublicMcpOAuth(db, { origin, resource: origin + "/mcp/paperclip" });
  await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true });
  const userId = randomUUID();
  await db.insert(authUsers).values({ id: userId, name: "Dot lab operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  const [company] = await db.insert(companies).values({ name: "Disposable Dot integration lab", issuePrefix: "DOT" }).returning(); assert(company);
  await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  const [task] = await db.insert(issues).values({ companyId: company.id, title: "Dot live test inbox", status: "todo" }).returning(); assert(task);
  const actor = { type: "board" as const, source: "session" as const, userId };
  const pending = new Map<string, Awaited<ReturnType<typeof oauth.describeRequest>>>();
  const redirects = new Map<string, string>();
  const records: Array<Record<string, unknown>> = [];
  const reports: string[] = [];
  const transcript: unknown[] = [];
  const record = (kind: string, fields: Record<string, unknown> = {}) => {
    const entry = { at: new Date().toISOString(), kind, ...fields }; records.push(entry);
    if (records.length > 300) records.shift();
    console.log(JSON.stringify(entry));
  };
  let native: Awaited<ReturnType<HarnessDriverBackend["openSession"]>> | undefined;
  let grantId: string | undefined;
  let queued = false;
  let stopLab!: () => void;
  const stopped = new Promise<void>(resolve => { stopLab = resolve; });
  const api: ApiDispatch = async (principal, method, path) => {
    if (principal.grant.companyId !== company.id || method !== "GET" || path !== `/issues/${task.id}`) throw new McpApiError(403);
    return task;
  };
  const bridge = createDotRunnerMcpBridge();
  // Real remote callback transport: retain production HTTPS, DNS/IP pinning,
  // verification challenge, encryption, signatures and retry policy unchanged.
  service = createPublicMcpEvents(db, oauth, api, { enableDotPrototype: true });
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    if (req.path === "/mcp/paperclip" && req.method === "POST") {
      const method = String(req.body?.method ?? "").slice(0, 100);
      const tool = method === "tools/call" ? String(req.body?.params?.name ?? "").slice(0, 100) : undefined;
      res.on("finish", () => record("mcp", { method, ...(tool ? { tool } : {}), status: res.statusCode }));
    }
    next();
  });
  app.get("/", (_req, res) => res.type("text").send("Disposable Paperclip Dot lab. Authenticated MCP endpoint: /mcp/paperclip. No production data."));
  app.get("/mcp-connect/:id", async (req, res) => {
    const id = requestIdSchema.parse(req.params.id);
    const redirect = redirects.get(id);
    if (redirect) { res.redirect(303, redirect); return; }
    const request = await oauth.describeRequest(id, actor, null);
    if (pending.size >= 20 && !pending.has(id)) { res.sendStatus(429); return; }
    pending.set(id, request);
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.type("html").send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Paperclip Dot lab connection</title><h1>Connect the disposable Dot lab</h1><p>Waiting for the local lab operator to approve this request.</p><p>Client: ${escape(request.clientName)}. Return destination: ${escape(request.redirectOrigin)}.</p><p>This lab contains one test task and no existing Paperclip data. It expires when the lab closes.</p><p>Request: ${escape(id)}</p>`);
  });
  app.use(publicMcpIngressRoutes(oauth, createPublicMcpExecutor(db, oauth, api), service, bridge));
  const errors: express.ErrorRequestHandler = (_error, _req, res, _next) => { res.status(400).json({ error: "Lab request unavailable" }); };
  app.use(errors);
  control.use((req, res, next) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${controlToken}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.sendStatus(401); return; }
    next();
  });
  control.get("/status", async (_req, res) => res.json({ companyId: company.id, taskId: task.id, connected: !!native, queued,
    pending: [...pending.values()], reports, transcript, records,
    subscriptions: await db.select({ id: mcpEventSubscriptions.id, name: mcpEventSubscriptions.name, stoppedAt: mcpEventSubscriptions.stoppedAt }).from(mcpEventSubscriptions),
    deliveries: await db.select({ id: mcpEventDeliveries.id, outcome: mcpEventDeliveries.outcome, attempts: mcpEventDeliveries.attempts }).from(mcpEventDeliveries),
  }));
  // Explicit local operator approval, never a public auto-consent route.
  control.post("/approve", async (req, res) => {
    assert(!grantId, "This lab permits only one connection");
    const requestId = requestIdSchema.parse(req.body.requestId);
    assert(pending.has(requestId), "Visit the public consent page first");
    const consent = await oauth.consent(requestId, actor, { decision: "approve", companyId: company.id, allowWrites: true });
    const grants = await oauth.listConnections(userId); assert.equal(grants.length, 1);
    grantId = grants[0]!.id;
    const identity = { companyId: company.id, agentId: randomUUID(), issueId: task.id, runId: randomUUID(), sessionId: randomUUID() };
    const driver = new DotHarnessDriver({ identity, principal: { companyId: company.id, grantId }, expiresAt: Date.now() + 2 * 3600_000,
      assertAuthority: async () => { assert(active); await oauth.authorizeGrant(grantId!); },
      tools: [{ name: "save_report", description: "Save a short harmless report in this disposable lab only", inputSchema: { type: "object", properties: { body: { type: "string", maxLength: 2000 } }, required: ["body"], additionalProperties: false } }],
      executeTool: async ({ name, arguments: args }) => { assert.equal(name, "save_report"); const { body } = z.object({ body: z.string().min(1).max(2000) }).strict().parse(args); reports.push(body); record("report_saved", { body }); return { saved: true, reportNumber: reports.length }; },
      publish: async assignment => { await db.insert(activityLog).values({ companyId: company.id, actorType: "agent", actorId: identity.agentId, action: "dot.work_available", entityType: "issue", entityId: task.id, details: { ...assignment } }); record("assignment_published", { ...assignment }); },
    });
    unregister = bridge.register(driver, grantId);
    native = await new HarnessDriverBackend(driver).openSession({ identity });
    void (async () => { for await (const event of native!.events()) { transcript.push(event); record("runner_event", { event }); } })().catch(() => record("runner_stream_error"));
    redirects.set(requestId, consent.redirectUrl); pending.delete(requestId);
    record("connection_approved"); res.json({ connected: true, companyId: company.id, taskId: task.id });
  });
  control.post("/queue", async (_req, res) => {
    assert(native && !queued, "Connect first; this lab permits one task");
    const subscriptions = await db.select().from(mcpEventSubscriptions);
    assert(subscriptions.some(s => s.grantId === grantId && s.name === "paperclip.dot.work_available" && !s.stoppedAt && s.expiresAt > new Date()), "Dot must establish its event subscription first");
    queued = true;
    await native.startTurn({ message: { role: "user", text: "Live integration test: compute 17 + 25. Call the projected save_report tool with body 'Dot received the Paperclip event. 17 + 25 = 42.' Then finish with schema paperclip.run_result.v1, reportedWorkDisposition 'done', summary stating the saved result, completionClaim {contractRevision:'dot-live-v1',objectiveSatisfied:true,criteria:[],remainingWork:[]}, and empty arrays for evidence, verification, attentionRequests, artifacts. Do not use any other apps, private data, external messages, or additional tasks." } });
    await service!.tick(); res.json({ queued: true });
  });
  control.post("/stop", (_req, res) => { res.json({ stopping: true }); stopLab(); });
  control.use(errors);
  await listen(http, port); await listen(admin, port + 1); service.start();
  await writeFile(join(scratch, "control.json"), JSON.stringify({ origin, controlOrigin: `http://127.0.0.1:${port + 1}`, token: controlToken, companyId: company.id, taskId: task.id }), { mode: 0o600 });
  console.log(`LIVE LAB READY ${origin}/mcp/paperclip`);
  console.log(`Local control file: ${join(scratch, "control.json")}`);
  console.log(`Standing instruction: Subscribe to paperclip.dot.work_available for companyId ${company.id}, taskId ${task.id}. When an event arrives, check paperclip_dot_inbox; read, accept, execute and finish its assignment. Do not poll. Wait for the event before taking work.`);
  process.once("SIGINT", stopLab); process.once("SIGTERM", stopLab);
  const timer = setTimeout(stopLab, 2 * 3600_000); timer.unref();
  await stopped; clearTimeout(timer);
  if (grantId) await oauth.revokeConnection(grantId, userId);
} finally {
  active = false; unregister?.(); await service?.stop(); await close(http); await close(admin);
  await database?.cleanup(); await rm(scratch, { recursive: true, force: true });
}

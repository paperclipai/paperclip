/** Synthetic local lab, not production admission or a real OpenAI Dot.
 * Uses real OAuth, MCP HTTP, database-backed events, HMAC verification and the
 * native runner backend. Never reads a user's existing Paperclip database. */
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { activityLog, authUsers, companies, companyMemberships, createDb, issues, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { DotHarnessDriver } from "../../packages/paperclip-runner/src/drivers/dot/dot-harness-driver.js";
import { HarnessDriverBackend } from "../../packages/paperclip-runner/src/backends/harness-driver-backend.js";
import { publicMcpIngressRoutes } from "../src/routes/public-mcp.js";
import { createPublicMcpOAuth } from "../src/services/public-mcp/oauth.js";
import { createPublicMcpEvents } from "../src/services/public-mcp/events.js";
import { createPublicMcpExecutor, McpApiError, type ApiDispatch } from "../src/services/public-mcp/capabilities.js";
import { createDotRunnerMcpBridge } from "../src/services/public-mcp/dot-runner.js";
import { instanceSettingsService } from "../src/services/instance-settings.js";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
}

const scratch = await mkdtemp(join(tmpdir(), "paperclip-dot-demo-"));
// This process has its own ephemeral encryption key, never the instance key.
process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(scratch, "master.key");
delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
delete process.env.PAPERCLIP_CLOUD_API_ORIGIN;
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
const app = express(); app.use(express.json({ limit: "256kb" }));
const http = createServer(app);
const receiver = express(); receiver.use(express.raw({ type: "application/json", limit: "256kb" }));
const callback = createServer(receiver);
const secret = randomBytes(32);
const webhookSecret = "whsec_" + secret.toString("base64");
const receivedIds = new Set<string>();
let service: ReturnType<typeof createPublicMcpEvents> | undefined;
let unregister: (() => void) | undefined;
let active = true;
try {
  database = await startEmbeddedPostgresTestDatabase("paperclip-dot-demo-");
  const db = createDb(database.connectionString);
  const origin = await listen(http);
  const callbackOrigin = await listen(callback);
  const oauth = createPublicMcpOAuth(db, { origin, resource: origin + "/mcp/paperclip" });
  await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true });
  const userId = randomUUID();
  await db.insert(authUsers).values({ id: userId, name: "Dot lab operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  const [company] = await db.insert(companies).values({ name: "Dot prototype lab", issuePrefix: "DOT" }).returning();
  assert(company);
  await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  const [task] = await db.insert(issues).values({ companyId: company.id, title: "Dot runner lab inbox", status: "todo" }).returning();
  assert(task);
  const actor = { type: "board" as const, source: "session" as const, userId };
  const client = await oauth.register({ client_name: "Synthetic Dot test peer", redirect_uris: [origin + "/callback"] });
  const verifier = randomBytes(32).toString("base64url");
  const authorization = await oauth.authorize({ client_id: client.client_id, redirect_uri: origin + "/callback", resource: oauth.config.resource,
    scope: "paperclip:read paperclip:write", response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
  const consent = await oauth.consent(authorization.split("/").at(-1)!, actor, { decision: "approve", companyId: company.id, allowWrites: true });
  const tokens = await oauth.token({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: origin + "/callback",
    resource: oauth.config.resource, code: new URL(consent.redirectUrl).searchParams.get("code"), code_verifier: verifier });
  const principal = await oauth.authenticate(tokens.access_token);
  const api: ApiDispatch = async (p, method, path) => {
    if (p.grant.companyId !== company.id || method !== "GET" || path !== `/issues/${task.id}`) throw new McpApiError(403);
    return task;
  };
  const bridge = createDotRunnerMcpBridge();
  service = createPublicMcpEvents(db, oauth, api, { enableDotPrototype: true,
    // Only the lab receiver bypasses HTTPS/DNS. Production uses eventFetch's
    // public-address pinning. No CLI option can expand this exact destination.
    fetch: async (url, init) => {
      assert.equal(url, "https://dot-demo.invalid/events");
      return fetch(callbackOrigin + "/events", init);
    },
  });
  app.use(publicMcpIngressRoutes(oauth, createPublicMcpExecutor(db, oauth, api), service, bridge));
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(origin + "/mcp/paperclip", { method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, "Mcp-Name": String(params.name ?? "") },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params: { ...params, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
      } } }),
    });
    const body = await response.json() as { result?: any; error?: unknown };
    assert(response.ok && !body.error && !body.result?.isError, "MCP operation failed");
    return body.result;
  };
  const tool = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).structuredContent;
  const identity = { companyId: company.id, agentId: randomUUID(), issueId: task.id, runId: randomUUID(), sessionId: randomUUID() };
  const documents: string[] = [];
  const driver = new DotHarnessDriver({ identity, principal: { companyId: company.id, grantId: principal.grant.id }, expiresAt: Date.now() + 60_000,
    assertAuthority: async () => { assert(active, "Lab run has been revoked"); await oauth.authorizeGrant(principal.grant.id); },
    tools: [{ name: "save_report", description: "Save the synthetic lab report", inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"], additionalProperties: false } }],
    executeTool: async ({ name, arguments: args }) => { assert.equal(name, "save_report"); assert.equal(typeof args.body, "string"); documents.push(args.body as string); return { saved: true }; },
    publish: async assignment => {
      await db.insert(activityLog).values({ companyId: company.id, actorType: "agent", actorId: identity.agentId,
        action: "dot.work_available", entityType: "issue", entityId: task.id, details: { ...assignment } });
    },
  });
  unregister = bridge.register(driver, principal.grant.id);
  const native = await new HarnessDriverBackend(driver).openSession({ identity });
  let resolveWork!: () => void; let rejectWork!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => { resolveWork = resolve; rejectWork = reject; });
  // Avoid an unhandled rejection if a callback fails before the main await.
  void completed.catch(() => {});
  const peer = async () => {
    const { assignments } = await tool("paperclip_dot_inbox", { companyId: company.id });
    assert.equal(assignments.length, 1);
    const base = { companyId: company.id, runId: assignments[0].runId, turnId: assignments[0].turnId };
    const call = (name: string, args = {}, requestId = randomUUID()) => tool(name, { ...base, requestId, ...args });
    const context = await call("paperclip_dot_read"); assert.match(context.result.message.text, /competitor/);
    await call("paperclip_dot_accept");
    const writeId = randomUUID();
    await Promise.all([0, 1].map(() => call("paperclip_dot_tool", { name: "save_report", arguments: { body: "Synthetic competitor report" } }, writeId)));
    await call("paperclip_dot_progress", { text: "The lab report is saved." });
    await call("paperclip_dot_finish", { result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Lab report saved.",
      completionClaim: { contractRevision: "dot-lab-v1", objectiveSatisfied: true, criteria: [], remainingWork: [] }, evidence: [], verification: [], attentionRequests: [], artifacts: [] } });
    resolveWork();
  };
  receiver.post("/events", (req, res) => {
    const id = String(req.headers["webhook-id"]);
    const timestamp = String(req.headers["webhook-timestamp"]);
    const expected = "v1," + createHmac("sha256", secret).update(`${id}.${timestamp}.${req.body.toString("utf8")}`).digest("base64");
    const actual = Buffer.from(String(req.headers["webhook-signature"]));
    if (actual.length !== expected.length || !timingSafeEqual(actual, Buffer.from(expected)) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) { res.sendStatus(401); return; }
    const body = JSON.parse(req.body.toString("utf8"));
    if (body.type === "verification") { res.json({ challenge: body.challenge }); return; }
    res.sendStatus(204);
    if (receivedIds.has(id)) return;
    receivedIds.add(id);
    assert.equal(body.name, "paperclip.dot.work_available");
    assert(!JSON.stringify(body).includes("competitor"));
    void peer().catch(rejectWork);
  });
  const subscription = { name: "paperclip.dot.work_available", arguments: { companyId: company.id, taskId: task.id },
    delivery: { mode: "webhook", url: "https://dot-demo.invalid/events", secret: webhookSecret } };
  await rpc("events/subscribe", subscription);
  console.log("✓ Real OAuth connection and signed webhook verification");
  await native.startTurn({ message: { role: "user", text: "Write a synthetic competitor report." } });
  await service.tick();
  await Promise.race([completed, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Dot test peer timed out")), 15_000); timer.unref(); completed.finally(() => clearTimeout(timer)).catch(() => {}); })]);
  const transcript = [];
  for await (const event of native.events()) transcript.push(event);
  assert.equal((await native.result())?.result.reportedWorkDisposition, "done");
  assert.equal(documents.length, 1); assert.equal(receivedIds.size, 1);
  assert.equal(await native.usage?.(), null);
  console.log("✓ MCP Event → Dot test peer → native runner acceptance, tool write, progress, structured completion");
  console.log("✓ Concurrent duplicate write produced one report; usage remains unknown");
  assert.equal((await tool("paperclip_connection", {})).companyId, company.id);
  console.log("✓ Personal Paperclip tools remain available when no agent assignment is active");
  await rpc("events/unsubscribe", { ...subscription, delivery: { mode: "webhook", url: subscription.delivery.url } });
  await oauth.revokeConnection(principal.grant.id, userId);
  await assert.rejects(() => rpc("tools/list"));
  await native.close({ reason: "demo finished" });
  console.log(`✓ Revoked credentials rejected; ${transcript.length} runner events recorded`);
  console.log("PASS — synthetic local protocol proof. No real Dot was contacted; production agent admission is not enabled.");
} finally {
  active = false; unregister?.(); await service?.stop();
  await close(http); await close(callback); await database?.cleanup(); await rm(scratch, { recursive: true, force: true });
}

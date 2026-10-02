// Real-process acceptance harness. Run with: pnpm --filter @paperclipai/server exec tsx src/__tests__/pubsub-live-smoke.ts
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { createDb, startEmbeddedPostgresTestDatabase, ensurePostgresDatabase, applyPendingMigrations, closeRegisteredClients, companies, agents, authUsers, boardApiKeys, agentApiKeys, companyMemberships, instanceUserRoles, agentWakeupRequests, pubsubMessages, heartbeatRuns } from "@paperclipai/db";
import type { Db, EmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { z } from "zod";
import { signPubsubEnvelope } from "../services/pubsub-crypto.js";

const identitySchema = z.object({ instanceId: z.string().uuid(), publicKey: z.string() });
const itemSchema = z.object({
  id: z.string(), topic: z.string(), payload: z.unknown(), ackedAt: z.string().nullable(),
  deliveryCount: z.number(),
}).passthrough();
const responseSchema = z.object({
  id: z.string().optional(), items: z.array(itemSchema).default([]),
}).passthrough();

if (process.argv.includes("--instance")) {
  const [{ createApp }, { createStorageService }, { createLocalDiskStorageProvider }, { heartbeatService }] = await Promise.all([
    import("../app.js"), import("../storage/service.js"), import("../storage/local-disk-provider.js"), import("../services/heartbeat.js"),
  ]);
  const db = createDb(process.env.DATABASE_URL!);
  const heartbeat = heartbeatService(db);
  const app = await createApp(db, {
    uiMode: "none", serverPort: 0, deploymentMode: "authenticated", deploymentExposure: "private",
    allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1", authReady: true, companyDeletionEnabled: false,
    storageService: createStorageService(createLocalDiskStorageProvider(path.join(process.env.PAPERCLIP_HOME!, "storage"))),
    decisionServiceOptions: { wakeOriginAgent: ({ agentId, ...context }) => heartbeat.wakeup(agentId, { source: "automation", reason: "decision", contextSnapshot: context }) },
  });
  const server = app.listen(Number(process.env.SMOKE_PORT ?? 0), "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.send?.({ port: address.port });
  process.on("SIGTERM", async () => {
    await app.locals.paperclipShutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  });
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-pubsub-smoke-"));
  const clusters: EmbeddedPostgresTestDatabase[] = [];
  const children = new Set<ChildProcess>();
  const evidence: Record<string, unknown> = {};
  type Instance = { name: string; db: Db; companyId: string; ceoId: string; observerId: string; board: string; ceo: string; employee: string; observer: string; connection: string; jwtSecret: string; child?: ChildProcess; port?: number; url?: string; identity?: z.infer<typeof identitySchema> };
  async function startDatabase(name: string): Promise<EmbeddedPostgresTestDatabase> {
    const bin = process.env.PAPERCLIP_TEST_POSTGRES_BIN;
    if (!bin) return startEmbeddedPostgresTestDatabase(`pubsub-${name}-`);
    // The Asahi host needs page-size-compatible native PostgreSQL binaries.
    const exec = promisify(execFile);
    const dataDir = path.join(root, `${name}-db`);
    const reserve = net.createServer().listen(0, "127.0.0.1");
    await once(reserve, "listening");
    const address = reserve.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    await exec(path.join(bin, "initdb"), ["-D", dataDir, "-U", "paperclip", "--auth=trust", "--locale=C", "--encoding=UTF8"]);
    await exec(path.join(bin, "pg_ctl"), ["-D", dataDir, "-l", path.join(root, `${name}-postgres.log`), "-o", `-h 127.0.0.1 -p ${port} -k ${root}`, "-w", "start"]);
    const connectionString = `postgres://paperclip@127.0.0.1:${port}/paperclip`;
    const cluster = {
      connectionString,
      async cleanup() {
        await closeRegisteredClients(connectionString);
        await exec(path.join(bin, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"]);
      },
    };
    clusters.push(cluster);
    await ensurePostgresDatabase(`postgres://paperclip@127.0.0.1:${port}/postgres`, "paperclip");
    await applyPendingMigrations(connectionString);
    return cluster;
  }
  async function seed(name: string): Promise<Instance> {
    const cluster = await startDatabase(name);
    if (!clusters.includes(cluster)) clusters.push(cluster);
    const db = createDb(cluster.connectionString);
    const [company] = await db.insert(companies).values({ name: `Pubsub ${name}`, issuePrefix: name.toUpperCase() }).returning();
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Acceptance operator", email: `${name}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "owner" });
    const board = `pcp_board_${randomBytes(24).toString("hex")}`;
    await db.insert(boardApiKeys).values({ userId, name: "disposable smoke", keyHash: createHash("sha256").update(board).digest("hex") });
    const result = { name, db, companyId: company.id, board, connection: cluster.connectionString, jwtSecret: randomBytes(32).toString("hex") } as Instance;
    for (const [label, role] of [["ceo", "ceo"], ["employee", "engineer"], ["observer", "general"]] as const) {
      const [agent] = await db.insert(agents).values({ companyId: company.id, name: label, role, adapterType: "process", adapterConfig: { command: "/usr/bin/true" }, runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } } }).returning();
      const token = `pcp_${randomBytes(24).toString("hex")}`;
      await db.insert(agentApiKeys).values({ agentId: agent.id, companyId: company.id, name: "disposable smoke", keyHash: createHash("sha256").update(token).digest("hex"), responsibleUserId: userId });
      result[label] = token;
      if (label === "ceo") result.ceoId = agent.id;
      if (label === "observer") result.observerId = agent.id;
    }
    return result;
  }
  async function boot(instance: Instance) {
    const child = fork(fileURLToPath(import.meta.url), ["--instance"], {
      env: { ...process.env, DATABASE_URL: instance.connection, PAPERCLIP_HOME: path.join(root, instance.name), PAPERCLIP_AGENT_JWT_SECRET: instance.jwtSecret, PAPERCLIP_PUBSUB_ENABLED: "true", PAPERCLIP_PUBSUB_IDENTITY_PATH: path.join(root, instance.name, "identity.json"), PAPERCLIP_PUBSUB_VISIBILITY_MS: "200", PAPERCLIP_PUBSUB_ALLOWED_PRIVATE_HOSTS: "127.0.0.1", PAPERCLIP_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", PAPERCLIP_DEPLOYMENT_MODE: "authenticated", SMOKE_PORT: String(instance.port ?? 0) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.add(child);
    let diagnostics = "";
    child.stdout?.on("data", (data) => { diagnostics = (diagnostics + String(data)).slice(-12000); });
    child.stderr?.on("data", (data) => { diagnostics = (diagnostics + String(data)).slice(-12000); });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Instance boot timed out: ${diagnostics}`)); }, 90000);
      child.once("message", (message) => { clearTimeout(timer); resolve(z.object({ port: z.number() }).parse(message).port); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Instance exited ${code}: ${diagnostics}`)); });
    });
    instance.child = child; instance.port = port; instance.url = `http://127.0.0.1:${port}`;
  }
  async function request(instance: Instance, method: string, route: string, token: string | null = instance.board, body?: unknown, expected = 200) {
    const response = await fetch(instance.url + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${route}: ${text.slice(0, 1200)}`);
    return responseSchema.parse(text ? JSON.parse(text) : {});
  }
  async function eventually<T>(fn: () => Promise<T | false>, timeoutMs = 5000): Promise<T> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) { const result = await fn(); if (result) return result; await delay(25); }
    throw new Error("Acceptance condition did not arrive before deadline");
  }
  try {
    const a = await seed("alpha"); const b = await seed("beta");
    await boot(a); await boot(b);
    for (const instance of [a, b]) {
      await request(instance, "GET", "/api/health", null);
      instance.identity = identitySchema.parse(await request(instance, "GET", `/api/pubsub/identity?companyId=${instance.companyId}`));
    }
    for (const [local, peer] of [[a, b], [b, a]]) {
      await request(local, "POST", "/api/pubsub/trust", local.board, { companyId: local.companyId, peerInstanceId: peer.identity!.instanceId, peerCompanyId: peer.companyId, publicKey: peer.identity!.publicKey, url: peer.url, topics: ["fleet.chat.*", "fleet.task.*", "fleet.p2p.*"] }, 201);
      for (const topic of ["fleet.chat.*", "fleet.task.*", "fleet.p2p.*"]) {
        await request(local, "POST", "/api/pubsub/subscriptions", local.board, { companyId: local.companyId, peerInstanceId: peer.identity!.instanceId, topic }, 201);
      }
      await request(local, "POST", "/api/pubsub/observers", local.board, { companyId: local.companyId, agentId: local.observerId }, 201);
    }
    const topic = "fleet.chat.acceptance";
    const started = performance.now();
    const published = await request(a, "POST", "/api/pubsub/publish", a.ceo, { companyId: a.companyId, topic, payload: { text: "CEO alpha to beta and conductor" } }, 202);
    assert.ok(published.id);
    const publishedId = published.id;
    const delivered = await eventually(async () => {
      const result = await request(b, "GET", `/api/pubsub/inbox?companyId=${b.companyId}`, b.ceo);
      return result.items.find((item) => item.id === published.id) || false;
    });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `Delivery ${elapsed}ms exceeds <1s acceptance`);
    evidence.deliveryMs = Math.round(elapsed);
    assert.deepEqual(delivered.payload, { text: "CEO alpha to beta and conductor" });
    await request(b, "GET", `/api/pubsub/history?companyId=${b.companyId}&topic=${topic}`, b.observer);
    await request(b, "GET", `/api/pubsub/history?companyId=${b.companyId}&topic=${topic}`, b.employee, undefined, 403);
    await request(b, "POST", "/api/pubsub/publish", b.employee, { companyId: b.companyId, topic, payload: { denied: true } }, 403);
    await request(b, "POST", "/api/pubsub/publish", b.observer, { companyId: b.companyId, topic, payload: { denied: true } }, 403);
    await request(b, "POST", `/api/pubsub/inbox/${published.id}/ack`, b.observer, { companyId: b.companyId }, 403);
    await request(b, "GET", `/api/pubsub/inbox?companyId=${b.companyId}`, null, undefined, 401);
    evidence.acl = "employee publish/read, observer publish/ack, anonymous inbox denied";
    const crashed = b.child!; const exited = once(crashed, "exit"); crashed.kill("SIGKILL"); await exited; children.delete(crashed);
    await boot(b);
    assert.deepEqual(identitySchema.parse(await request(b, "GET", `/api/pubsub/identity?companyId=${b.companyId}`)), b.identity);
    const redelivered = await eventually(async () => {
      const result = await request(b, "GET", `/api/pubsub/inbox?companyId=${b.companyId}`, b.ceo);
      return result.items.find((item) => item.id === published.id) || false;
    });
    assert.ok(redelivered.deliveryCount >= 2);
    await request(b, "POST", `/api/pubsub/inbox/${published.id}/ack`, b.ceo, { companyId: b.companyId });
    await request(b, "POST", `/api/pubsub/inbox/${published.id}/ack`, b.ceo, { companyId: b.companyId });
    const history = await request(b, "GET", `/api/pubsub/history?companyId=${b.companyId}&topic=${topic}`, b.observer);
    assert.equal(history.items.filter((item) => item.id === published.id).length, 1);
    assert.ok(history.items.find((item) => item.id === published.id)?.ackedAt);
    const pending = await request(b, "GET", `/api/pubsub/inbox?companyId=${b.companyId}`, b.ceo);
    assert.ok(!pending.items.some((item) => item.id === published.id));
    evidence.restart = "SIGKILL receiver, same identity/database restart, unacked redelivery, idempotent ack, one retained history row";
    const p2p = `fleet.p2p.${a.identity!.instanceId}.${b.identity!.instanceId}`;
    await request(a, "POST", "/api/pubsub/publish", a.ceo, { companyId: a.companyId, topic: p2p, payload: { text: "private CEO coordination" } }, 202);
    await eventually(async () => (await request(b, "GET", `/api/pubsub/history?companyId=${b.companyId}&topic=${p2p}`, b.observer)).items.length > 0);
    await request(b, "GET", `/api/pubsub/history?companyId=${b.companyId}&topic=${p2p}`, b.employee, undefined, 403);
    evidence.p2p = "CEO publish, conductor observer read, employee denied";
    const receiverExit = once(b.child!, "exit");
    b.child!.kill("SIGKILL");
    await receiverExit;
    children.delete(b.child!);
    const queued = await request(a, "POST", "/api/pubsub/publish", a.ceo, { companyId: a.companyId, topic, payload: { text: "outbox survives sender death while peer offline" } }, 202);
    assert.ok(queued.id);
    const senderExit = once(a.child!, "exit");
    a.child!.kill("SIGKILL");
    await senderExit;
    children.delete(a.child!);
    await boot(a);
    await boot(b);
    const recovered = await eventually(async () => {
      const result = await request(b, "GET", `/api/pubsub/inbox?companyId=${b.companyId}`, b.ceo);
      return result.items.find((item) => item.id === queued.id) || false;
    }, 15000);
    assert.deepEqual(recovered.payload, { text: "outbox survives sender death while peer offline" });
    await request(b, "POST", `/api/pubsub/inbox/${queued.id}/ack`, b.ceo, { companyId: b.companyId });
    evidence.outboxRestart = "peer offline, publish committed, SIGKILL sender, restart both, durable outbox redelivery and ack";
    const taskStarted = performance.now();
    const issue = await request(a, "POST", `/api/companies/${a.companyId}/issues`, a.board, { title: "Acceptance auto-event", status: "todo" }, 201);
    assert.ok(issue.id);
    const issueId = issue.id;
    await eventually(async () => (await request(b, "GET", `/api/pubsub/history?companyId=${b.companyId}&topic=fleet.task.created`, b.ceo)).items.some((item) => JSON.stringify(item.payload).includes(issueId)));
    const taskElapsed = performance.now() - taskStarted;
    assert.ok(taskElapsed < 1000, `Task event ${taskElapsed}ms exceeds <1s acceptance`);
    evidence.taskCreatedMs = Math.round(taskElapsed);
    for (const [status, event, body] of [["blocked", "blocked", { status: "blocked", unblockDescriptor: { owner: "board" as const, action: "acceptance: waiting for operator" } }], ["done", "completed", { status: "done" }]] as const) {
      await request(a, "PATCH", `/api/issues/${issue.id}`, a.board, body);
      await eventually(async () => (await request(b, "GET", `/api/pubsub/history?companyId=${b.companyId}&topic=fleet.task.${event}`, b.ceo)).items.some((item) => JSON.stringify(item.payload).includes(issueId)));
    }
    await request(a, "POST", `/api/issues/${issue.id}/comments`, a.board, { body: "Acceptance comment" }, 201);
    await eventually(async () => (await request(b, "GET", `/api/pubsub/history?companyId=${b.companyId}&topic=fleet.task.comment_added`, b.ceo)).items.some((item) => JSON.stringify(item.payload).includes(issueId)));
    evidence.taskEvents = ["created", "blocked", "completed", "comment_added"];
    await eventually(async () => {
      const rows = await b.db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, b.companyId), eq(agentWakeupRequests.agentId, b.ceoId)));
      return rows.some((row) => JSON.stringify(row).includes(publishedId)) ? rows : false;
    });
    evidence.heartbeatWake = "durable native CEO wakeup request contains delivered message id";
    const privateIdentity = z.object({ privateKey: z.string() }).parse(JSON.parse(await readFile(path.join(root, "alpha", "identity.json"), "utf8")));
    const unsigned = {
      version: 1 as const, id: randomUUID(), from_instance: a.identity!.instanceId,
      from_company: a.companyId, from_agent: a.ceoId, from_role: "ceo" as const,
      to_instance: b.identity!.instanceId, to_company: b.companyId, to_topic: topic,
      payload: { text: "Signed protocol acceptance" }, timestamp: new Date().toISOString(), nonce: randomUUID(),
    };
    const signed = signPubsubEnvelope(unsigned, privateIdentity.privateKey);
    await request(b, "POST", "/api/pubsub/deliver", null, { ...signed, payload: { text: "tampered" } }, 401);
    await request(b, "POST", "/api/pubsub/deliver", null, signPubsubEnvelope({ ...unsigned, timestamp: new Date(Date.now() - 600000).toISOString() }, privateIdentity.privateKey), 401);
    await request(b, "POST", "/api/pubsub/deliver", null, signPubsubEnvelope({ ...unsigned, from_instance: randomUUID() }, privateIdentity.privateKey), 403);
    {
      const wakeRows = await b.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, b.companyId));
      const runRows = await b.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, b.companyId));
      const pendingRows = await b.db.select({ id: pubsubMessages.id, topic: pubsubMessages.topic, attempts: pubsubMessages.wakeAttempts, available: pubsubMessages.wakeAvailableAt }).from(pubsubMessages).where(and(eq(pubsubMessages.companyId, b.companyId), eq(pubsubMessages.direction, "incoming"), eq(pubsubMessages.wakePending, 1)));
      console.error(JSON.stringify({ diagnostic: true, wakeRows: wakeRows.map((row) => ({ id: row.id.slice(0, 8), status: row.status, claimedAt: row.claimedAt?.toISOString() ?? null, updatedAt: row.updatedAt?.toISOString() ?? null, runId: row.runId?.slice(0, 8) ?? null, finishedAt: row.finishedAt?.toISOString() ?? null, error: row.error })), runRows: runRows.map((row) => ({ id: row.id.slice(0, 8), status: row.status, wakeupRequestId: row.wakeupRequestId?.slice(0, 8) ?? null, processPid: row.processPid, runtimeMode: row.runtimeMode, updatedAt: row.updatedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null })), pendingCount: pendingRows.length, pending: pendingRows }, null, 2));
    }
    // The acceptance burst saturates the per-company wake queue: cooldown-bounded
    // wakes hold their slots as durable backpressure, so a validly signed
    // delivery may be admitted with 429 until a slot frees. Retry per the
    // transport contract: stable id and content, fresh timestamp/nonce/signature
    // per attempt.
    const securityDeliver = async (nonce: string, id?: string) => {
      const envelope = signPubsubEnvelope({ ...unsigned, id: id ?? unsigned.id, timestamp: new Date().toISOString(), nonce }, privateIdentity.privateKey);
      const response = await fetch(b.url + "/api/pubsub/deliver", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope) });
      return { status: response.status, text: await response.text() };
    };
    let acceptedNonce = "";
    await eventually(async () => {
      const nonce = randomUUID();
      const { status, text } = await securityDeliver(nonce);
      if (status === 200) { acceptedNonce = nonce; return true; }
      assert.equal(status, 429, `Valid security delivery rejected with ${status}: ${text.slice(0, 400)}`);
      return false;
    }, 120000);
    // Idempotent retry of the accepted message: same stable id and content
    // converge to the stored row (200 duplicate) even while every quota is
    // exhausted.
    await request(b, "POST", "/api/pubsub/deliver", null, signed);
    // Nonce replay: a fresh id reusing the accepted delivery's nonce is a 409
    // once the wake queue has a free slot (429 until then).
    await eventually(async () => {
      const { status, text } = await securityDeliver(acceptedNonce, randomUUID());
      if (status === 409) return true;
      assert.equal(status, 429, `Nonce replay rejected with ${status}: ${text.slice(0, 400)}`);
      return false;
    }, 120000);
    await request(b, "POST", "/api/pubsub/deliver", null, signPubsubEnvelope({ ...unsigned, nonce: randomUUID(), payload: { text: "conflicting message id" } }, privateIdentity.privateKey), 409);
    await request(b, "DELETE", `/api/pubsub/trust/${a.identity!.instanceId}`, b.board, { companyId: b.companyId }, 204);
    await request(b, "POST", "/api/pubsub/deliver", null, signPubsubEnvelope({ ...unsigned, id: randomUUID(), nonce: randomUUID() }, privateIdentity.privateKey), 403);
    evidence.security = "tamper401, stale401, untrusted403, valid200-after-429-backpressure, duplicate-retry200, nonce-replay409, conflicting-id409, revoked403";
    console.log(JSON.stringify({ result: "PASS", ...evidence }, null, 2));
  } finally {
    for (const child of children) { const exited = once(child, "exit"); child.kill("SIGTERM"); await Promise.race([exited, delay(10000)]); if (child.exitCode === null) child.kill("SIGKILL"); }
    for (const cluster of clusters.reverse()) await cluster.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}

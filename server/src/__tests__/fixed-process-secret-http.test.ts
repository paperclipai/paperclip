import { accessRoutes } from "../routes/access.js";
import { issueService } from "../services/issues.js";
import { loadWatchdogServiceContext } from "../services/watchdog-service-context.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys, agents, authUsers, companies, companyMemberships,
  createDb, heartbeatRuns, principalPermissionGrants, issues, activityLog, invites, joinRequests,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { secretRoutes } from "../routes/secrets.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { secretService } from "../services/secrets.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { execute } from "../adapters/process/execute.js";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("fixed process key and run-secret HTTP boundary", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  let directory: string;
  const savedEnv = new Map<string, string | undefined>();
  function setTestEnv(key: string, value: string) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "fixed-process-test-"));
    setTestEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(directory, "synthetic-master.key"));
    setTestEnv("PAPERCLIP_AGENT_JWT_SECRET", "synthetic-fixed-process-signing-key");
    setTestEnv("PAPERCLIP_INSTANCE_ID", "fixed-process-test");
    setTestEnv("PAPERCLIP_HOME", directory);
    const started = await startEmbeddedPostgresTestDatabase("fixed-process-http");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
  });
  afterAll(async () => {
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    await cleanup?.();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("denies a permanent key, lets the configured child read with a live JWT, and denies after completion", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const userId = randomUUID();
    const permanentKey = "pcp_synthetic_fixed_process_key";
    await db.insert(companies).values({ id: companyId, name: "Fixed process HTTP", issuePrefix: `F${companyId.slice(0, 7)}` });
    await db.insert(authUsers).values({
      id: userId, name: "Synthetic owner", email: "qa-mail+fixed-process@zolotenkov.site",
      createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixed process", role: "ceo", permissions: { canCreateAgents: true }, adapterType: "process", adapterConfig: { fixedCommand: true }, status: "idle" });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" });
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure" },
      { companyId, principalType: "agent", principalId: agentId, permissionKey: "agents:configure" },
    ]);
    await db.insert(agentApiKeys).values({ agentId, companyId, name: "Synthetic trigger", keyHash: createHash("sha256").update(permanentKey).digest("hex"), responsibleUserId: userId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: userId, contextSnapshot: {} });
    const svc = secretService(db);
    const secret = await svc.create(companyId, { key: "WATCHDOG_TEST", name: "Synthetic watchdog secret", provider: "local_encrypted", value: "synthetic-value-one" });
    await svc.createBinding({ companyId, secretId: secret.id, targetType: "agent", targetId: agentId, configPath: "env.DOKPLOY_KEY" });

    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.use("/api", secretRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use("/api", issueRoutes(db));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing-test-address");
      const url = `http://127.0.0.1:${address.port}/api/agents/me/secrets/watchdog_test/value`;
      const denied = await request(server).post("/api/agents/me/secrets/watchdog_test/value")
        .set("Authorization", `Bearer ${permanentKey}`).set("X-Paperclip-Run-Id", runId).send({});
      expect(denied.status).toBe(403);
      const jwt = createLocalAgentJwt(agentId, companyId, "process", runId, userId);
      expect(typeof jwt).toBe("string");
      const output: string[] = [];
      const fixedArgs = ["-e", `fetch(${JSON.stringify(url)}, {method:'POST',headers:{authorization:'Bearer '+process.env.PAPERCLIP_API_KEY}}).then(async r => {const b=await r.json(); console.log('http-status-'+r.status); console.log(r.status===200 && b.value==='synthetic-value-one' ? 'live-secret-ok' : 'live-secret-failed');}).catch(()=>{process.exitCode=1;});`];
      const result = await execute({
        runId,
        agent: { id: agentId, companyId, name: "Fixed process", adapterType: "process", adapterConfig: { fixedCommand: true, command: process.execPath, cwd: directory, args: fixedArgs } },
        config: {
          fixedCommand: true, command: process.execPath, cwd: directory, timeoutSec: 20,
          args: fixedArgs,
        },
        authToken: jwt!, context: {},
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        onLog: async (_stream, chunk) => { output.push(chunk); },
      });
      expect(result.exitCode).toBe(0);
      expect(output.join("").match(/http-status-(\d+)/)?.[1]).toBe("200");
      expect(output.join("").includes("live-secret-ok")).toBe(true);
      expect(output.join("").includes(jwt!)).toBe(false);
      expect(output.join("").includes("synthetic-value-one")).toBe(false);
      await svc.rotate(secret.id, { value: "synthetic-value-two" });
      const rotated = await request(server).post("/api/agents/me/secrets/watchdog_test/value")
        .set("Authorization", `Bearer ${jwt}`).send({});
      expect(rotated.status).toBe(200);
      expect(rotated.body.value === "synthetic-value-two").toBe(true);
      // The run JWT must not let a fixed process remove its permanent-key
      // boundary, replace its config, or restore a pre-restriction revision.
      for (const patch of [
        { adapterConfig: { fixedCommand: false } },
        { adapterConfig: {}, replaceAdapterConfig: true },
        { adapterType: "codex_local" },
      ]) {
        const mutation = await request(server).patch(`/api/agents/${agentId}`)
          .set("Authorization", `Bearer ${jwt}`).send(patch);
        expect(mutation.status).toBe(403);
      }
      const rollback = await request(server).post(`/api/agents/${agentId}/config-revisions/${randomUUID()}/rollback`)
        .set("Authorization", `Bearer ${jwt}`).send({});
      expect(rollback.status).toBe(403);
      const receiverId = randomUUID();
      await db.insert(agents).values({ id: receiverId, companyId, name: "Synthetic incident receiver", adapterType: "process", status: "idle", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
      await db.update(agents).set({ adapterConfig: { fixedCommand: true, command: process.execPath, cwd: directory, args: fixedArgs, watchdogService: {
        assigneeAgentId: receiverId, signals: [{ type: "blind", marker: "[watchdog-blind]" }],
      } } }).where(eq(agents.id, agentId));
      const incident = await request(server).post(`/api/companies/${companyId}/issues`)
        .set("Authorization", `Bearer ${jwt}`).send({ title: "[watchdog-blind] Проверить синтетический сигнал сторожа", status: "todo", assigneeAgentId: receiverId });
      expect(incident.status).toBe(201);
      const comment = await request(server).post(`/api/issues/${incident.body.id}/comments`)
        .set("Authorization", `Bearer ${jwt}`).send({ body: "[watchdog-blind] Повторный синтетический сигнал" });
      expect(comment.status).toBe(201);
      const forgedContext = await request(server).post(`/api/issues/${incident.body.id}/comments`)
        .set("Authorization", `Bearer ${jwt}`).send({ body: "[watchdog-blind] Сигнал", sourceIssueId: incident.body.id });
      expect(forgedContext.status).toBe(403);
      const persistentComment = await request(server).post(`/api/issues/${incident.body.id}/comments`)
        .set("Authorization", `Bearer ${permanentKey}`).set("X-Paperclip-Run-Id", runId)
        .send({ body: "[watchdog-blind] Сигнал" });
      expect(persistentComment.status).toBe(403);

      const wrong = await request(server).post(`/api/companies/${companyId}/issues`)
        .set("Authorization", `Bearer ${jwt}`).send({ title: "[watchdog-blind] Поддельный владелец", status: "todo", assigneeAgentId: agentId });
      expect(wrong.status).toBe(403);
      const changed = await request(server).patch(`/api/issues/${incident.body.id}`)
        .set("Authorization", `Bearer ${jwt}`).send({ title: "[watchdog-blind] Изменённое поле" });
      expect(changed.status).toBe(403);
      expect(incident.body.originKind).toBe("watchdog_service_signal");
      const fakeId = randomUUID();
      await db.insert(issues).values({ id: fakeId, companyId, title: "[watchdog-blind] Поддельный маркер",
        status: "todo", assigneeAgentId: receiverId, createdByAgentId: receiverId,
        originKind: "watchdog_service_signal", originId: `${agentId}/blind`, originRunId: runId });
      const repeat = (id: string) => request(server).post(`/api/issues/${id}/comments`)
        .set("Authorization", `Bearer ${jwt}`).send({ body: "[watchdog-blind] Повторный сигнал" });
      expect((await repeat(fakeId)).status).toBe(403);
      await db.update(issues).set({ originKind: "manual", originId: null, originRunId: null }).where(eq(issues.id, fakeId));
      await db.update(agents).set({ adapterConfig: { fixedCommand: true, command: process.execPath, cwd: directory, args: fixedArgs,
        watchdogService: { assigneeAgentId: receiverId, signals: [{ type: "blind", marker: "[watchdog-blind]" }],
          legacyIssues: [{ issueId: fakeId, type: "blind", createdByAgentId: receiverId, createdByUserId: null,
            originKind: "manual", originId: null, originRunId: null }] },
      } }).where(eq(agents.id, agentId));
      expect((await repeat(fakeId)).status).toBe(201);
      await db.update(issues).set({ createdByAgentId: agentId }).where(eq(issues.id, fakeId));
      expect((await repeat(fakeId)).status).toBe(403);

      await db.update(issues).set({ status: "done" }).where(eq(issues.id, incident.body.id));
      expect((await repeat(incident.body.id)).status).toBe(403);
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, incident.body.id));
      for (let index = 2; index < 20; index++) expect((await repeat(incident.body.id)).status).toBe(201);
      expect((await repeat(incident.body.id)).status).toBe(429);
      const observed = await db.select().from(activityLog).where(eq(activityLog.runId, runId));
      expect(observed.filter((row) => row.action === "issue.cross_issue_influence_observed")).toHaveLength(20);
      expect(observed.filter((row) => row.action === "issue.cross_issue_influence_cap_rejected")).toHaveLength(1);
      expect(observed.filter((row) => row.action === "watchdog.service_action_rejected").length).toBeGreaterThanOrEqual(4);

      const verifiedContext = await loadWatchdogServiceContext(db, { source: "agent_jwt", companyId, agentId, runId });
      expect(verifiedContext).not.toBeNull();
      await db.update(agents).set({ adapterConfig: { fixedCommand: true } }).where(eq(agents.id, agentId));
      await expect(issueService(db).addComment(incident.body.id, "[watchdog-blind] Устаревшее разрешение", {
        agentId, runId, onBehalfOfUserId: userId,
      }, { watchdogContext: verifiedContext! })).rejects.toMatchObject({ status: 403 });
      const rejectedAtInsert = await db.select().from(activityLog).where(and(
        eq(activityLog.runId, runId), eq(activityLog.action, "watchdog.service_action_rejected"),
      ));
      expect(rejectedAtInsert.some((row) => row.details?.stage === "comment-insert")).toBe(true);
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
      const finished = await request(server).post("/api/agents/me/secrets/watchdog_test/value")
        .set("Authorization", `Bearer ${jwt}`).send({});
      expect(finished.status).toBe(403);

      // Exercise the real wake route and scheduler, not just the middleware
      // admission and a separately invoked process adapter.
      await db.update(agents).set({
        adapterConfig: {
          fixedCommand: true, command: process.execPath, cwd: directory, timeoutSec: 20,
          env: { DOKPLOY_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" } },
          args: ["-e", `fetch(${JSON.stringify(url)}, {method:'POST',headers:{authorization:'Bearer '+process.env.PAPERCLIP_API_KEY}}).then(async r => {const b=await r.json(); if(r.status!==200 || b.version!==2 || b.value!==process.env.DOKPLOY_KEY) process.exitCode=1; else console.log('scheduled-secret-ok');}).catch(()=>{process.exitCode=1;});`],
        },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      }).where(eq(agents.id, agentId));
      const triggered = await request(server).post(`/api/agents/${agentId}/wakeup`)
        .set("Authorization", `Bearer ${permanentKey}`).send({ idempotencyKey: "scheduled-fixed-process" });
      expect(triggered.status).toBe(202);
      await expect.poll(async () => {
        const runs = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
          .from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId), ne(heartbeatRuns.id, runId)));
        return runs.length > 0 && runs.every((run) => ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status));
      }, { timeout: 8_000, interval: 100 }).toBe(true);
      const scheduled = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), ne(heartbeatRuns.id, runId)));
      expect(scheduled).toEqual([{ status: "succeeded", errorCode: null }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("rejects service configuration approved through agent join requests", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Join boundary", issuePrefix: `J${companyId.slice(0, 7)}` });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `qa-mail+${userId}@zolotenkov.site`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Ordinary approver", role: "ceo", adapterType: "process", status: "idle" });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agentId, permissionKey: "joins:approve" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: userId, contextSnapshot: {} });
    const inviteId = randomUUID(), requestId = randomUUID();
    await db.insert(invites).values({ id: inviteId, companyId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) });
    await db.insert(joinRequests).values({ id: requestId, inviteId, companyId, requestType: "agent", requestIp: "127.0.0.1", adapterType: "process", agentName: "Self-issued service", agentDefaultsPayload: { fixedCommand: true, command: "/bin/sh", cwd: "/synthetic", watchdogService: { assigneeAgentId: agentId } } });
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.use("/api", accessRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [] }));
    app.use(errorHandler);
    const jwt = createLocalAgentJwt(agentId, companyId, "process", runId, userId);
    const result = await request(app).post(`/api/companies/${companyId}/join-requests/${requestId}/approve`).set("Authorization", `Bearer ${jwt}`).send({});
    expect(result.status).toBe(403);
    const [pending] = await db.select().from(joinRequests).where(eq(joinRequests.id, requestId));
    expect(pending.createdAgentId).toBeNull();
    expect(pending.status).toBe("pending_approval");
    await db.update(joinRequests).set({ agentDefaultsPayload: { command: "/bin/true" } }).where(eq(joinRequests.id, requestId));
    const ordinary = await request(app).post(`/api/companies/${companyId}/join-requests/${requestId}/approve`).set("Authorization", `Bearer ${jwt}`).send({});
    expect(ordinary.status).toBe(200);
  });

});

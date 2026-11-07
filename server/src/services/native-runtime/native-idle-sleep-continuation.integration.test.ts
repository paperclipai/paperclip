import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { agents, agentTaskSessions, agentWakeupRequests, authUsers, companies, companyMemberships, companySecretVersions, createDb, heartbeatRuns,
  issues, issueWorkProducts, nativeRunResults } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeExecutionInput, NativeSession, NativeSessionBackend, PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import { nativeRestartFixture } from "../../__tests__/helpers/native-restart-fixture.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getRecoveryPostgresSupport } from "../../__tests__/helpers/recovery-postgres-fixture.js";
import { heartbeatService } from "../heartbeat.js";
import { flushBudgetEvaluationWork } from "../budgets.js";
import { instanceSettingsService } from "../instance-settings.js";
import { secretService } from "../secrets.js";
import { issueRoutes } from "../../routes/issues.js";
import { errorHandler } from "../../middleware/index.js";
import { readIdleSleepSafety } from "../idle-sleep-safety.js";
import { closeIdleWarmNativeSessionsForRestart, readNativeSessionIdleWork } from "./native-session-executor.js";

const dedicatedDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RECOVERY_TEST_DATABASE_URL");
const recoveryOptions = { dedicatedDatabaseUrl };
const recoverySupport = await getRecoveryPostgresSupport(recoveryOptions);
const describeRecoveryPostgres = recoverySupport.supported ? describe : describe.skip;

describeRecoveryPostgres("native idle sleep cold continuation", () => {
  const fixture = nativeRestartFixture(recoveryOptions);
  afterEach(async () => {
    await closeIdleWarmNativeSessionsForRestart();
    vi.unstubAllEnvs();
  });

  it("retires a completed warm owner and resumes saved work through an ordinary authorized comment", async () => {
    const { companyId, agentId, runtimeRoot, temporary } = fixture.current;
    vi.stubEnv("DATABASE_URL", temporary.connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "89".repeat(32));
    const db = createDb(temporary.connectionString, { maxConnections: 2 });
    expect(db.$client.options.max).toBe(2);
    if (dedicatedDatabaseUrl) expect(db.$client.options.database).toBe(new URL(dedicatedDatabaseUrl).pathname.slice(1));
    const settings = instanceSettingsService(db), previousSettings = await settings.getExperimental();
    const userId = randomUUID(), issueId = randomUUID(), productId = randomUUID();
    const cwd = join(runtimeRoot, "ordinary-task");
    await mkdir(cwd, { recursive: true });
    await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.update(companies).set({ defaultResponsibleUserId: userId }).where(eq(companies.id, companyId));
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue saved work", status: "todo", assigneeAgentId: agentId });
    await db.insert(issueWorkProducts).values({ id: productId, companyId, issueId, type: "artifact", provider: "paperclip",
      title: "Saved and continued work", status: "ready_for_review", reviewState: "approved" });
    const secrets = secretService(db), credential = `synthetic-${randomUUID()}`;
    const secret = await secrets.create(companyId, { name: "Idle continuation credential", provider: "local_encrypted", value: credential });
    const binding = { SLEEP_CREDENTIAL: { type: "secret_ref", secretId: secret.id, version: "latest" } };
    await secrets.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: agentId }, binding);
    await db.update(agents).set({ status: "idle", adapterConfig: { provider: "codex", model: "gpt-6.1-sol", cwd,
      lifecycleMode: "warm", idleTimeoutMs: 300_000, env: binding },
      runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
    const opened: NativeSession[] = [], recovered: string[] = [], closed: string[] = [], turns: string[] = [];
    const executions: NativeExecutionInput[] = [];
    const closeStarted: string[] = [];
    let finishClose: (() => void) | undefined;
    let closeGate: Promise<void> | undefined;
    const backendFactory = (execution: NativeExecutionInput): NativeSessionBackend => {
      executions.push(execution);
      const makeSession = (): NativeSession => {
        const identity = { companyId, agentId, issueId, runId: execution.binding.runId, sessionId: execution.session.normalizedSessionId! };
        const turnId = `turn-${identity.runId}`;
        let start!: () => void;
        const started = new Promise<void>(resolve => { start = resolve; });
        const result = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT), evidenceRef = `work_product:${productId}`;
        result.completionClaim.contractRevision = execution.completionContract.contract.revision;
        result.completionClaim.criteria = execution.completionContract.contract.criteria.map(criterion => ({
          ...result.completionClaim.criteria[0]!, criterionId: criterion.id, evidenceRefs: [evidenceRef] }));
        result.evidence = [{ kind: "work_product", ref: evidenceRef }];
        result.verification[0]!.artifactRef = evidenceRef;
        const session: NativeSession = {
          identity: () => identity,
          async capabilities() { return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
          async *events() {
            await started;
            const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.runId));
            yield { schema: "paperclip.prp.event.v1", sourceEventId: `${identity.runId}:usage`, sourceSeq: 1,
              sourceInstanceId: run.runnerInstanceId!, sourceKind: "runner", runId: identity.runId,
              normalizedSessionId: identity.sessionId, turnId, eventType: "item.completed", schemaVersion: 1,
              priority: 0, emittedAt: new Date().toISOString(), payload: { kind: "usage", usage: {
                runDelta: { inputTokens: 1, outputTokens: 1 }, runDeltaComplete: true } } } satisfies PrpEvent;
            yield { schema: "paperclip.prp.event.v1", sourceEventId: `${identity.runId}:terminal`, sourceSeq: 2,
              sourceInstanceId: run.runnerInstanceId!, sourceKind: "runner", runId: identity.runId,
              normalizedSessionId: identity.sessionId, turnId, eventType: "turn.completed", schemaVersion: 1,
              priority: 0, emittedAt: new Date().toISOString(), payload: {} } satisfies PrpEvent;
          },
          async startTurn() {
            const resolved = await secretService(db).resolveEnvBindings(companyId, binding);
            expect(resolved.env.SLEEP_CREDENTIAL).toBe(credential);
            if (turns.length === 0) {
              await writeFile(join(execution.workspace.cwd!, "work.txt"), "first useful work\n");
            } else {
              expect(await readFile(join(execution.workspace.cwd!, "work.txt"), "utf8")).toBe("first useful work\n");
              await writeFile(join(execution.workspace.cwd!, "continued.txt"), "continued first useful work\n");
            }
            turns.push(identity.runId);
            start();
            return { turnId };
          },
          async result() { await started; return { result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId }; },
          async snapshot() { return { backendKind: "mock", sessionId: "saved-provider-session", identity,
            providerSessionId: "saved-provider-session", activeTurnId: null, pendingRuntimeRequests: [], lineage: [], cursor: "1" }; },
          async close() { closeStarted.push(identity.runId); await closeGate; closed.push(identity.runId); },
        };
        opened.push(session);
        return session;
      };
      return {
        async descriptor() { return { kind: "mock", name: "Controlled local provider", version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
        async openSession() { return makeSession(); },
        async recoverSession(checkpoint) {
          expect(checkpoint.providerSessionId).toBe("saved-provider-session");
          recovered.push(checkpoint.providerSessionId!);
          return { recovered: true, session: makeSession() };
        },
      };
    };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: backendFactory });
    try {
      await settings.updateExperimental({ enableNativeRunner: true });
      await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", { actorType: "user", actorId: userId });
      await heartbeat.drainActiveRunExecutions();
      await heartbeat.reconcileCostAccounting();
      await flushBudgetEvaluationWork(db, { companyId });
      expect(turns).toHaveLength(1);
      expect(opened).toHaveLength(1);
      const [first] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, turns[0]));
      expect(first.status).toBe("succeeded");
      expect(await db.select().from(nativeRunResults).where(and(eq(nativeRunResults.runId, first.id), eq(nativeRunResults.schemaStatus, "accepted")))).toHaveLength(1);
      expect(JSON.stringify(first.runnerProfileJson)).not.toContain(credential);
      expect(readNativeSessionIdleWork()).toBe("present");
      const sessionsBefore = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.agentId, agentId)));
      expect(sessionsBefore).toHaveLength(1);
      expect(JSON.stringify(sessionsBefore)).toContain("saved-provider-session");
      const [encryptedBefore] = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id));
      expect(encryptedBefore.material).toMatchObject({ scheme: "local_encrypted_v1", ciphertext: expect.any(String) });
      expect(JSON.stringify(encryptedBefore.material)).not.toContain(credential);
      closeGate = new Promise<void>(resolve => { finishClose = resolve; });
      const hold = heartbeat.startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
      const inspecting = readIdleSleepSafety(db, heartbeat.getTaskDrainStatus, Date.now, hold.ownerId,
        async () => readNativeSessionIdleWork(), undefined, undefined, false, false,
        { prepareLocalWork: async ({ canPrepare }) => {
          const result = await heartbeat.prepareIdleWarmNativeSessionsForSleep({ canRetire: canPrepare });
          return result.busy || result.failed ? "present" : "none";
        } });
      let inspectionSettled = false;
      void inspecting.then(() => { inspectionSettled = true; });
      try {
        await vi.waitFor(() => expect(closeStarted).toEqual([turns[0]]));
        expect(readNativeSessionIdleWork()).toBe("present");
        expect(closed).toEqual([]);
        expect(inspectionSettled).toBe(false);
        finishClose!();
        const prepared = await inspecting;
        const diagnostic = prepared.backgroundWork === "none" ? undefined : await readIdleSleepSafety(db, heartbeat.getTaskDrainStatus, Date.now, hold.ownerId,
          async () => readNativeSessionIdleWork(), undefined, undefined, false, false, { collectDiagnostics: true });
        expect(prepared.backgroundWork, JSON.stringify(diagnostic?.diagnostics)).toBe("none");
      } finally { finishClose!(); await inspecting; heartbeat.stopTaskDrain(); }
      expect(closed).toEqual([turns[0]]);
      expect(readNativeSessionIdleWork()).toBe("none");
      expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, sessionsBefore[0].id))).toEqual(sessionsBefore);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", userId, source: "local_implicit" }; next(); });
      app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
      app.use(errorHandler);
      heartbeat.startTaskDrain({ ttlMs: 60_000 });
      try {
        await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Continue the saved work and record the continuation.", reopen: true, resume: true }).expect(201);
        await vi.waitFor(async () => {
          const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_reopened_via_comment")));
          expect(wakes).toHaveLength(1);
          expect(wakes[0].requestedByActorId).toBe(userId);
          expect(heartbeat.getTaskDrainStatus().pendingWakes).toBe(0);
        });
        expect(turns).toHaveLength(1);
      } finally { heartbeat.stopTaskDrain(); }
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      await heartbeat.reconcileCostAccounting();
      await flushBudgetEvaluationWork(db, { companyId });
      expect(turns).toHaveLength(2);
      expect(new Set(turns).size).toBe(2);
      expect(opened).toHaveLength(2);
      expect(opened[1]).not.toBe(opened[0]);
      expect(recovered).toEqual(["saved-provider-session"]);
      expect(executions[1].session.normalizedSessionId).toBe(executions[0].session.normalizedSessionId);
      const [continued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, turns[1]));
      expect(continued.status).toBe("succeeded");
      expect(await db.select().from(nativeRunResults).where(and(eq(nativeRunResults.runId, continued.id), eq(nativeRunResults.schemaStatus, "accepted")))).toHaveLength(1);
      expect(await readFile(join(executions[1].workspace.cwd!, "continued.txt"), "utf8")).toBe("continued first useful work\n");
      expect((await db.select().from(companySecretVersions).where(eq(companySecretVersions.id, encryptedBefore.id)))[0].material).toEqual(encryptedBefore.material);
    } finally {
      finishClose?.();
      heartbeat.stopTaskDrain();
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await settings.updateExperimental(previousSettings);
      await db.$client.end();
    }
  }, 40_000);
});

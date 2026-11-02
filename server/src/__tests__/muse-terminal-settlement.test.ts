import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, closeRegisteredClients,
  externalAgentHolds, heartbeatRuns, issues, completionContracts, nativeRunResults, nativeRunFinalizations, museAgentBindings as bindings,
  museRunnerAssignments as assignments, museRunnerOperations as operations, type Db } from "@paperclipai/db";
import { notifyNativeFinalizationWork } from "../services/native-finalization-notifications.js";
import { projectCommittedRun } from "../services/native-runtime/native-run-projection.js";
import { heartbeatService } from "../services/heartbeat.js";
import { museIdentity, museCredentialHash } from "../services/muse-identity.js";
import { museRunnerBroker } from "../services/muse-runner-broker.js";
import { startMuseMaintenance } from "../services/muse-maintenance.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../services/heartbeat/run-lifecycle.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { setTimeout as delay } from "node:timers/promises";
import { externalOperationDigest, type ExternalProviderOperation } from "../vendor/paperclip-runner/index.js";



describe("Muse terminal settlement lifecycle", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MUSE_SETTLEMENT_TEST_DATABASE_URL");
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let stop: ReturnType<typeof startMuseMaintenance> | undefined;
  let admitted = true, recover = true;
  const errors: unknown[] = [], detachers: Array<() => Promise<void>> = [];
  beforeEach(() => {
    admitted = true; recover = true; errors.length = 0;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("muse-terminal-settlement-");
    db = createDb(external ?? temporary!.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true, enableMuse: true });
  }, 30_000);
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    await stop?.(); stop = undefined;
    for (const detach of detachers.splice(0)) await detach();
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });
  async function start(canSettle: () => Promise<boolean> = async () => recover, database: Db = db) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted,
      canReconcile: () => true, onError: error => errors.push(error) });
    stop = startMuseMaintenance(database, coordinator, canSettle);
    await stop.ready;
  }
  async function idle() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 5000 });
  }
  async function quiet() {
    const previous = db.$client.options.debug, queries: string[] = [];
    db.$client.options.debug = (_id, query) => queries.push(query);
    try { await vi.advanceTimersByTimeAsync(600_000); await delay(10); expect(queries).toEqual([]); }
    finally { db.$client.options.debug = previous; }
  }
  const lifecycle = (writer: Db = db) => createHeartbeatLifecycle(writer,
    { emitTerminalAgentTaskRun: vi.fn() } as unknown as HeartbeatLifecycleDependencies);
  const readAssignment = async (id: string) => (await db.select().from(assignments).where(eq(assignments.id, id)))[0];
  const readHold = async (id: string) => (await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId, id)))[0];
  async function acceptedResult() {
    const f = await active();
    await f.broker.act(f.subject, { version: 1, command: "accept", assignmentId: f.assignment.id, requestId: randomUUID() });
    await f.broker.act(f.subject, { version: 1, command: "finish", assignmentId: f.assignment.id, requestId: randomUUID(), result: {} });


    await f.detach();
    return f;
  }
  afterAll(async () => { await closeRegisteredClients(external ?? temporary!.connectionString); await temporary?.cleanup(); });
  async function fixture(ready=true) {
    const operatorId=randomUUID();await db.insert(authUsers).values({id:operatorId,name:"Muse authorizer",email:operatorId+"@example.test",createdAt:new Date(),updatedAt:new Date()});
    const [company]=await db.insert(companies).values({name:"Muse control",issuePrefix:"MU"+operatorId.replaceAll("-","")}).returning();
    const [agent]=await db.insert(agents).values({companyId:company.id,name:"Muse",role:"engineer",status:"active",adapterType:"paperclip_runner",adapterConfig:{provider:"muse",allowUnmeteredProvider:true,lifecycle:"per_turn"},permissions:{canCreateTasks:true}}).returning();
    await db.insert(companyMemberships).values([{companyId:company.id,principalType:"user",principalId:operatorId,membershipRole:"owner",status:"active"},{companyId:company.id,principalType:"agent",principalId:agent.id,membershipRole:"member",status:"active"}]);
    const ticket=randomBytes(32).toString("base64url");const [binding]=await db.insert(bindings).values({companyId:company.id,agentId:agent.id,operatorId,ticketHash:museCredentialHash(ticket),ticketExpiresAt:new Date(Date.now()+600000)}).returning();
    await db.update(agents).set({adapterConfig:{...agent.adapterConfig,museBindingId:binding.id}}).where(eq(agents.id,agent.id));
    const identity=museIdentity(db),credentials=await identity.pair(ticket,"2"),broker=museRunnerBroker(db,{publicOrigin:"https://paperclip.example",heartbeat:{wakeup:vi.fn().mockResolvedValue(null),cancelRun:vi.fn()}});
    if(ready)await db.update(bindings).set({status:"ready",receiverContactAt:new Date(),verifiedReplyAt:new Date()}).where(eq(bindings.id,binding.id));
    return {company,agent,operatorId,binding,ticket,identity,credentials,broker,subject:await identity.authenticate(credentials.accessToken)};
  }
  async function active(provided?:Awaited<ReturnType<typeof fixture>>,afterSettle?: (command:ExternalProviderOperation)=>Promise<void>) {
    const f=provided??await fixture(),runId=randomUUID(),session=randomUUID(),turnId="turn_"+randomUUID();
    const [issue]=await db.insert(issues).values({companyId:f.company.id,title:"Muse task",status:"in_progress",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
    await db.insert(heartbeatRuns).values({id:runId,companyId:f.company.id,agentId:f.agent.id,status:"running",runtimeMode:"native",driverKind:"muse_external",nativeIssueId:issue.id,nativeSessionId:session,nativePhase:"turn_running",responsibleUserId:f.operatorId});
    await db.update(issues).set({checkoutRunId:runId,executionRunId:runId}).where(eq(issues.id,issue.id));
    await db.insert(nativeRunFinalizations).values({runId,companyId:f.company.id,issueId:issue.id,phase:"running",controllerGeneration:1,leaseExpiresAt:new Date(Date.now()+600000)});
    const execution={binding:{companyId:f.company.id,agentId:f.agent.id,runId},provider:{binding:await f.broker.snapshot(f.company.id,f.agent.id,f.binding.id)}};
    const port=f.broker.port(execution),sent:ExternalProviderOperation[]=[];
    const detach=await port.attach(async command=>{sent.push(command);await port.settle({sourceEventId:"settle_"+command.requestId,payload:{binding:ref,requestId:command.requestId,outcome:command.action==="consume_input"?{status:"consumed",requestId:command.input.requestId,inputDigest:command.input.inputDigest}:{status:command.action==="accept"?"accepted":"completed"}}});await afterSettle?.(command);});
    const ref={...execution.provider.binding,runId,normalizedSessionId:session,turnId,assignmentRevision:1};
    await port.dispatch({sourceEventId:"offer_"+randomUUID(),payload:{kind:"assignment",binding:ref,tools:[],acceptByUnixMs:Date.now()+600000,expiresAtUnixMs:Date.now()+3600000}});
    const [assignment]=await db.select().from(assignments).where(eq(assignments.runId,runId));
    detachers.push(detach);
    return {...f,runId,issue,port,ref,assignment,sent,detach};
  }
  it("ignores routine company-only finalization hints and still settles a committed Muse run", async () => {
    const f = await acceptedResult();
    await start(); await idle(); await quiet();
    const previous = db.$client.options.debug, queries: string[] = [];
    db.$client.options.debug = (_id, query) => queries.push(query);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await db.transaction(tx => notifyNativeFinalizationWork(tx, { companyId: f.company.id }));
        await idle();
      }
      expect(queries.filter(query => query.includes('"muse_runner_assignments"'))).toEqual([]);
    } finally { db.$client.options.debug = previous; }
    expect((await readAssignment(f.assignment.id)).finalizedAt).toBeNull();
    await lifecycle().setRunStatus(f.runId, "succeeded", { finishedAt: new Date() });
    await idle();
    expect((await readAssignment(f.assignment.id)).finalizedAt).not.toBeNull();
    expect(errors).toEqual([]); await quiet();
  });

  it("settles Muse from the real terminal run producer after becoming idle", async () => {
    const f = await acceptedResult();
    await start(); await idle(); await quiet();
    await lifecycle().setRunStatus(f.runId, "succeeded", { finishedAt: new Date() });
    await idle();
    expect((await readAssignment(f.assignment.id)).finalizedAt).not.toBeNull();
    expect(await readHold(f.assignment.id)).toMatchObject({ workerUnknown: false, nativeEffectsUnknown: false, releasedAt: expect.any(Date) });
    expect(errors).toEqual([]); await quiet();
  });

  it.each(["commit", "rollback"] as const)("respects the terminal writer's outer transaction (%s)", async outcome => {
    const f = await acceptedResult(); await start(); await idle();
    let release!: () => void, written!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { written = resolve; });
    const transaction = db.transaction(async tx => {
      await tx.transaction(async nested => { await lifecycle(nested as unknown as Db)
        .setRunStatus(f.runId, "succeeded", { finishedAt: new Date() }); });
      written(); await gate;
      if (outcome === "rollback") throw new Error("rollback fixture");
    });
    try {
      await ready; expect((await readAssignment(f.assignment.id)).finalizedAt).toBeNull();
      release();
      if (outcome === "rollback") await expect(transaction).rejects.toThrow("rollback fixture");
      else await transaction;
      await idle();
      expect((await readAssignment(f.assignment.id)).finalizedAt !== null).toBe(outcome === "commit");
      expect(errors).toEqual([]); await quiet();
    } finally { release(); await transaction.catch(() => {}); }
  });

  it("retains the first terminal wake through drain without passive SQL", async () => {
    const f = await acceptedResult(); await start(); await idle(); admitted = false;
    await lifecycle().setRunStatus(f.runId, "succeeded", { finishedAt: new Date() });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    expect((await readAssignment(f.assignment.id)).finalizedAt).toBeNull();
    await quiet(); admitted = true;
    await vi.advanceTimersByTimeAsync(5000); await idle();
    expect((await readAssignment(f.assignment.id)).finalizedAt).not.toBeNull();
    expect(errors).toEqual([]); await quiet();
  });

  it("keeps terminal work suppressed until a committed reactivation", async () => {
    const f = await acceptedResult();
    await lifecycle().setRunStatus(f.runId, "succeeded", { finishedAt: new Date() });
    recover = false; await start(); await idle(); await quiet();
    expect((await readAssignment(f.assignment.id)).finalizedAt).toBeNull();
    recover = true;
    await instanceSettingsService(db).updateExperimental({ enableWorktreeRunExecution: true });
    await idle();
    expect((await readAssignment(f.assignment.id)).finalizedAt).not.toBeNull();
    expect(errors).toEqual([]); await quiet();
  });

  it.each(["restore", "worktree"] as const)("honors the real %s suppression gate", async mode => {
    const f = await acceptedResult();
    await lifecycle().setRunStatus(f.runId, "succeeded", { finishedAt: new Date() });
    const runtimeEnv = mode === "restore" ? { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true" }
      : { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "muse-settlement-test" };
    const settings = instanceSettingsService(db, { runtimeEnv });
    if (mode === "worktree") await settings.updateExperimental({ enableWorktreeRunExecution: false });
    const heartbeat = heartbeatService(db, { runtimeEnv });
    await start(async () => {
      const state = await heartbeat.resolveSchedulingSuppression(true);
      return !state.suppressed || state.reason === "task_drain";
    });
    await idle(); await quiet();
    expect((await readAssignment(f.assignment.id)).finalizedAt).toBeNull();
    if (mode === "worktree") {
      try {
        await settings.updateExperimental({ enableWorktreeRunExecution: true });
        await idle();
        expect((await readAssignment(f.assignment.id)).finalizedAt).not.toBeNull();
        await quiet();
      } finally { await settings.updateExperimental({ enableWorktreeRunExecution: false }); }
    }
    expect(errors).toEqual([]);
  });

  it("limits a committed terminal hint to its original scope", async () => {
    const first = await acceptedResult(), other = await acceptedResult();
    await start(); await idle();


    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, other.runId));
    await lifecycle().setRunStatus(first.runId, "succeeded", { finishedAt: new Date() });
    await idle();
    expect((await readAssignment(first.assignment.id)).finalizedAt).not.toBeNull();
    expect((await readAssignment(other.assignment.id)).finalizedAt).toBeNull();
    await quiet();
    await coordinator!.stop(); await stop!(); await start(); await idle();
    expect((await readAssignment(other.assignment.id)).finalizedAt).not.toBeNull();
    expect(errors).toEqual([]); await quiet();
  });

  it("preserves a global settings wake alongside scoped writes in one outer transaction", async () => {
    const first = await acceptedResult(), other = await acceptedResult();
    await start(); await idle();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, other.runId));
    await db.transaction(async tx => {
      await instanceSettingsService(tx as unknown as Db).updateExperimental({ enableWorktreeRunExecution: true });
      await lifecycle(tx as unknown as Db).setRunStatus(first.runId, "succeeded", { finishedAt: new Date() });
    });
    await idle();
    expect((await readAssignment(first.assignment.id)).finalizedAt).not.toBeNull();
    expect((await readAssignment(other.assignment.id)).finalizedAt).not.toBeNull();
    expect(errors).toEqual([]); await quiet();
  });

  it("retains a failed scoped sweep through drain and reconstructs it after restart", async () => {
    const f = await acceptedResult(); let fail = false;
    const observed = new Proxy(db, { get(target, key) {
      if (key === "selectDistinct" && fail) return () => { throw new Error("settlement discovery unavailable"); };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await start(undefined, observed); await idle(); fail = true;
    await lifecycle().setRunStatus(f.runId, "succeeded", { finishedAt: new Date() });
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(0); expect(errors.length).toBeGreaterThan(0); });
    admitted = false;

    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    expect((await readAssignment(f.assignment.id)).finalizedAt).toBeNull(); await quiet();
    await coordinator!.stop(); await stop!(); errors.length = 0; admitted = true;
    await start(); await idle();
    expect((await readAssignment(f.assignment.id)).finalizedAt).not.toBeNull();
    expect(errors).toEqual([]); await quiet();
  });

  it.each([false, true])("retains a concurrent hint while settlement is in flight (shutdown: %s)", async shutdown => {
    const first = await acceptedResult(), second = await acceptedResult();
    let block = false, entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    await start(async () => { if (block) { entered(); await gate; } return true; }); await idle();
    block = true;
    await lifecycle().setRunStatus(first.runId, "succeeded", { finishedAt: new Date() });
    await vi.advanceTimersByTimeAsync(0); await ready;
    await lifecycle().setRunStatus(second.runId, "succeeded", { finishedAt: new Date() });
    try {
      if (shutdown) {
        let stopped = false;
        const stopping = coordinator!.stop().then(() => { stopped = true; });
        await delay(10); expect(stopped).toBe(false);
        release(); await stopping; await stop!(); await start();
      } else { block = false; release(); }
      await idle();
      expect((await readAssignment(first.assignment.id)).finalizedAt).not.toBeNull();
      expect((await readAssignment(second.assignment.id)).finalizedAt).not.toBeNull();

      if (!shutdown) expect(errors).toEqual([]);
      await quiet();
    } finally { release(); }
  });

  it("wakes from the actual committed run projection owner", async () => {
    const f = await acceptedResult();


    const contractId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: f.company.id, issueId: f.issue.id,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "settlement-test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "settlement-test", objective: "Finish", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ completionContractId: contractId }).where(eq(heartbeatRuns.id, f.runId));
    const [result] = await db.insert(nativeRunResults).values({ companyId: f.company.id, issueId: f.issue.id,
      runId: f.runId, completionContractId: contractId, serverFingerprint: randomUUID(), canonicalSha256: randomUUID(),
      schemaStatus: "accepted", resultJson: { terminal: { runTerminalState: "succeeded" } } }).returning();
    const [finalization] = await db.update(nativeRunFinalizations).set({ resultId: result.id, phase: "committed" })
      .where(eq(nativeRunFinalizations.runId, f.runId)).returning();
    await start(); await idle(); await quiet();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await projectCommittedRun({ db, run, coordinator: finalization });
    await idle();
    expect((await readAssignment(f.assignment.id)).finalizedAt).not.toBeNull();
    expect((await readHold(f.assignment.id)).releasedAt).not.toBeNull();
    expect(errors).toEqual([]); await quiet();
  });

  it("drains more than one maintenance batch while preserving unbounded manual settlement", async () => {
    const f = await acceptedResult();
    const [template] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const assignment = await readAssignment(f.assignment.id);
    const historical = Array.from({ length: 101 }, () => ({ runId: randomUUID(), assignmentId: randomUUID(), sessionId: randomUUID() }));
    await db.insert(heartbeatRuns).values(historical.map(row => ({ ...template, id: row.runId,
      nativeSessionId: row.sessionId, status: "succeeded", finishedAt: new Date() })));
    await db.insert(assignments).values(historical.map(row => ({ ...assignment, id: row.assignmentId,
      runId: row.runId, normalizedSessionId: row.sessionId, turnId: randomUUID(), finalizedAt: null })));
    await start();
    const missing = () => db.select().from(assignments).where(sql`${assignments.id} in (${sql.join(historical.map(row => sql`${row.assignmentId}::uuid`), sql`,`)}) and ${assignments.finalizedAt} is null`);
    expect(await missing()).toHaveLength(1);
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5000); await idle();
    expect(await missing()).toHaveLength(0); await quiet();
    await db.update(assignments).set({ finalizedAt: null }).where(eq(assignments.bindingId, f.binding.id));
    await f.broker.reconcileTerminalAssignments(f.company.id, f.agent.id, f.binding.id);
    expect(await missing()).toHaveLength(0);
    expect(errors).toEqual([]); await quiet();
  });

  it("keeps a fenced worker held when a late native result resolves only its effect", async () => {
    const f = await active();
    await f.broker.act(f.subject, { version: 1, command: "accept", assignmentId: f.assignment.id, requestId: randomUUID() });
    const requestId = randomUUID(), input = { result: {} };


    await db.insert(operations).values({ companyId: f.company.id, assignmentId: f.assignment.id, requestId,
      digest: externalOperationDigest("finish", input), command: { ...f.ref, requestId, action: "finish", input,
        digest: externalOperationDigest("finish", input) }, status: "pending" });
    await f.detach();
    await start(); await idle();
    await lifecycle().setRunStatus(f.runId, "succeeded", { finishedAt: new Date() });
    await idle();
    expect((await readAssignment(f.assignment.id)).status).toBe("fenced");
    expect(await readHold(f.assignment.id)).toMatchObject({ workerUnknown: true, nativeEffectsUnknown: true, releasedAt: null });
    await f.port.settle({ sourceEventId: randomUUID(), payload: { binding: f.ref, requestId, outcome: { status: "completed" } } });
    await idle();
    expect((await readAssignment(f.assignment.id)).status).toBe("fenced");
    expect(await readHold(f.assignment.id)).toMatchObject({ workerUnknown: true, nativeEffectsUnknown: false, releasedAt: null });
    expect(errors).toEqual([]); await quiet();
  });

  it("reconstructs timestamp settlement on an original revoked binding", async () => {
    const f = await acceptedResult();


    await db.update(externalAgentHolds).set({ workerUnknown: false, releasedAt: new Date() })
      .where(eq(externalAgentHolds.assignmentId, f.assignment.id));
    await f.broker.revoke(f.company.id, f.agent.id, f.operatorId);
    await db.update(agents).set({ adapterConfig: { provider: "codex" } }).where(eq(agents.id, f.agent.id));
    await lifecycle().setRunStatus(f.runId, "succeeded", { finishedAt: new Date() });
    await start(); await idle();
    expect((await readAssignment(f.assignment.id)).finalizedAt).not.toBeNull();
    expect((await readAssignment(f.assignment.id)).status).toBe("settled");
    expect((await readHold(f.assignment.id)).releasedAt).not.toBeNull();
    expect(errors).toEqual([]); await quiet();
  });

  it("does not fence successor work while repairing historical failed settlement", async () => {
    const f = await acceptedResult();

    await db.update(externalAgentHolds).set({ workerUnknown: false, releasedAt: new Date() })
      .where(eq(externalAgentHolds.assignmentId, f.assignment.id));
    await lifecycle().setRunStatus(f.runId, "failed", { finishedAt: new Date() });
    const successor = await active(f);
    await successor.detach();
    await start(); await idle();
    expect((await readAssignment(f.assignment.id)).finalizedAt).not.toBeNull();
    expect((await readAssignment(successor.assignment.id)).status).toBe("offered");
    expect(errors).toEqual([]); await quiet();
  });
});

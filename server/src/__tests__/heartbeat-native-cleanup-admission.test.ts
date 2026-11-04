import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { NativeStartupCleanupPendingError, readNativeStartupCleanup } from "../services/native-runtime/native-startup-cleanup.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import { environmentService } from "../services/environments.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })) };
});
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("native terminal-run cleanup admission", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-cleanup-admission-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  it("holds the same task until its native executor settles while allowing unrelated tasks", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cleanup admission", issuePrefix: "CLN", defaultResponsibleUserId: "owner" });
    await db.insert(authUsers).values({ id: "owner", name: "Fixture user", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: {}, permissions: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 20 } } });
    await db.insert(issues).values([issueId, otherIssueId].map(id => ({ id, companyId, title: "Recovery task", status: "todo", assigneeAgentId: agentId, responsibleUserId: "owner" })));
    let release!: () => void, entered!: () => void;
    const cleanupGate = new Promise<void>(resolve => { release = resolve; });
    const terminal = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    execute.mockImplementation(async (context: { runId: string; context: { issueId: string } }) => {
      if (first) {
        first = false;
        // Native finalization commits success before workspace/lease cleanup
        // finishes. Keep the real heartbeat executor alive across that boundary.
        await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native", finishedAt: new Date() }).where(eq(heartbeatRuns.id, context.runId));
        entered();
        await cleanupGate;
      } else {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, context.context.issueId));
      }
      return { exitCode: 0, signal: null, timedOut: false, summary: "Completed" };
    });
    const heartbeat = heartbeatService(db);
    const nextId = randomUUID(), otherId = randomUUID();
    try {
      await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
      await terminal;
      await db.insert(heartbeatRuns).values([
        { id: nextId, companyId, agentId, status: "queued", invocationSource: "on_demand", responsibleUserId: "owner", contextSnapshot: { issueId } },
        { id: otherId, companyId, agentId, status: "queued", invocationSource: "on_demand", responsibleUserId: "owner", contextSnapshot: { issueId: otherIssueId } },
      ]);
      await heartbeat.resumeQueuedRuns();
      expect((await heartbeat.getRun(nextId))?.status).toBe("queued");
      expect((await heartbeat.getRun(otherId))?.status).not.toBe("queued");
    } finally {
      release();
      await heartbeat.drainActiveRunExecutions();
    }
    expect((await heartbeat.getRun(nextId))?.status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(3);
  }, 30_000);

  it("retries a failed startup intent through timer failure and drain before verified cancellation", async () => {
    const home = createIsolatedTestHome(), originalHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home.home;
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), leaseId = randomUUID();
    const contextId = randomUUID(), leaseOwner = randomUUID(), taskId = randomUUID(), deadlineAtMs = Date.now() - 1;
    const originalSetTimeout = globalThis.setTimeout;
    const retries: Array<{ timer: ReturnType<typeof setTimeout>; fire(): void }> = [];
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (typeof delay === "number" && delay <= 30_000 && new Error().stack?.includes("scheduleNativeSessionResumeDispatch")) {
        const timer = originalSetTimeout(() => {}, 3_600_000);
        retries.push({ timer, fire() { clearTimeout(timer); callback(...args); } });
        return timer;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    let failSuppression = false, runId = "";
    const runtimeEnv = new Proxy<Record<string, string | undefined>>({}, { get(_target, key) {
      if (key === "PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS" && failSuppression) {
        failSuppression = false;
        throw new Error("Scheduling dependency unavailable");
      }
      return undefined;
    } });
    const heartbeat = heartbeatService(db, { runtimeEnv });
    try {
      await db.insert(companies).values({ id: companyId, name: "Intent retry", issuePrefix: "CIR", defaultResponsibleUserId: "owner" });
      await db.insert(authUsers).values({ id: "owner", name: "Fixture user", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", status: "active", membershipRole: "member" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process",
        adapterConfig: {}, permissions: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
      await db.insert(issues).values({ id: issueId, companyId, title: "Recover startup", status: "todo", assigneeAgentId: agentId, responsibleUserId: "owner" });
      const [environment] = await db.insert(environments).values({ name: "Controlled provider", driver: "plugin", config: {} }).returning();
      await db.execute(sql`create table test_cleanup_intent_fault (enabled boolean not null)`);
      await db.execute(sql`insert into test_cleanup_intent_fault values (true)`);
      await db.execute(sql`create sequence test_cleanup_intent_attempts`);
      await db.execute(sql.raw(`create function test_reject_cleanup_intent() returns trigger language plpgsql as $$ begin
        if new.company_id = '${companyId}'::uuid and new.error_code = 'native_startup_cleanup_pending'
          and exists (select 1 from test_cleanup_intent_fault where enabled) then
          perform nextval('test_cleanup_intent_attempts'); raise exception 'Cleanup intent write unavailable';
        end if; return new; end $$`));
      await db.execute(sql`create trigger test_cleanup_intent_fault before update on heartbeat_runs for each row execute function test_reject_cleanup_intent()`);
      execute.mockReset();
      execute.mockImplementation(async (context: { runId: string }) => {
        runId = context.runId;
        const [run] = await db.update(heartbeatRuns).set({ runtimeMode: "native", runtimeModeResolvedAt: null }).where(eq(heartbeatRuns.id, runId)).returning();
        await prepareNativeHeartbeatRun({ db, run, issue: { id: issueId, title: "Recover startup", description: null }, environmentLeaseId: leaseId });
        await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } }).where(eq(agents.id, agentId));
        await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
        await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 1,
          controllerGeneration: 1, leaseOwner, leaseExpiresAt: new Date(Date.now() - 1_000) });
        await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId: environment.id, heartbeatRunId: runId,
          issueId, status: "active", provider: "plugin", providerLeaseId: taskId, leasePolicy: "reuse_by_environment", metadata: { runnerTaskLease: true } });
        await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({
          nativeStartupContext: { schema: "paperclip.native-startup-context.v1", companyId, agentId, runId,
            contextId, deadlineAtMs, leaseId, leaseOwner, controllerGeneration: 1, attempt: 1 },
        })}::jsonb` }).where(eq(heartbeatRuns.id, runId));
        throw new NativeStartupCleanupPendingError(contextId, deadlineAtMs, leaseOwner, false, leaseId);
      });
      await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
      await heartbeat.drainActiveRunExecutions();
      const owner = () => db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)).then(rows => rows[0]!);
      const lease = () => db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)).then(rows => rows[0]!);
      expect((await db.execute<{ last_value: string }>(sql`select last_value from test_cleanup_intent_attempts`))[0].last_value).toBe("2");
      expect(await heartbeat.getRun(runId)).toMatchObject({ status: "running", errorCode: null });
      expect((await owner()).leaseOwner).toBe(leaseOwner);
      expect(await lease()).toMatchObject({ status: "active", cleanupStatus: null });
      expect(readNativeStartupCleanup((await heartbeat.getRun(runId))!)).toBeNull();
      const drainedRetries = retries.length;
      expect(drainedRetries).toBeGreaterThan(0);
      await heartbeat.resumeQueuedRunsAfterDrain();
      expect(retries.length).toBeGreaterThan(drainedRetries);
      const resumedRetries = retries.length;
      failSuppression = true;
      retries.at(-1)!.fire();
      await vi.waitFor(() => expect(retries.length).toBeGreaterThan(resumedRetries));
      expect((await owner()).leaseOwner).toBe(leaseOwner);
      expect((await heartbeat.getRun(runId))?.status).toBe("running");
      await db.execute(sql`update test_cleanup_intent_fault set enabled = false`);
      retries.at(-1)!.fire();
      await vi.waitFor(async () => expect(readNativeStartupCleanup((await heartbeat.getRun(runId))!)?.state).toBe("pending"));
      await vi.waitFor(async () => expect((await heartbeat.listEvents(runId)).some(event => event.eventType === "native.recovery.transition")).toBe(true));
      const current = await lease();
      await environmentService(db).releaseLease(leaseId, "released", { cleanupStatus: "success",
        remoteExecutionTermination: remoteTerminationReceipt(current, { providerLeaseId: taskId, state: "stopped" }) });
      await heartbeat.cancelRun(runId, "Startup cleanup retry completed");
      expect(await heartbeat.getRun(runId)).toMatchObject({ status: "cancelled" });
      expect(readNativeStartupCleanup((await heartbeat.getRun(runId))!)?.state).toBe("complete");
      expect(await owner()).toMatchObject({ leaseOwner: null, controlDeadlineAt: null });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await heartbeat.drainActiveRunExecutions();
      timeout.mockRestore();
      for (const retry of retries) clearTimeout(retry.timer);
      await db.execute(sql`drop trigger if exists test_cleanup_intent_fault on heartbeat_runs`);
      await db.execute(sql`drop function if exists test_reject_cleanup_intent()`);
      await db.execute(sql`drop table if exists test_cleanup_intent_fault`);
      await db.execute(sql`drop sequence if exists test_cleanup_intent_attempts`);
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      home.cleanup();
    }
  }, 30_000);

});

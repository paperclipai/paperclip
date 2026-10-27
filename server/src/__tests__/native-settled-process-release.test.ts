import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { spawn } from "node:child_process";
import os from "node:os";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { persistHeartbeatRunProcessMetadata } from "../services/heartbeat/run-lifecycle.js";
import {
  hasNativeLocalProcessStop,
  readNativeLocalProcessStop,
  discoverSettledNativeRunProcesses,
  pendingSettledNativeRunProcessIds,
  releaseSettledNativeRunProcess,
  retryPendingSettledNativeRunProcesses,
  settleNativeRunProcess,
  withReleasedNativeRunProcess,
} from "../services/native-local-process-stop.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { heartbeatService } from "../services/heartbeat.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })) };
});

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

function startDetached() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

async function exitedPid() {
  const child = startDetached();
  const pid = child.pid!;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  return pid;
}

suite("settled native run process identity", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let companyId: string;
  let agentId: string;
  const children: ReturnType<typeof startDetached>[] = [];

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-settled-process-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Settled processes", issuePrefix: "SPR", defaultResponsibleUserId: "owner" });
    await db.insert(authUsers).values({ id: "owner", name: "Fixture user", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: {}, permissions: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 20 } } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(() => {
    for (const child of children.splice(0)) {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { }
    }
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  type Fixture = {
    status?: string;
    phase?: string | null;
    pid?: number;
    hostname?: string;
    checkpoint?: boolean;
    providerEvidence?: boolean;
    leases?: Array<"local" | "local_unreleased" | "remote_stopped" | "remote_unconfirmed">;
    finishedAt?: Date;
  };

  async function seed(fixture: Fixture = {}) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const pid = fixture.pid ?? await exitedPid();
    await db.insert(issues).values({ id: issueId, companyId, title: "Settled process", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
      invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId },
      runnerProfileJson: fixture.checkpoint === false ? {} : { sessionCheckpoint: { providerSessionId: "thread" } },
    });
    if (fixture.hostname) {
      await db.update(heartbeatRuns).set({ processPid: pid, processGroupId: pid, processStartedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      await appendHeartbeatRunEvent(db, { companyId, runId, agentId, eventType: "native.process_identity_recorded", stream: "system", level: "info",
        message: "Process identity recorded", payload: { targetKind: "local", hostname: fixture.hostname, processPid: pid, processGroupId: pid } });
    } else {
      await persistHeartbeatRunProcessMetadata(db, runId, { pid, processGroupId: pid, startedAt: new Date().toISOString(), targetKind: "local" });
    }
    if (fixture.providerEvidence) {
      await appendHeartbeatRunEvent(db, { companyId, runId, agentId, eventType: "harness.ready", stream: "system", level: "info", message: "ready" });
    }
    if (fixture.phase !== null) {
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: fixture.phase ?? "committed" });
    }
    for (const kind of fixture.leases ?? ["local"]) {
      const remote = kind.startsWith("remote");
      const [lease] = await db.insert(environmentLeases).values({
        companyId, issueId, heartbeatRunId: runId, provider: remote ? "sandbox-fixture" : "local",
        providerLeaseId: remote ? randomUUID() : null, leasePolicy: "ephemeral",
        status: kind === "local_unreleased" ? "active" : "released", releasedAt: kind === "local_unreleased" ? null : new Date(),
        cleanupStatus: kind === "local_unreleased" ? null : "success",
      }).returning();
      if (kind === "remote_stopped") {
        await db.update(environmentLeases).set({ metadata: {
          remoteExecutionTermination: remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: "stopped" }),
        } }).where(eq(environmentLeases.id, lease!.id));
      }
    }
    await db.update(heartbeatRuns).set({ status: fixture.status ?? "failed", finishedAt: fixture.finishedAt ?? new Date() })
      .where(eq(heartbeatRuns.id, runId));
    return { runId, issueId, pid };
  }

  const readRun = (runId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]!);

  it("releases a failed native run's local identity with a stop receipt once its process is gone", async () => {
    const { runId, pid } = await seed();
    expect(await readRun(runId)).toMatchObject({ processPid: pid, processGroupId: pid });
    const before = await readRun(runId);
    expect(await releaseSettledNativeRunProcess(db, runId)).toBe("released");
    const after = await readRun(runId);
    expect(after).toMatchObject({ status: "failed", processPid: null, processGroupId: null, processStartedAt: null });
    expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(true);
    expect(await readNativeLocalProcessStop(db, companyId, runId)).toEqual({
      processPid: pid, processGroupId: pid, processStartedAt: before.processStartedAt!.toISOString(),
    });
    expect(await withReleasedNativeRunProcess(db, after)).toMatchObject({
      processPid: pid, processGroupId: pid, processStartedAt: before.processStartedAt,
    });
    expect(await releaseSettledNativeRunProcess(db, runId)).toBe("skipped");
  });

  it("releases the identity from the periodic recovery sweep", async () => {
    const { runId } = await seed({ status: "timed_out" });
    const child = startDetached();
    children.push(child);
    const alive = await seed({ pid: child.pid! });
    const heartbeat = heartbeatService(db);
    await heartbeat.reapOrphanedRuns();
    expect((await readRun(runId)).processPid).toBeNull();
    expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(true);
    expect((await readRun(alive.runId)).processPid).toBe(child.pid);
    await new Promise<void>(resolve => { child.once("exit", () => resolve()); process.kill(-child.pid!, "SIGKILL"); });
    await heartbeat.reapOrphanedRuns();
    expect((await readRun(alive.runId)).processPid).toBeNull();
  }, 30_000);

  it.each([
    ["failed", true],
    ["succeeded", false],
  ] as const)("releases a %s native run's identity when its executor settles: %s", async (status, released) => {
    const pid = await exitedPid();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Executor settlement", status: "todo", assigneeAgentId: agentId, responsibleUserId: "owner" });
    let runId = "";
    execute.mockReset().mockImplementation(async (context: { runId: string }) => {
      if (runId) return { exitCode: 0, signal: null, timedOut: false, summary: "Follow-up" };
      runId = context.runId;
      await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId,
        runnerProfileJson: { sessionCheckpoint: { providerSessionId: "thread" } } }).where(eq(heartbeatRuns.id, runId));
      await persistHeartbeatRunProcessMetadata(db, runId, { pid, processGroupId: pid, startedAt: new Date().toISOString(), targetKind: "local" });
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "committed" });
      await db.update(heartbeatRuns).set({ status, finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      return { exitCode: status === "failed" ? 1 : 0, signal: null, timedOut: false, summary: "Settled" };
    });
    const heartbeat = heartbeatService(db);
    await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
    await heartbeat.drainActiveRunExecutions();
    const run = await readRun(runId);
    expect(run.status).toBe(status);
    expect(run.processPid).toBe(released ? null : pid);
    expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(released);
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId),
      eq(heartbeatRunEvents.eventType, "native.local_process_stopped")));
    expect(events).toHaveLength(released ? 1 : 0);
  }, 30_000);

  it.each(["cancelled", "timed_out", "interrupted"])("releases a settled %s native run", async status => {
    const { runId } = await seed({ status });
    expect(await releaseSettledNativeRunProcess(db, runId)).toBe("released");
    expect((await readRun(runId)).processPid).toBeNull();
  });

  it("releases the stopped identity without reading saved execution payloads", async () => {
    const { runId } = await seed();
    const bulk = randomBytes(128 * 1024).toString("base64");
    const before = await readRun(runId);
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...before.contextSnapshot, savedTask: bulk },
      runnerProfileJson: { ...before.runnerProfileJson, sessionCheckpoint: { providerSessionId: "thread", savedState: bulk },
        nativeExecutionInput: { task: bulk } }, resultJson: { savedResult: bulk }, stdoutExcerpt: bulk,
    }).where(eq(heartbeatRuns.id, runId));
    const saved = await readRun(runId);
    const events: Array<Record<string, unknown>> = [];
    const now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { heartbeatRuns }, capture);
    try { expect(await releaseSettledNativeRunProcess(db, runId)).toBe("released"); }
    finally { capture.flush(); }
    const summary = events.find(event => event.event === "paperclip.db_response_capture.summary.v1")!;
    expect(summary.responseValueBytes).toBeLessThan(8192);
    const after = await readRun(runId);
    expect(after).toEqual({ ...saved, processPid: null, processGroupId: null, processStartedAt: null,
      nextEventSeq: saved.nextEventSeq + 1, updatedAt: after.updatedAt });
    expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(bulk.slice(0, 64));
  });

  it.each([null, false, 0, "", {}, []].map(checkpoint => ({ checkpoint })))(
    "preserves checkpoint presence semantics when releasing an identity ($checkpoint)", async ({ checkpoint }) => {
      const { runId, pid } = await seed({ checkpoint: false });
      await db.update(heartbeatRuns).set({ runnerProfileJson: { sessionCheckpoint: checkpoint } })
        .where(eq(heartbeatRuns.id, runId));
      expect(await releaseSettledNativeRunProcess(db, runId)).toBe(checkpoint === null ? "skipped" : "released");
      expect((await readRun(runId)).processPid).toBe(checkpoint === null ? pid : null);
    },
  );

  it("keeps the identity while the process is still alive, then releases it after exit", async () => {
    const child = startDetached();
    children.push(child);
    const { runId } = await seed({ pid: child.pid! });
    expect(await releaseSettledNativeRunProcess(db, runId)).toBe("pending");
    expect((await readRun(runId)).processPid).toBe(child.pid);
    expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(false);
    await new Promise<void>(resolve => { child.once("exit", () => resolve()); process.kill(-child.pid!, "SIGKILL"); });
    expect(await releaseSettledNativeRunProcess(db, runId)).toBe("released");
    expect((await readRun(runId)).processPid).toBeNull();
  });

  it.each([
    ["a succeeded run that can hand its runner to the next turn", { status: "succeeded" }, "skipped"],
    ["a same-run retry that still owns the process identity", { phase: "retryable_failure" }, "skipped"],
    ["unfinished workspace finalization", { phase: "workspace_finalizing" }, "skipped"],
    ["an unreleased local lease", { leases: ["local_unreleased"] }, "pending"],
    ["a process recorded by another host", { hostname: `${os.hostname()}-other` }, "skipped"],
    ["a launch without provider evidence or checkpoint", { checkpoint: false }, "skipped"],
    ["a sandbox without a termination receipt", { leases: ["remote_unconfirmed"] }, "pending"],
    ["a mixed local and sandbox run", { leases: ["local", "remote_stopped"] }, "pending"],
  ] as const)("keeps the identity for %s", async (_name, fixture, outcome) => {
    const { runId, pid } = await seed(fixture as Fixture);
    expect(await releaseSettledNativeRunProcess(db, runId)).toBe(outcome);
    expect(await readRun(runId)).toMatchObject({ processPid: pid, processGroupId: pid });
  });

  it("releases evidence-only launches and runs without a coordinator", async () => {
    const evidence = await seed({ checkpoint: false, providerEvidence: true });
    const uncoordinated = await seed({ phase: null });
    expect(await releaseSettledNativeRunProcess(db, evidence.runId)).toBe("released");
    expect(await releaseSettledNativeRunProcess(db, uncoordinated.runId)).toBe("released");
  });

  it("releases a sandbox identity only after every lease confirmed termination", async () => {
    const { runId } = await seed({ leases: ["remote_stopped"] });
    expect(await releaseSettledNativeRunProcess(db, runId)).toBe("released");
    expect((await readRun(runId)).processPid).toBeNull();
    expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(false);
  });

  it("discovers settled runs in pages, skips live executions, and retries only pending releases", async () => {
    const first = await seed();
    const skipped = await seed();
    const child = startDetached();
    children.push(child);
    const alive = await seed({ pid: child.pid! });
    await discoverSettledNativeRunProcesses(db, { limit: 1, skip: runId => runId === skipped.runId });
    expect((await readRun(first.runId)).processPid).toBeNull();
    expect((await readRun(skipped.runId)).processPid).toBe(skipped.pid);
    expect((await readRun(alive.runId)).processPid).toBe(child.pid);
    expect(pendingSettledNativeRunProcessIds()).toContain(alive.runId);
    expect(pendingSettledNativeRunProcessIds()).not.toContain(skipped.runId);
    await new Promise<void>(resolve => { child.once("exit", () => resolve()); process.kill(-child.pid!, "SIGKILL"); });
    await retryPendingSettledNativeRunProcesses(db);
    expect((await readRun(alive.runId)).processPid).toBeNull();
    expect(pendingSettledNativeRunProcessIds()).not.toContain(alive.runId);
    await settleNativeRunProcess(db, skipped.runId);
    expect(pendingSettledNativeRunProcessIds()).not.toContain(skipped.runId);
    for (let attempt = 0; attempt < 25 && pendingSettledNativeRunProcessIds().length; attempt += 1) {
      await retryPendingSettledNativeRunProcesses(db);
    }
    expect(pendingSettledNativeRunProcessIds()).toEqual([]);
    const idle = new Proxy({}, { get: () => { throw new Error("idle retry touched the database"); } }) as typeof db;
    await retryPendingSettledNativeRunProcesses(idle);
  });

  it("stops retrying a release that never becomes ready", async () => {
    const { runId } = await seed({ leases: ["local_unreleased"] });
    expect(await settleNativeRunProcess(db, runId)).toBe("pending");
    expect(pendingSettledNativeRunProcessIds()).toContain(runId);
    for (let attempt = 0; attempt < 18; attempt += 1) await retryPendingSettledNativeRunProcesses(db);
    expect(pendingSettledNativeRunProcessIds()).toContain(runId);
    await retryPendingSettledNativeRunProcesses(db);
    expect(pendingSettledNativeRunProcessIds()).not.toContain(runId);
    expect((await readRun(runId)).processPid).not.toBeNull();
  });
});

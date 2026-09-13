import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import * as processes from "../services/hot-restart.js";
import * as adapters from "../adapters/index.js";
import * as orchestration from "../services/environment-run-orchestrator.js";
import * as compatibility from "../services/legacy-sandbox-workspace.js";
import * as gitCredentials from "../services/git-credentials.js";
import { bindAdapterRunStop, hasAdapterRunCancellation } from "@paperclipai/adapter-utils/adapter-run-cancellation";
import * as executionTargets from "@paperclipai/adapter-utils/execution-target";
import { heartbeatService, persistHeartbeatRunProcessMetadata } from "../services/heartbeat.js";

describe("heartbeat process identity persistence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-process-metadata-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Process identity", defaultResponsibleUserId: "responsible-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", role: "engineer", status: "idle", adapterType: "codex_local" });
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    // These tests exercise process/cancellation ownership, not Git transport.
    // Their synthetic targets deliberately have no remote command runner.
    vi.spyOn(executionTargets, "prepareGitHubExecutionEnvironment").mockImplementation(async (input) => input.env);
    vi.spyOn(gitCredentials, "resolveManagedGitHubIdentitySelection").mockResolvedValue({ configured: true });
  });
  afterAll(async () => { await database?.cleanup(); });
  async function running() {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", invocationSource: "on_demand", startedAt: new Date(),
      processPid: 123, processGroupId: null, processStartedAt: new Date("2026-09-09T23:19:42Z") }).returning();
    return run!;
  }

  it("passes remote process identity through the legacy adapter spawn callback", async () => {
    const remoteStart = "2026-09-09T23:19:43.123Z";
    const originalOrchestrator = orchestration.environmentRunOrchestrator;
    vi.spyOn(orchestration, "environmentRunOrchestrator").mockImplementation((...args) => {
      const actual = originalOrchestrator(...args);
      return { ...actual, realizeForRun: async (input) => ({
        ...await actual.realizeForRun(input),
        executionTarget: { kind: "remote", transport: "ssh", remoteCwd: "/remote/task", shellCommand: "sh" } as never,
      }) };
    });
    vi.spyOn(executionTargets, "prepareGitHubOperationLaunchers").mockImplementation(async (input) => input.env);
    vi.spyOn(executionTargets, "cleanupGitHubOperationLaunchers").mockResolvedValue(undefined);
    let spawned!: () => void, release!: () => void;
    const observed = new Promise<void>((resolve) => { spawned = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(adapters, "getServerAdapter").mockReturnValue({
      supportsLocalAgentJwt: false,
      execute: async (input) => {
        expect(input.executionTarget?.kind).toBe("remote");
        await input.onSpawn?.({ pid: process.pid, processGroupId: null, startedAt: remoteStart });
        spawned();
        await finish;
        return { exitCode: 0, signal: null, timedOut: false };
      },
    } as ReturnType<typeof adapters.getServerAdapter>);
    const heartbeat = heartbeatService(db);
    try {
      const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(queued).not.toBeNull();
      await observed;
      const actual = await heartbeat.getRun(queued!.id);
      expect(actual?.runtimeMode).toBe("legacy");
      expect(actual?.processPid).toBe(process.pid);
      expect(actual?.processStartedAt?.toISOString()).toBe(remoteStart);
    } finally {
      release();
      await heartbeat.drainActiveRunExecutions();
    }
  }, 30_000);

  it("does not dispatch when cancellation precedes the remote cancellation scope", async () => {
    const originalOrchestrator = orchestration.environmentRunOrchestrator;
    vi.spyOn(orchestration, "environmentRunOrchestrator").mockImplementation((...args) => {
      const actual = originalOrchestrator(...args);
      return { ...actual, realizeForRun: async (input) => ({
        ...await actual.realizeForRun(input),
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/remote/task", shellCommand: "sh" } as never,
      }) };
    });
    vi.spyOn(compatibility, "hasLegacySandboxWorkspace").mockReturnValue(true);
    let ready!: () => void, release!: () => void;
    const preparing = new Promise<void>((resolve) => { ready = resolve; });
    const finishPreparation = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(executionTargets, "prepareGitHubOperationLaunchers").mockImplementation(async (input) => {
      ready(); await finishPreparation; return input.env;
    });
    vi.spyOn(executionTargets, "cleanupGitHubOperationLaunchers").mockResolvedValue(undefined);
    const execute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false }));
    vi.spyOn(adapters, "getServerAdapter").mockReturnValue({ supportsLocalAgentJwt: false, execute } as never);
    const heartbeat = heartbeatService(db);
    try {
      const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(queued).not.toBeNull();
      await preparing;
      expect(hasAdapterRunCancellation(queued!.id)).toBe(false);
      await heartbeat.cancelRun(queued!.id);
      expect((await heartbeat.getRun(queued!.id))?.status).toBe("cancelled");
      release();
      await heartbeat.drainActiveRunExecutions();
      expect(execute).not.toHaveBeenCalled();
      expect(hasAdapterRunCancellation(queued!.id)).toBe(false);
    } finally { release(); await heartbeat.drainActiveRunExecutions(); }
  }, 30_000);

  it("cancels the remote adapter and waits for teardown before acknowledging Stop", async () => {
    const originalOrchestrator = orchestration.environmentRunOrchestrator;
    vi.spyOn(orchestration, "environmentRunOrchestrator").mockImplementation((...args) => {
      const actual = originalOrchestrator(...args);
      return { ...actual, realizeForRun: async (input) => ({
        ...await actual.realizeForRun(input),
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/remote/task", shellCommand: "sh" } as never,
      }) };
    });
    vi.spyOn(compatibility, "hasLegacySandboxWorkspace").mockReturnValue(true);
    vi.spyOn(executionTargets, "prepareGitHubOperationLaunchers").mockImplementation(async (input) => input.env);
    vi.spyOn(executionTargets, "cleanupGitHubOperationLaunchers").mockResolvedValue(undefined);
    let ready!: () => void, stopped!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const interrupted = new Promise<void>((resolve) => { stopped = resolve; });
    const teardown = new Promise<void>((resolve) => { release = resolve; });
    const heartbeat = heartbeatService(db);
    vi.spyOn(adapters, "getServerAdapter").mockReturnValue({
      supportsLocalAgentJwt: false,
      execute: async (input) => {
        expect(hasAdapterRunCancellation(input.runId)).toBe(true);
        const cleanup = await bindAdapterRunStop(input.runId, async () => {
          const run = await heartbeat.getRun(input.runId);
          expect(run?.status).toBe("running");
          expect(run?.resultJson?.executionCancellation).toMatchObject({ state: "requested" });
          stopped();
        });
        ready();
        await interrupted;
        await teardown;
        await cleanup();
        return { exitCode: 143, signal: "SIGTERM", timedOut: false,
          resultJson: { executionCancellation: { state: "acknowledged" } } };
      },
    } as ReturnType<typeof adapters.getServerAdapter>);
    let pending: Promise<unknown> | undefined;
    try {
      const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(queued).not.toBeNull();
      await started;
      let acknowledged = false;
      pending = heartbeat.cancelRun(queued!.id).then((result) => { acknowledged = true; return result; });
      await interrupted;
      expect(acknowledged).toBe(false);
      release();
      await pending;
      expect((await heartbeat.getRun(queued!.id))?.status).toBe("cancelled");
      expect(hasAdapterRunCancellation(queued!.id)).toBe(false);
    } finally {
      stopped(); release();
      await pending;
      await heartbeat.drainActiveRunExecutions();
    }
  }, 30_000);

  it("uses the remote marker even when its PID exists on the host", async () => {
    const run = await running();
    const host = vi.spyOn(processes, "readProcessStartedAt");
    const meta = { pid: process.pid, processGroupId: null, startedAt: "2026-09-09T23:19:43.123Z" };
    const updated = await persistHeartbeatRunProcessMetadata(db, run.id, meta, "remote");
    expect(updated?.processPid).toBe(process.pid);
    expect(updated?.processStartedAt?.toISOString()).toBe(meta.startedAt);
    expect(host).not.toHaveBeenCalled();
  });

  it("retains observed local-process identity during an active run", async () => {
    const run = await running();
    const start = "2026-09-09T23:19:43.456Z";
    vi.spyOn(processes, "readProcessStartedAt").mockResolvedValue(start);
    const updated = await persistHeartbeatRunProcessMetadata(db, run.id, { pid: 456, processGroupId: 456, startedAt: "2026-09-09T23:19:44Z" });
    expect(updated).toMatchObject({ processPid: 456, processGroupId: 456, processStartedAt: new Date(start) });
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out", "running"] as const)("does not change finished %s history from a late spawn callback", async (status) => {
    const run = await running();
    const [finished] = await db.update(heartbeatRuns).set({ status, finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id)).returning();
    expect(await persistHeartbeatRunProcessMetadata(db, run.id, { pid: 6365, processGroupId: null, startedAt: "2026-09-09T23:20:09.344Z" }, "remote")).toBeNull();
    const [actual] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(actual).toEqual(finished);
  });

  it("fences finalization racing an in-flight local identity lookup", async () => {
    const run = await running();
    let resume!: (start: string) => void;
    vi.spyOn(processes, "readProcessStartedAt").mockImplementation(() => new Promise((resolve) => { resume = resolve; }));
    const pending = persistHeartbeatRunProcessMetadata(db, run.id, { pid: 456, processGroupId: 456, startedAt: "2026-09-09T23:19:43Z" });
    const [finished] = await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id)).returning();
    resume("2026-09-09T23:19:43Z");
    expect(await pending).toBeNull();
    const [actual] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(actual).toEqual(finished);
  });
});

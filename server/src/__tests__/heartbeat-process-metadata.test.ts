import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import * as processes from "../services/hot-restart.js";
import * as adapters from "../adapters/index.js";
import * as orchestration from "../services/environment-run-orchestrator.js";
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

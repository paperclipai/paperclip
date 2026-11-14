import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, controllerInstances, createDb, heartbeatRuns } from "@paperclipai/db";
import { DATABASE_WORK_CHANNEL, enableDatabaseWorkNotifications, receiveDatabaseWorkNotification } from "@paperclipai/db/work-signals";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createRunStartHandover } from "../services/run-start-handover.js";

const support = await getEmbeddedPostgresTestSupport();

/**
 * Two assembled heartbeat services on one database, each with its own pool, notification listener,
 * delivery coordinator and boot: the old server that is still serving and its replacement.
 */
describe.skipIf(!support.supported)("run starts during a deploy overlap (assembled heartbeat)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let admin!: ReturnType<typeof createDb>;
  const stops: Array<() => Promise<void>> = [];
  const errors: unknown[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-run-start-handover-");
    admin = createDb(database.connectionString);
  }, 90_000);
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    await admin.execute(sql`truncate companies cascade`);
    await admin.delete(controllerInstances);
    expect(errors.splice(0)).toEqual([]);
  });
  afterAll(async () => {
    await admin?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  async function bootServer(name: string, options: { dispatches: boolean }) {
    const db = createDb(database!.connectionString, { maxConnections: 4 });
    enableDatabaseWorkNotifications(db);
    const listener = createDb(database!.connectionString, { maxConnections: 1 }).$client;
    await listener.listen(DATABASE_WORK_CHANNEL, payload => receiveDatabaseWorkNotification(db, payload));
    // Claims this server's pool makes: the queued-to-running transition of a run.
    const claims: string[] = [];
    db.$client.options.debug = (_connection, query, parameters) => {
      if (/^update "heartbeat_runs" set "status"/.test(query) && parameters.includes("running")) claims.push(query);
    };
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => errors.push(error) });
    let heartbeat!: ReturnType<typeof heartbeatService>;
    const handover = createRunStartHandover({ db, coordinator, canDispatch: () => true,
      onResume: () => { void heartbeat.resumeQueuedRunsAfterDrain(); }, bootId: `boot-${name}-${randomUUID()}`,
      processSpace: name, pid: 1, timing: { renewMs: 200, ttlMs: 1_500, recheckMs: 150, staleAwaitMs: 100, skipHintMinMs: 50 } });
    heartbeat = heartbeatService(db, { runStartHandover: handover });
    const dispatch = options.dispatches ? heartbeat.registerRunDispatchWork(coordinator, () => true) : null;
    await Promise.all([handover.ready, dispatch?.ready]);
    stops.push(async () => {
      await handover.stop();
      await dispatch?.stop();
      await coordinator.stop();
      await heartbeat.drainActiveRunExecutions();
      await listener.end({ timeout: 1 });
      await db.$client.end({ timeout: 1 });
    });
    return { db, heartbeat, handover, claims };
  }

  async function fixture() {
    const companyId = randomUUID();
    await admin.insert(companies).values({ id: companyId, name: "Overlap", issuePrefix: `O${companyId.slice(0, 7)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "overlap-user" });
    const [agent] = await admin.insert(agents).values({ companyId, name: "Controlled process", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "console.log('handover-proof')"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } },
    }).returning();
    return agent.id;
  }

  const runStatus = async (id: string) =>
    (await admin.select({ status: heartbeatRuns.status, stdout: heartbeatRuns.stdoutExcerpt }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, id)))[0];

  it("a wake accepted by the old server stays queued there and starts on the replacement", async () => {
    const agentId = await fixture();
    const old = await bootServer("old", { dispatches: true });
    await old.handover.begin();
    const replacement = await bootServer("new", { dispatches: true });
    await replacement.handover.begin();
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });

    const run = await old.heartbeat.wakeup(agentId, { source: "on_demand", reason: "manual", requestedByActorType: "system" });
    if (!run) throw new Error("wake was not accepted");
    await vi.waitFor(async () => expect((await runStatus(run.id))?.status).toBe("succeeded"), { timeout: 30_000 });
    await replacement.heartbeat.drainActiveRunExecutions();
    expect((await runStatus(run.id))?.stdout).toContain("handover-proof");
    expect(old.claims).toEqual([]);
    expect(replacement.claims.length).toBeGreaterThan(0);
  }, 60_000);

  it("the old server starts the waiting run itself when the replacement shuts down before starting it", async () => {
    const agentId = await fixture();
    const old = await bootServer("old", { dispatches: true });
    await old.handover.begin();
    // The replacement recorded its start but never dispatches (a failed deploy).
    const replacement = await bootServer("new", { dispatches: false });
    await replacement.handover.begin();
    await vi.waitFor(() => expect(old.handover.isActive()).toBe(true), { timeout: 10_000 });

    const run = await old.heartbeat.wakeup(agentId, { source: "on_demand", reason: "manual", requestedByActorType: "system" });
    if (!run) throw new Error("wake was not accepted");
    await new Promise(resolve => setTimeout(resolve, 500));
    expect((await runStatus(run.id))?.status).toBe("queued");
    expect(old.claims).toEqual([]);

    await replacement.handover.release();
    await vi.waitFor(async () => expect((await runStatus(run.id))?.status).toBe("succeeded"), { timeout: 30_000 });
    await old.heartbeat.drainActiveRunExecutions();
    expect(old.claims.length).toBeGreaterThan(0);
    expect(replacement.claims).toEqual([]);
  }, 60_000);
});

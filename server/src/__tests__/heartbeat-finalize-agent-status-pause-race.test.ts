import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres finalizeAgentStatus pause-race tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * RBR-932: `finalizeAgentStatus` read the agent, checked
 * `paused`/`terminated` in JS, then wrote `status` back with an unguarded
 * `where(eq(agents.id, ...))`. An operator pause landing in that window was
 * silently clobbered back to `idle`/`running`/`error` and the agent restarted
 * against explicit operator intent.
 *
 * These tests assert the *final agent status*, not call shapes: the pause must
 * survive the concurrent run finalization.
 */
describeEmbeddedPostgres("finalizeAgentStatus: concurrent pause survives run finalization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-finalize-agent-status-pause-race-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRunningAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      // Non-null so the finalize path does not treat this as a first heartbeat.
      lastHeartbeatAt: new Date(Date.now() - 60_000),
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "running",
    });

    // No issue context: this suite isolates the agent-status finalize write, so
    // the run deliberately carries no issue execution lock to release.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: {},
    });

    return { companyId, agentId, runId };
  }

  async function agentStatus(agentId: string) {
    return db
      .select({ status: agents.status, errorReason: agents.errorReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Drizzle update builders are lazy thenables: `.where()` / `.returning()`
   * only build SQL, and execution happens on `await`. So to reproduce the
   * hazard deterministically we intercept the finalize write (identified by its
   * unique `errorReason` payload) and commit the operator's pause immediately
   * before the write executes — i.e. after the service has already taken its
   * non-paused snapshot. Only a WHERE-clause guard can preserve the pause here.
   */
  function dbWithPauseRacedIntoAgentUpdate(agentId: string, targetStatus: "paused" | "terminated") {
    const stats = { injected: 0 };

    function delayUntilPause<T extends object>(query: T, pause: PromiseLike<unknown>): T {
      const proxy: T = new Proxy(query, {
        get(target, prop, receiver) {
          if (prop === "where" || prop === "returning") {
            return (...args: unknown[]) => {
              (Reflect.get(target, prop) as (...a: unknown[]) => unknown).apply(target, args);
              return proxy;
            };
          }
          if (prop === "then") {
            return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
              pause.then(() => target as PromiseLike<unknown>).then(onFulfilled, onRejected);
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as T;
      return proxy;
    }

    const proxiedDb = new Proxy(db as unknown as Record<string | symbol, unknown>, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "update" || typeof value !== "function") return value;
        const update = value as (table: unknown) => Record<string, unknown>;
        return (table: unknown) => {
          const builder = update.call(target, table);
          if (table !== agents) return builder;
          return {
            ...builder,
            set(values: Record<string, unknown>) {
              const query = (builder.set as (v: Record<string, unknown>) => object).call(builder, values);
              // `errorReason` is written only by finalizeAgentStatus.
              if (!("errorReason" in values)) return query;
              stats.injected += 1;
              const pause = db
                .update(agents)
                .set({ status: targetStatus, updatedAt: new Date() })
                .where(eq(agents.id, agentId));
              return delayUntilPause(query, pause);
            },
          };
        };
      },
    });

    return { db: proxiedDb as unknown as ReturnType<typeof createDb>, stats };
  }

  it("keeps the agent paused when an operator pause lands between the snapshot read and the finalize write", async () => {
    const { agentId, runId } = await seedRunningAgent();
    const { db: racedDb, stats } = dbWithPauseRacedIntoAgentUpdate(agentId, "paused");

    const heartbeat = heartbeatService(racedDb);
    await heartbeat.cancelRun(runId, "Cancelled by control plane");

    // Sanity: the race was actually injected into the finalize write.
    expect(stats.injected).toBe(1);

    const after = await agentStatus(agentId);
    expect(after?.status).toBe("paused");
  });

  it("keeps the agent terminated when a terminate lands in the same window", async () => {
    const { agentId, runId } = await seedRunningAgent();
    const { db: racedDb, stats } = dbWithPauseRacedIntoAgentUpdate(agentId, "terminated");

    const heartbeat = heartbeatService(racedDb);
    await heartbeat.cancelRun(runId, "Cancelled by control plane");

    expect(stats.injected).toBe(1);

    const after = await agentStatus(agentId);
    expect(after?.status).toBe("terminated");
  });

  it("still finalizes to idle when no pause races the write (control)", async () => {
    const { agentId, runId } = await seedRunningAgent();

    const heartbeat = heartbeatService(db);
    await heartbeat.cancelRun(runId, "Cancelled by control plane");

    const after = await agentStatus(agentId);
    expect(after?.status).toBe("idle");
  });

  it("leaves an already-paused agent paused (cheap JS early-out still holds)", async () => {
    const { agentId, runId } = await seedRunningAgent();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));

    const heartbeat = heartbeatService(db);
    await heartbeat.cancelRun(runId, "Cancelled by control plane");

    const after = await agentStatus(agentId);
    expect(after?.status).toBe("paused");
  });
});

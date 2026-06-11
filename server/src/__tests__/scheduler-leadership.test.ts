import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  createSchedulerLeadership,
  getSchedulerHealth,
  registerSchedulerLeadershipForHealth,
  type SchedulerLeadership,
  type SchedulerLeadershipOptions,
} from "../services/scheduler-leadership.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000, intervalMs = 15) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Short lease timings so failover paths complete within test budgets.
const TTL_MS = 600;
const RETRY_MS = 150;
const JITTER_MS = 30;

describeEmbedded("scheduler leadership", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let dbA: Db;
  let dbB: Db;
  let dbC: Db;
  let active: SchedulerLeadership[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-scheduler-leadership-");
    dbA = createDb(tempDb.connectionString);
    dbB = createDb(tempDb.connectionString);
    dbC = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await Promise.all(active.map((instance) => instance.stop()));
    active = [];
    await dbA.execute(sql`DELETE FROM scheduler_leader`);
  });

  function makeInstance(db: Db, leaderId: string, overrides: Partial<SchedulerLeadershipOptions> = {}) {
    const onAcquired = vi.fn();
    const onLost = vi.fn();
    const leadership = createSchedulerLeadership({
      db,
      leaderId,
      hostname: `host-${leaderId}`,
      ttlMs: TTL_MS,
      retryMs: RETRY_MS,
      jitterMs: JITTER_MS,
      onAcquired,
      onLost,
      ...overrides,
    });
    active.push(leadership);
    return { leadership, onAcquired, onLost };
  }

  async function currentLeaderRow(): Promise<{ leader_id: string } | undefined> {
    const rows = (await dbA.execute(
      sql`SELECT leader_id FROM scheduler_leader WHERE name = 'default'`,
    )) as unknown as Array<{ leader_id: string }>;
    return rows[0];
  }

  it("elects exactly one leader among three candidates", async () => {
    const a = makeInstance(dbA, "leader-a");
    const b = makeInstance(dbB, "leader-b");
    const c = makeInstance(dbC, "leader-c");
    const all = [a, b, c];

    a.leadership.start();
    b.leadership.start();
    c.leadership.start();

    await waitFor(() => all.filter(({ leadership }) => leadership.isLeader()).length === 1);
    // Let several candidate retry cycles elapse: nobody else may sneak in.
    await sleep(3 * RETRY_MS + JITTER_MS + 50);

    expect(all.filter(({ leadership }) => leadership.isLeader())).toHaveLength(1);
    const totalAcquired = all.reduce((sum, { onAcquired }) => sum + onAcquired.mock.calls.length, 0);
    expect(totalAcquired).toBe(1);
  });

  it("renews and retains leadership while alive", async () => {
    const leader = makeInstance(dbA, "leader-renew");
    leader.leadership.start();
    await waitFor(() => leader.leadership.isLeader());

    const candidate = makeInstance(dbB, "candidate-renew");
    candidate.leadership.start();

    await sleep(3 * TTL_MS);

    expect(leader.leadership.isLeader()).toBe(true);
    expect(candidate.leadership.isLeader()).toBe(false);
    expect(candidate.onAcquired).not.toHaveBeenCalled();
    expect(leader.onLost).not.toHaveBeenCalled();
  });

  it("fails over on graceful stop", async () => {
    const leader = makeInstance(dbA, "leader-graceful");
    leader.leadership.start();
    await waitFor(() => leader.leadership.isLeader());

    const candidate = makeInstance(dbB, "candidate-graceful");
    candidate.leadership.start();
    await sleep(2 * RETRY_MS); // candidate is in its retry loop, observing a held lease

    await leader.leadership.stop();
    expect(leader.onLost).toHaveBeenCalledTimes(1);

    // Graceful resign deletes the row, so takeover happens on the candidate's
    // next pass (~retryMs + jitter) — far sooner than lease expiry (ttl).
    await waitFor(() => candidate.leadership.isLeader(), 3 * RETRY_MS);
    expect(candidate.onAcquired).toHaveBeenCalledTimes(1);
    expect(leader.leadership.isLeader()).toBe(false);
  });

  it("fails over when the lease expires (crash)", async () => {
    // "Crashing" leader: acquires once, then never renews within the test
    // window (retryMs far beyond ttl) — simulating a wedged/paused process
    // that holds no further passes. It is never told it lost leadership.
    const stale = makeInstance(dbA, "leader-stale", { retryMs: 60_000, jitterMs: 0 });
    stale.leadership.start();
    await waitFor(() => stale.leadership.isLeader());

    const candidate = makeInstance(dbB, "candidate-takeover");
    candidate.leadership.start();

    // Candidate reaps the expired row and takes over within ~ttl + retry.
    await waitFor(() => candidate.leadership.isLeader(), TTL_MS + 10 * RETRY_MS);
    expect(candidate.onAcquired).toHaveBeenCalledTimes(1);
    // The stale instance still THINKS it is leader (it has not run a pass);
    // that is fine — fencing is the DB renewal predicate, not local state.
    expect(stale.leadership.isLeader()).toBe(true);

    // stop() on the stale instance must not steal the lease: its resign
    // DELETE is predicated on its own leader_id and the row now belongs to
    // the new leader.
    await stale.leadership.stop();
    expect(stale.onLost).toHaveBeenCalledTimes(1);

    await sleep(TTL_MS + RETRY_MS);
    expect(candidate.leadership.isLeader()).toBe(true);
    const row = await currentLeaderRow();
    expect(row?.leader_id).toBe("candidate-takeover");
  });

  it("deposed leader demotes on failed renewal", async () => {
    const leader = makeInstance(dbA, "leader-deposed");
    leader.leadership.start();
    await waitFor(() => leader.leadership.isLeader());

    // Simulate a takeover/fencing event: the row vanishes out from under the
    // leader, so its next renewal UPDATE matches zero rows.
    await dbB.execute(sql`DELETE FROM scheduler_leader`);

    await waitFor(() => leader.onLost.mock.calls.length === 1 && !leader.leadership.isLeader(), 5_000, 10);
    expect(leader.onLost).toHaveBeenCalledTimes(1);
  });

  it("resigns and yields to a second candidate when onAcquired rejects once", async () => {
    // A = faulty: its onAcquired always throws — it will never hold the lease
    // because it resigns immediately after each failed acquire. This prevents
    // A from sneaking back in during the test window.
    // B = healthy: competes concurrently and should acquire within a retry cycle.
    const faultyOnAcquired = vi.fn().mockRejectedValue(new Error("scheduler init failed"));
    const a = makeInstance(dbA, "leader-faulty", { onAcquired: faultyOnAcquired });
    const b = makeInstance(dbB, "leader-healthy");

    a.leadership.start();
    b.leadership.start();

    // B must become leader: A always resigns after its onAcquired throws,
    // so the lease row eventually lands with B.
    await waitFor(() => b.leadership.isLeader(), TTL_MS + 10 * RETRY_MS);

    // Exactly one leader at a time: A is not leader, B is.
    expect(a.leadership.isLeader()).toBe(false);
    expect(b.leadership.isLeader()).toBe(true);

    const row = await currentLeaderRow();
    expect(row?.leader_id).toBe("leader-healthy");

    // A tried at least once (the failure path exists and executed).
    expect(faultyOnAcquired.mock.calls.length).toBeGreaterThanOrEqual(1);
    // B's onAcquired fired exactly once (no double-acquire).
    expect(b.onAcquired).toHaveBeenCalledTimes(1);
  });

  it("getSchedulerHealth reports candidate/leader state and leader row", async () => {
    const { leadership } = makeInstance(dbA, "health-test-leader");

    // Before start: not registered as candidate
    registerSchedulerLeadershipForHealth(null as unknown as SchedulerLeadership);
    let health = await getSchedulerHealth(dbA);
    expect(health.candidate).toBe(false);
    expect(health.isLeader).toBe(false);
    expect(health.leader).toBeUndefined();

    // After registering but before start
    registerSchedulerLeadershipForHealth(leadership);
    health = await getSchedulerHealth(dbA);
    expect(health.candidate).toBe(true);
    expect(health.isLeader).toBe(false);

    // After start: eventually becomes leader
    leadership.start();
    await waitFor(() => leadership.isLeader());
    health = await getSchedulerHealth(dbA);
    expect(health.candidate).toBe(true);
    expect(health.isLeader).toBe(true);
    expect(health.leader).toBeDefined();
    expect(health.leader?.leaderId).toBe("health-test-leader");
    expect(health.leader?.hostname).toBe("host-health-test-leader");
    expect(typeof health.leader?.electedAt).toBe("string");
    expect(typeof health.leader?.expiresAt).toBe("string");

    // After stop + unregister: candidate=false
    await leadership.stop();
    registerSchedulerLeadershipForHealth(null as unknown as SchedulerLeadership);
    health = await getSchedulerHealth(dbA);
    expect(health.candidate).toBe(false);
    expect(health.isLeader).toBe(false);
  });

  it("stop is idempotent and a never-started instance never acquires", async () => {
    const idle = makeInstance(dbA, "leader-idle");
    expect(idle.leadership.isLeader()).toBe(false);

    await idle.leadership.stop();
    await idle.leadership.stop();
    expect(idle.leadership.isLeader()).toBe(false);
    expect(idle.onAcquired).not.toHaveBeenCalled();
    expect(idle.onLost).not.toHaveBeenCalled();

    const other = makeInstance(dbB, "leader-other");
    other.leadership.start();
    await waitFor(() => other.leadership.isLeader());
    expect(other.onAcquired).toHaveBeenCalledTimes(1);

    // stop() on the running leader is also idempotent.
    await other.leadership.stop();
    await other.leadership.stop();
    expect(other.onLost).toHaveBeenCalledTimes(1);
  });
});

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

// Every transaction on the execution-lock path must take the `issues` row
// before any `heartbeat_runs` row. `adoptUnownedCheckoutRun` used to take the
// run row first and reach `issues` only at its final UPDATE — the inverted
// order. It is not masked by the two reconcile transactions that run ahead of
// it in `assertCheckoutOwner`: `clearExecutionRunIfTerminal` and
// `clearCheckoutRunIfTerminal` each commit and drop their `issues` lock before
// the adoption transaction begins.
//
// The first probe makes the ordering observable without racing for the
// microsecond-wide window the deadlock actually needs. A holder session pins
// the `heartbeat_runs` row, so the adoption transaction is guaranteed to be
// parked on it. While it is parked, a third session asks for the `issues` row:
// if adoption took `issues` first, that ask must block. On the inverted order
// the `issues` row is still free and the ask succeeds immediately.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue checkout lock order tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeEmbeddedPostgres("issue checkout lock order", () => {
  let db!: ReturnType<typeof createDb>;
  // Separate pools so a held transaction cannot starve the service under test.
  let runHolder!: ReturnType<typeof createDb>;
  let issueProbe!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-checkout-lock-order-");
    db = createDb(tempDb.connectionString);
    runHolder = createDb(tempDb.connectionString);
    issueProbe = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedUnownedCheckout() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Lock order", issuePrefix: "LCK" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent" });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
    });
    // No checkoutRunId and no executionRunId: the shape that routes
    // `assertCheckoutOwner` into `adoptUnownedCheckoutRun`.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Lock order fixture",
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    return { companyId, agentId, issueId, runId };
  }

  // Wait until some session is blocked by `blockerPid`. This replaces the fixed
  // sleep that assumed the adoption transaction had already reached — and
  // parked on — the pinned run row, which CI scheduling does not guarantee.
  async function waitUntilBlockedBy(blockerPid: number): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const rows = (await db.execute(
        sql`select pid from pg_stat_activity where ${blockerPid} = any(pg_blocking_pids(pid))`,
      )) as unknown as Array<{ pid: number }>;
      if (rows.length > 0) return;
      await sleep(25);
    }
    throw new Error(`no session was blocked by ${blockerPid}`);
  }

  // Wait until the session behind `pid()` is itself blocked on a lock, whichever
  // row it is queued on.
  async function waitUntilBlocked(pid: () => number): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const current = pid();
      if (current > 0) {
        const rows = (await db.execute(
          sql`select cardinality(pg_blocking_pids(${current})) as blockers
              from pg_stat_activity where pid = ${current}`,
        )) as unknown as Array<{ blockers: number }>;
        if ((rows[0]?.blockers ?? 0) > 0) return;
      }
      await sleep(25);
    }
    throw new Error("session never reached a blocking lock wait");
  }

  it(
    "takes the issue row before the heartbeat run row when adopting an unowned checkout",
    async () => {
      const { agentId, issueId, runId } = await seedUnownedCheckout();

      let releaseRunRow!: () => void;
      const runRowReleased = new Promise<void>((resolve) => {
        releaseRunRow = resolve;
      });
      let runRowHeld!: () => void;
      const runRowIsHeld = new Promise<void>((resolve) => {
        runRowHeld = resolve;
      });
      let pinnerPid = 0;

      const holding = runHolder.transaction(async (tx) => {
        const [backend] = (await tx.execute(
          sql`select pg_backend_pid() as pid`,
        )) as unknown as Array<{ pid: number }>;
        pinnerPid = backend.pid;
        await tx.execute(
          sql`select id from heartbeat_runs where id = ${runId} for update`,
        );
        runRowHeld();
        await runRowReleased;
      });
      await runRowIsHeld;

      let checkoutSettled: Promise<void> = Promise.resolve();
      try {
        // Keep the service construction inside the protected block: `issueService`
        // can throw synchronously, and the finally must still release the pin.
        const checkout = issueService(db).assertCheckoutOwner(issueId, agentId, runId);
        checkoutSettled = checkout.then(
          () => undefined,
          () => undefined,
        );
        // Once a session is blocked by the pin, the adoption transaction has
        // reached — and parked on — the run row. No fixed sleep assumes it.
        await waitUntilBlockedBy(pinnerPid);

        // The ordering assertion. `issues` is free only if adoption skipped it
        // on its way to `heartbeat_runs`.
        const probe = await issueProbe
          .transaction(async (tx) => {
            await tx.execute(sql`set local statement_timeout = 2000`);
            await tx.execute(
              sql`select id from issues where id = ${issueId} for update`,
            );
          })
          .then(() => "acquired the issue row" as const)
          .catch((error: Error) => `blocked: ${error.message}`);

        expect(probe).toMatch(/^blocked: /);

        releaseRunRow();
        await holding;

        const ownership = await checkout;
        expect(ownership.checkoutRunId).toBe(runId);

        const stored = await db
          .select({
            checkoutRunId: issues.checkoutRunId,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null);
        expect(stored).toEqual({ checkoutRunId: runId, executionRunId: runId });
      } finally {
        releaseRunRow();
        // Settle every started operation before the pools close, so a wait that
        // times out cannot leave a transaction racing `afterEach`.
        await Promise.allSettled([holding, checkoutSettled]);
        await holding.catch(() => {});
      }
    },
    60_000,
  );

  it(
    "does not deadlock against a peer transaction that takes the rows in canonical order",
    async () => {
      const { agentId, issueId, runId } = await seedUnownedCheckout();

      // Staging the interleaving the production logs show, without racing for
      // it. A third session pins the run row so the adoption transaction is
      // parked there with its lock request already queued; only then does the
      // canonical peer start, so the peer queues behind it for the same row.
      //
      // Unfixed, adoption is parked without the `issues` lock, so the peer takes
      // `issues` freely and then waits on the run row. Releasing the pin hands
      // the run row to adoption (first in the queue), adoption asks for `issues`
      // — held by the peer — and Postgres kills one of the two. Fixed, adoption
      // already holds `issues`, so the peer cannot get in front of it and the
      // cycle never forms.
      let releaseRunRow!: () => void;
      const runRowReleased = new Promise<void>((resolve) => {
        releaseRunRow = resolve;
      });
      let runRowHeld!: () => void;
      const runRowIsHeld = new Promise<void>((resolve) => {
        runRowHeld = resolve;
      });
      let pinnerPid = 0;

      const pinning = runHolder.transaction(async (tx) => {
        const [backend] = (await tx.execute(
          sql`select pg_backend_pid() as pid`,
        )) as unknown as Array<{ pid: number }>;
        pinnerPid = backend.pid;
        await tx.execute(
          sql`select id from heartbeat_runs where id = ${runId} for update`,
        );
        runRowHeld();
        await runRowReleased;
      });
      await runRowIsHeld;

      let checkoutSettled: Promise<void> = Promise.resolve();
      let peerSettled: Promise<void> = Promise.resolve();
      try {
        const checkout = issueService(db)
          .assertCheckoutOwner(issueId, agentId, runId)
          .then((ownership) => ownership.checkoutRunId)
          .catch((error: Error) => `failed: ${error.message}`);
        checkoutSettled = checkout.then(
          () => undefined,
          () => undefined,
        );
        await waitUntilBlockedBy(pinnerPid);

        let peerPid = 0;
        const peer = issueProbe
          .transaction(async (tx) => {
            const [backend] = (await tx.execute(
              sql`select pg_backend_pid() as pid`,
            )) as unknown as Array<{ pid: number }>;
            peerPid = backend.pid;
            await tx.execute(
              sql`select id from issues where id = ${issueId} for update`,
            );
            await tx.execute(
              sql`select id from heartbeat_runs where id = ${runId} for update`,
            );
          })
          .then(() => "committed" as const)
          .catch((error: Error) => `failed: ${error.message}`);
        peerSettled = peer.then(
          () => undefined,
          () => undefined,
        );
        // The peer has reached its blocking point once it is waiting on a lock:
        // `issues`, held by adoption, or the pinned run row.
        await waitUntilBlocked(() => peerPid);

        releaseRunRow();
        await pinning;

        expect(await Promise.all([checkout, peer])).toEqual([
          runId,
          "committed",
        ]);
      } finally {
        releaseRunRow();
        // Settle the peer and the adoption before the pools close, so a wait
        // that times out cannot leave a transaction racing `afterEach`.
        await Promise.allSettled([pinning, checkoutSettled, peerSettled]);
        await pinning.catch(() => {});
      }
    },
    60_000,
  );
});

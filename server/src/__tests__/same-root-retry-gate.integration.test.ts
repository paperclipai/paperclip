import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { enforceSameRootRetryCap } from "../services/same-root-retry-gate.ts";
import { SAME_ROOT_AUTOMATIC_RETRY_MAX_RUNS } from "../services/same-root-retry-cap.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres same-root retry gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The number of retry runs that carry the root marker before the root is parked.
// The first (root) run has a null retry_root_run_id, so it is not counted here;
// SAME_ROOT_AUTOMATIC_RETRY_MAX_RUNS includes it (first run + retries).
const MARKED_RETRIES = SAME_ROOT_AUTOMATIC_RETRY_MAX_RUNS - 1;

describeEmbeddedPostgres("same-root retry gate (embedded postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-same-root-retry-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "owner-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Dev",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  });

  async function insertRun(overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    return db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "failed",
        errorCode: "adapter_failed",
        error: "Configured model is unavailable",
        responsibleUserId: "owner-user",
        ...overrides,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function countInEpoch(rootRunId: string, epoch: number) {
    return db
      .select({ value: count() })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.retryRootRunId, rootRunId),
          eq(heartbeatRuns.retryEpoch, epoch),
        ),
      )
      .then((rows) => rows[0]?.value ?? 0);
  }

  // Replay of the FALA-491-class chain: a root that keeps failing, each failure
  // driving another automatic retry. The gate runs in the same transaction that
  // inserts the retry, so the count and the insert are atomic under its lock.
  async function driveFailureChain(
    root: typeof heartbeatRuns.$inferSelect,
    iterations: number,
    wakeReason = "process_lost_retry",
  ) {
    let source = root;
    let automaticRunsCreated = 1; // the first (root) run
    let lastPark: unknown = null;
    for (let i = 0; i < iterations; i += 1) {
      const decision = await db.transaction((tx) =>
        enforceSameRootRetryCap(tx, { source, wakeReason, nextOwner: "owner-user" }),
      );
      if (!decision.allowed) {
        lastPark = decision.park;
        break;
      }
      source = await insertRun({
        retryOfRunId: source.id,
        retryRootRunId: decision.retryRootRunId,
        retryEpoch: decision.retryEpoch,
      });
      automaticRunsCreated += 1;
    }
    return { automaticRunsCreated, lastPark };
  }

  it("stops a 144-run same-root failure chain within 4 total runs and parks it", async () => {
    const root = await insertRun();
    const { automaticRunsCreated, lastPark } = await driveFailureChain(root, 144);

    expect(automaticRunsCreated).toBe(SAME_ROOT_AUTOMATIC_RETRY_MAX_RUNS);
    expect(automaticRunsCreated).toBeLessThanOrEqual(4);
    expect(await countInEpoch(root.id, 0)).toBe(MARKED_RETRIES);

    // Exhaustion parks the root with an operator-visible failure + owner + action.
    expect(lastPark).toMatchObject({
      status: "parked",
      reason: "root_retry_cap_exhausted",
      rootRunId: root.id,
      lastErrorCode: "adapter_failed",
      nextOwner: "owner-user",
    });
    expect((lastPark as { nextAction: string }).nextAction).toMatch(/resume/i);
  });

  it("does not create a 5th run when recovery events keep repeating", async () => {
    const root = await insertRun();
    await driveFailureChain(root, 10, "issue_continuation_needed");
    // Any further recovery-internal wake for the same root/epoch is refused.
    const decision = await db.transaction((tx) =>
      enforceSameRootRetryCap(tx, { source: root, wakeReason: "issue_assignment_recovery" }),
    );
    expect(decision.allowed).toBe(false);
    expect(await countInEpoch(root.id, 0)).toBe(MARKED_RETRIES);
  });

  it("resumes with a clean budget when new external input advances the epoch", async () => {
    const root = await insertRun();
    await driveFailureChain(root, 144); // exhaust epoch 0

    // A human comment / monitor signal on the same root is epoch-advancing.
    const resumed = await db.transaction((tx) =>
      enforceSameRootRetryCap(tx, { source: root, wakeReason: "issue_commented" }),
    );
    expect(resumed.allowed).toBe(true);
    if (resumed.allowed) {
      expect(resumed.retryEpoch).toBe(1);
      expect(resumed.attempt).toBe(1);
    }
  });

  it("enforces the cap atomically under concurrent minters (advisory lock)", async () => {
    const root = await insertRun();
    // Many recovery paths racing to recover the same root at once. The advisory
    // lock must serialize count → insert so none can slip past the cap.
    const attempts = Array.from({ length: 8 }, () =>
      db.transaction(async (tx) => {
        const decision = await enforceSameRootRetryCap(tx, {
          source: root,
          wakeReason: "process_lost_retry",
        });
        if (decision.allowed) {
          await tx.insert(heartbeatRuns).values({
            companyId,
            agentId,
            status: "failed",
            retryOfRunId: root.id,
            retryRootRunId: decision.retryRootRunId,
            retryEpoch: decision.retryEpoch,
          });
        }
        return decision.allowed;
      }),
    );
    const allowed = (await Promise.all(attempts)).filter(Boolean).length;
    expect(allowed).toBe(MARKED_RETRIES);
    expect(await countInEpoch(root.id, 0)).toBe(MARKED_RETRIES);
  });
});

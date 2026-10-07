import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { isUniqueViolation } from "../db-errors.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

/**
 * `issues_open_routine_execution_uq` is partial on `execution_run_id is not
 * null`, so a routine_execution issue only enters the index once the execution
 * lock is stamped. Taking the lock on one open issue therefore collides with an
 * open sibling from the same routine + fingerprint that already holds one —
 * which is what made TES-2502 answer six consecutive bare 500s (TES-2535/2536).
 *
 * TES-2536 turned that into a structured 409. TES-2537 stopped refusing the
 * mutation at all: the actor takes `checkout_run_id` — the pointer ownership is
 * actually tested on — and leaves `execution_run_id` null, so the coalescing
 * slot stays with the sibling and the row stays out of the index. These tests
 * pin both halves: the adoption now succeeds, and the index still admits only
 * one execution_run_id per routine + fingerprint.
 */
describeEmbeddedPostgres("routine execution lock collision", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-routine-exec-lock-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedSiblingRoutineIssues() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const actorRunId = randomUUID();
    const siblingRunId = randomUUID();
    const routineId = randomUUID();
    const fingerprint = "shared-fingerprint";
    const strandedIssueId = randomUUID();
    const siblingIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Routine Runner",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: actorRunId,
        companyId,
        agentId,
        status: "running",
        responsibleUserId: "board-user",
        contextSnapshot: {},
      },
      {
        id: siblingRunId,
        companyId,
        agentId,
        status: "running",
        responsibleUserId: "board-user",
        contextSnapshot: {},
      },
    ]);

    // The sibling holds the index slot: open, non-hidden, execution_run_id set.
    await db.insert(issues).values({
      id: siblingIssueId,
      companyId,
      identifier: "TES-0001",
      issueNumber: 1,
      title: "Coalesced run issue (holds the lock)",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: routineId,
      originFingerprint: fingerprint,
      executionRunId: siblingRunId,
      checkoutRunId: siblingRunId,
      responsibleUserId: "board-user",
    });

    // The stranded prior-day issue: same routine + fingerprint, in_progress and
    // assigned to the actor, but unowned — both run ids null. Stamping the lock
    // here is what trips the index.
    await db.insert(issues).values({
      id: strandedIssueId,
      companyId,
      identifier: "TES-0002",
      issueNumber: 2,
      title: "Stranded prior-day issue (needs the lock)",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: routineId,
      originFingerprint: fingerprint,
      executionRunId: null,
      checkoutRunId: null,
      responsibleUserId: "board-user",
    });

    return { agentId, actorRunId, strandedIssueId, siblingIssueId };
  }

  it("adopts the checkout lock while a sibling holds the coalescing slot", async () => {
    const { agentId, actorRunId, strandedIssueId } =
      await seedSiblingRoutineIssues();

    const ownership = await issueService(db).assertCheckoutOwner(
      strandedIssueId,
      agentId,
      actorRunId,
    );

    // The checkout lock is what `sameRunLock` tests, so taking it alone is
    // enough to own the row; declining the slot keeps it out of the index.
    expect(ownership).toMatchObject({
      id: strandedIssueId,
      checkoutRunId: actorRunId,
      executionRunId: null,
    });
  });

  it("stamps checkout_run_id without execution_run_id or execution_locked_at", async () => {
    const { agentId, actorRunId, strandedIssueId } =
      await seedSiblingRoutineIssues();

    await issueService(db).assertCheckoutOwner(
      strandedIssueId,
      agentId,
      actorRunId,
    );

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, strandedIssueId))
      .then((rows) => rows[0]);

    expect(row).toMatchObject({
      checkoutRunId: actorRunId,
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("leaves the sibling's coalescing slot untouched", async () => {
    const { agentId, actorRunId, strandedIssueId, siblingIssueId } =
      await seedSiblingRoutineIssues();

    await issueService(db).assertCheckoutOwner(
      strandedIssueId,
      agentId,
      actorRunId,
    );

    const sibling = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, siblingIssueId))
      .then((rows) => rows[0]);

    expect(sibling?.executionRunId).not.toBeNull();
    expect(sibling?.executionRunId).not.toBe(actorRunId);
  });

  it("lets the assignee close the adopted issue — the point of TES-2502", async () => {
    const { agentId, actorRunId, strandedIssueId } =
      await seedSiblingRoutineIssues();
    const service = issueService(db);

    await service.assertCheckoutOwner(strandedIssueId, agentId, actorRunId);
    const closed = await service.update(strandedIssueId, {
      status: "done",
      actorAgentId: agentId,
    });

    expect(closed).toMatchObject({ status: "done" });
  });

  it("still admits only one execution_run_id per routine and fingerprint", async () => {
    const { agentId, actorRunId, strandedIssueId } =
      await seedSiblingRoutineIssues();

    await issueService(db).assertCheckoutOwner(
      strandedIssueId,
      agentId,
      actorRunId,
    );

    // The invariant the index defends is unchanged, not narrowed: the adopted
    // row declined the slot, so writing an execution_run_id onto it still
    // collides with the sibling that holds one.
    const violation = await db
      .update(issues)
      .set({ executionRunId: actorRunId })
      .where(eq(issues.id, strandedIssueId))
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(violation).not.toBeNull();
    expect(
      isUniqueViolation(violation, "issues_open_routine_execution_uq"),
    ).toBe(true);
  });

  it("still adopts the lock once the sibling closes and leaves the index", async () => {
    const { agentId, actorRunId, strandedIssueId, siblingIssueId } =
      await seedSiblingRoutineIssues();

    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, siblingIssueId));

    const ownership = await issueService(db).assertCheckoutOwner(
      strandedIssueId,
      agentId,
      actorRunId,
    );

    expect(ownership).toMatchObject({
      id: strandedIssueId,
      checkoutRunId: actorRunId,
      executionRunId: actorRunId,
    });
  });
});

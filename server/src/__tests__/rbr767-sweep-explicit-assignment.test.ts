import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { runRbr767Sweep } from "../scripts/rbr767-sweep.js";

/**
 * RBR-813: the sweep must not steal an explicit assignment.
 *
 * `scripts/rbr767-sweep.ts` re-routes on
 *   `isNull(assignee) OR isNotNull(assigneeFallbackReason)`.
 * The second branch is load-bearing: genuinely degraded rows already carry an assignee,
 * so the unassigned-only branch would miss every one of them. Its premise, though, is
 * "still-flagged means nobody has claimed it since the scan" -- and that premise was
 * false, because nothing on the update/reassign path cleared the flag. A human or agent
 * who deliberately took a degraded issue kept `assignee_fallback_reason` forever, and the
 * next sweep -- every sweep, for the life of the row -- overwrote their assignment with a
 * ladder-computed fallback owner.
 *
 * The primary fix, per the CEO's direction, is to make the predicate's premise true
 * rather than to delete the predicate. The shared `issueService.update` path clears the
 * flag whenever an explicit assignee lands, so a row that someone deliberately took is no
 * longer in the sweep's worklist at all. The `isNotNull` branch stays exactly as it is,
 * because rows that really are degraded carry an assignee by construction and the
 * unassigned-only branch would miss every one of them.
 *
 * RBR-813 AC2 additionally pins the sweep's UPDATE to the assignee its own SELECT read
 * (a compare-and-swap). That is not a substitute for the clear and not a competing
 * design: it closes the one window the clear cannot, where a reassignment lands *after*
 * the scan and *before* the write, on a row that was legitimately flagged when scanned.
 * (RBR-814 framed these as alternatives -- "do not do both" -- but RBR-814 was cancelled
 * as a duplicate and RBR-813 is canonical, and it requires both.)
 *
 * Every assertion here runs through the real `runRbr767Sweep` entrypoint and checks where
 * the row actually ended up, never against a copy of the sweep's predicate.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RBR-813 explicit-assignment tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("rbr767 sweep: explicit assignment survives the sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rbr814-explicit-assign-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 180_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Degraded Roster Co",
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function hire(
    companyId: string,
    name: string,
    reportsTo: string | null = null,
    status = "active",
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      reportsTo,
    });
    return agentId;
  }

  /**
   * The record the create path leaves behind when the roster was degraded: an owner was
   * written off the ladder, and the row is flagged so the sweep revisits it.
   */
  async function seedDegradedIssue(companyId: string, assigneeAgentId: string) {
    const [row] = await db.insert(issues).values({
      companyId,
      title: "Filed while the roster was degraded",
      status: "todo",
      priority: "high",
      assigneeAgentId,
      assigneeFallbackReason: "no_invokable_owner",
    }).returning();
    return row;
  }

  /**
   * `issues.checkout_run_id` / `execution_run_id` are FKs onto `heartbeat_runs`, so any
   * test that exercises a checkout has to seed a real run row rather than a bare UUID.
   */
  async function seedRun(companyId: string, agentId: string, status = "running") {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status });
    return runId;
  }

  it("explicit reassignment clears the flag and the sweep leaves the assignment alone", async () => {
    const companyId = await seedCompany();
    // The ladder's terminal rung with no parent and no creator is the invokable root, so
    // this is exactly the owner an unfixed sweep would compute and write back.
    const ceo = await hire(companyId, "CEO", null);
    const specialist = await hire(companyId, "Specialist", ceo);
    const issue = await seedDegradedIssue(companyId, ceo);

    // A human (or agent) explicitly hands the work to the right owner through the normal
    // update path -- no caller passes `assigneeFallbackReason`.
    const reassigned = await svc.update(issue.id, { assigneeAgentId: specialist });
    expect(reassigned?.assigneeAgentId).toBe(specialist);

    const [afterReassign] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(afterReassign.assigneeAgentId).toBe(specialist);
    // AC1: the shared update path -- not the call site -- clears the stale flag.
    expect(afterReassign.assigneeFallbackReason).toBeNull();

    // AC2: the sweep no longer even sees the row, and the explicit assignee survives.
    const sweep = await runRbr767Sweep(db, { companyId, apply: true });
    expect(sweep.scanned).toBe(0);
    expect(sweep.repaired).toBe(0);
    expect(sweep.lines.join("\n")).toMatch(/SWEEP CLEAN/);

    const [afterSweep] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(afterSweep.assigneeAgentId).toBe(specialist);
    expect(afterSweep.assigneeFallbackReason).toBeNull();

    // And it stays put on every subsequent sweep -- the original defect was unbounded in
    // time, so one clean pass is not enough to call it fixed.
    await runRbr767Sweep(db, { companyId, apply: true });
    const [afterSecondSweep] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(afterSecondSweep.assigneeAgentId).toBe(specialist);
    expect(afterSecondSweep.assigneeFallbackReason).toBeNull();
  });

  it("still re-routes a genuinely degraded assigned row -- the isNotNull branch is load-bearing", async () => {
    const companyId = await seedCompany();
    // Root is paused, so the row that names it as owner really is degraded: it has an
    // assignee, which means the unassigned branch cannot see it.
    const pausedRoot = await hire(companyId, "Paused root", null, "paused");
    const issue = await seedDegradedIssue(companyId, pausedRoot);

    const beforeRecovery = await runRbr767Sweep(db, { companyId, apply: true });
    expect(beforeRecovery.scanned).toBe(1);
    expect(beforeRecovery.repaired).toBe(0);
    expect(beforeRecovery.failed).toBe(1);

    await db.update(agents).set({ status: "active" }).where(eq(agents.id, pausedRoot));

    const afterRecovery = await runRbr767Sweep(db, { companyId, apply: true });
    expect(afterRecovery.scanned).toBe(1);
    expect(afterRecovery.repaired).toBe(1);

    const [repaired] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(repaired.assigneeAgentId).toBe(pausedRoot);
    expect(repaired.assigneeFallbackReason).toBeNull();
  });

  it("un-assigning does not clear the flag -- the row is ownerless again and must be swept", async () => {
    const companyId = await seedCompany();
    const ceo = await hire(companyId, "CEO", null);
    const issue = await seedDegradedIssue(companyId, ceo);

    // Clearing the assignee is not an explicit assignment; the row goes back to being
    // genuinely unowned, and the sweep is the thing that must find it.
    await svc.update(issue.id, { assigneeAgentId: null });

    const [unassigned] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(unassigned.assigneeAgentId).toBeNull();
    expect(unassigned.assigneeFallbackReason).toBe("no_invokable_owner");

    const sweep = await runRbr767Sweep(db, { companyId, apply: true });
    expect(sweep.scanned).toBe(1);
    expect(sweep.repaired).toBe(1);

    const [reowned] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(reowned.assigneeAgentId).toBe(ceo);
    expect(reowned.assigneeFallbackReason).toBeNull();
  });

  /**
   * The counterfactual. Without the AC1 clear, this is the exact row the sweep steals:
   * flagged, explicitly reassigned by a writer that does not clear the flag (a raw SQL
   * repair, a migration, or any caller that bypasses `issueService.update`), and a roster
   * on which the sweep computes a *different*, valid owner it genuinely intends to write.
   *
   * It is here to prove the defect is real and that the `isNotNull` branch is what
   * matches such a row -- so the AC1 test above is not passing vacuously on an empty
   * worklist. Leaving the branch in place is deliberate: this row *should* be swept,
   * because nothing told the system its owner was chosen on purpose.
   */
  it("the isNotNull branch still claims a flagged row whose flag was never cleared", async () => {
    const companyId = await seedCompany();
    const ceo = await hire(companyId, "CEO", null);
    const specialist = await hire(companyId, "Specialist", ceo);
    const issue = await seedDegradedIssue(companyId, ceo);

    // A writer that bypasses the shared update path, so the flag survives the reassign.
    await db.update(issues)
      .set({ assigneeAgentId: specialist })
      .where(eq(issues.id, issue.id));

    const sweep = await runRbr767Sweep(db, { companyId, apply: true });
    expect(sweep.scanned).toBe(1);
    expect(sweep.repaired).toBe(1);

    // The ladder owner wins, because the row still advertises itself as degraded. This is
    // the behaviour AC1 prevents by making the flag honest at the source.
    const [after] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(after.assigneeAgentId).toBe(ceo);
    expect(after.assigneeFallbackReason).toBeNull();
  });

  /**
   * Checkout is not routed through `issueService.update`, but it is an explicit
   * acceptance: an agent is claiming the row and starting work on it. Leaving the flag
   * set there means the sweep can reassign live, in-progress work out from under the
   * agent currently executing it -- the worst instance of the defect, not a lesser one.
   */
  it("checkout clears the flag, so the sweep cannot steal in-progress work", async () => {
    const companyId = await seedCompany();
    const ceo = await hire(companyId, "CEO", null);
    const specialist = await hire(companyId, "Specialist", ceo);
    // The row is flagged and already assigned to the specialist -- checkout only admits
    // the agent the row is already assigned to (or an unassigned row), so this is the
    // only shape in which an agent can legitimately claim it. The ladder would compute
    // the parentless CEO instead, so an uncleared flag means the next sweep moves live,
    // in-progress work off the agent currently executing it.
    const issue = await seedDegradedIssue(companyId, specialist);

    const checkedOut = await svc.checkout(
      issue.id,
      specialist,
      ["todo"],
      await seedRun(companyId, specialist),
    );
    expect(checkedOut?.assigneeAgentId).toBe(specialist);
    expect(checkedOut?.status).toBe("in_progress");

    const [afterCheckout] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(afterCheckout.assigneeAgentId).toBe(specialist);
    expect(afterCheckout.assigneeFallbackReason).toBeNull();

    const sweep = await runRbr767Sweep(db, { companyId, apply: true });
    expect(sweep.scanned).toBe(0);

    const [afterSweep] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(afterSweep.assigneeAgentId).toBe(specialist);
    expect(afterSweep.assigneeFallbackReason).toBeNull();
  });

  /**
   * The second checkout branch: adopting a row whose previous execution run died. This is
   * a separate write (`adoptionSet`) from the primary checkout UPDATE, and it was missing
   * the clear -- so the fix had to land on both. This is the worst instance of the defect,
   * not a lesser one: adoption happens on the recovery path, where an agent is picking up
   * work abandoned mid-flight, and a surviving flag lets the sweep hand that work to a
   * ladder-computed owner who never claimed it.
   */
  it("run adoption clears the flag too, not just the primary checkout write", async () => {
    const companyId = await seedCompany();
    const ceo = await hire(companyId, "CEO", null);
    const specialist = await hire(companyId, "Specialist", ceo);
    const issue = await seedDegradedIssue(companyId, specialist);

    // A previous run claimed the row and then died. `heartbeatRunIsTerminalOrMissing`
    // treats a terminal run as adoptable, which is the branch under test.
    const deadRunId = await seedRun(companyId, specialist, "failed");
    await db.update(issues)
      .set({ executionRunId: deadRunId, checkoutRunId: deadRunId, status: "in_progress" })
      .where(eq(issues.id, issue.id));

    const adoptionRunId = await seedRun(companyId, specialist);
    const adopted = await svc.checkout(issue.id, specialist, ["in_progress"], adoptionRunId);
    expect(adopted?.assigneeAgentId).toBe(specialist);
    expect(adopted?.executionRunId).toBe(adoptionRunId);

    const [afterAdoption] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(afterAdoption.assigneeFallbackReason).toBeNull();

    // And the sweep no longer sees live, adopted work.
    const sweep = await runRbr767Sweep(db, { companyId, apply: true });
    expect(sweep.scanned).toBe(0);

    const [afterSweep] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(afterSweep.assigneeAgentId).toBe(specialist);
  });

  /**
   * The end-to-end shape the CEO asked for in AC3: flag a row, PATCH an explicit assignee
   * through the real service, run the sweep with `--apply`, and assert the explicit
   * assignee survives and the flag is cleared. Distinct from the first test in that it
   * runs against a roster where the sweep would otherwise have a *different*, valid owner
   * to write -- so a surviving assignee proves the guard, not an empty worklist.
   */
  it("AC3: flagged row + explicit PATCH + --apply sweep => explicit assignee survives, flag null", async () => {
    const companyId = await seedCompany();
    const ceo = await hire(companyId, "CEO", null);
    const specialist = await hire(companyId, "Specialist", ceo);
    const issue = await seedDegradedIssue(companyId, ceo);

    await svc.update(issue.id, { assigneeAgentId: specialist });

    const result = await runRbr767Sweep(db, { companyId, apply: true });
    expect(result.repaired).toBe(0);

    const [after] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(after.assigneeAgentId).toBe(specialist);
    expect(after.assigneeFallbackReason).toBeNull();
  });

  /**
   * RBR-813 AC2. The one window the flag-clearing cannot close: the row was legitimately
   * flagged when the sweep scanned it, and the reassignment lands *after* that SELECT but
   * *before* the UPDATE. No amount of clearing at the writer helps here -- by the time
   * the writer runs, the sweep has already decided what it is going to write.
   *
   * The interloper below deliberately leaves the flag set, which is exactly how a writer
   * that predates this fix (or a raw SQL repair, or a migration) behaves. That forces the
   * compare-and-swap to carry the whole test: the `isNotNull(assigneeFallbackReason)`
   * branch still matches the row, so the write is rejected on the assignee mismatch alone
   * or not at all.
   */
  it("AC2: skips rather than clobbers a row whose assignee changed mid-sweep", async () => {
    const companyId = await seedCompany();
    const ceo = await hire(companyId, "CEO", null);
    const handPicked = await hire(companyId, "Hand picked owner", ceo);

    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Reassigned between the scan and the write",
      status: "todo",
      priority: "critical",
      // The sweep logs each row by `identifier`, and the injector below keys off that log
      // line. Direct inserts bypass the route that allocates identifiers, so set one
      // explicitly rather than letting the injector silently never fire.
      issueNumber: 1,
      identifier: `RACE-${randomUUID().slice(0, 8)}`,
      assigneeAgentId: ceo,
      assigneeFallbackReason: "no_invokable_owner",
    }).returning();

    // The sweep logs its decision for a row after resolving an owner from the snapshot
    // and before writing, so this callback is precisely the window under test.
    let raced = false;
    const sweep = await runRbr767Sweep(db, {
      companyId,
      apply: true,
      log: async (line) => {
        if (raced || !line.includes(issue.identifier ?? "\u0000")) return;
        raced = true;
        await db.update(issues)
          .set({ assigneeAgentId: handPicked, assigneeFallbackReason: "no_invokable_owner" })
          .where(eq(issues.id, issue.id));
      },
    });

    // Guard against the injector silently never firing, which would make every assertion
    // below pass for the wrong reason.
    expect(raced).toBe(true);
    expect(sweep.scanned).toBe(1);
    // The CAS lost its snapshot, so the row is reported skipped, not repaired. Honest
    // counts matter here: an operator who sees `repaired` must be able to trust it.
    expect(sweep.repaired).toBe(0);
    expect(sweep.failed).toBe(1);
    expect(sweep.lines.join("\n")).toMatch(/SKIPPED: the row changed under the sweep/);

    const [afterRace] = await db.select().from(issues).where(eq(issues.id, issue.id));
    // The behavioural assertion: the owner chosen mid-sweep still holds the row.
    expect(afterRace.assigneeAgentId).toBe(handPicked);
  });
});

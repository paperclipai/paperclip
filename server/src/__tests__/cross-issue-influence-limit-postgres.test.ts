import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
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
import {
  assertCrossIssueWriteFence,
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cross-issue influence limit PostgreSQL serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows exactly one of concurrent attempts 20 and 21", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Concurrent Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db.insert(activityLog).values(
      Array.from({ length: 18 }, () => ({
        companyId,
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        runId,
        action: "issue.cross_issue_influence_observed",
        entityType: "issue",
        entityId: targetIssueId,
      })),
    );

    const input = {
      companyId,
      runId,
      agentId,
      targetIssueId,
      targetIssueIdentifier: "CAP-2",
      kind: "comment" as const,
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    };
    // A comment, a PATCH, and an issue-thread interaction resolution race for the
    // last slot of the shared budget: the row lock must let exactly one of 19/20
    // through per attempt and fail the twenty-first closed.
    const decisions = await Promise.all([
      observeCrossIssueInfluence(db, input),
      observeCrossIssueInfluence(db, { ...input, kind: "update" }),
      observeCrossIssueInfluence(db, { ...input, kind: "interaction_resolution" }),
    ]);

    expect(decisions.map((decision) => decision?.allowed).sort()).toEqual([false, true, true]);
    expect(decisions.map((decision) => decision?.count).sort((a, b) => Number(a) - Number(b)))
      .toEqual([19, 20, 21]);

    const recorded = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_observed")).toHaveLength(20);
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_cap_rejected")).toHaveLength(1);
  });

  describe("authority revoked between the cap gate and the write (FAI-10134 finding 1)", () => {
    const ENFORCE_AT = new Date("2026-01-01T00:00:00.000Z");
    const NOW = new Date("2026-08-23T00:00:00.000Z");
    const MUTATION_ACTION = "issue.test_persisted_mutation";

    async function seed() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const otherAgentId = randomUUID();
      const runId = randomUUID();
      const sourceIssueId = randomUUID();
      const targetIssueId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      });
      await db.insert(agents).values([agentId, otherAgentId].map((id, index) => ({
        id,
        companyId,
        name: index === 0 ? "Racing Coder" : "Successor",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })));
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        responsibleUserId: "board-user",
        contextSnapshot: { issueId: sourceIssueId },
      });
      await db.insert(issues).values([
        { id: sourceIssueId, companyId, title: "Run task" },
        // The only thing authorizing the write: the actor owns the target.
        { id: targetIssueId, companyId, title: "Target task", assigneeAgentId: agentId },
      ]);

      const decision = await observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId,
        targetIssueIdentifier: "RACE-1",
        kind: "comment",
        now: NOW,
        enforceGrantAt: ENFORCE_AT,
      });
      expect(decision?.allowed).toBe(true);
      expect(decision?.fence).toMatchObject({ basisAtCheck: "actor_is_target_assignee" });

      return { companyId, agentId, otherAgentId, runId, sourceIssueId, targetIssueId, decision };
    }

    const mutationRow = (companyId: string, agentId: string, runId: string, targetIssueId: string) => ({
      companyId,
      actorType: "agent" as const,
      actorId: agentId,
      agentId,
      runId,
      action: MUTATION_ACTION,
      entityType: "issue",
      entityId: targetIssueId,
    });

    async function countMutations(companyId: string) {
      const rows = await db
        .select({ action: activityLog.action })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, MUTATION_ACTION)));
      return rows.length;
    }

    it("rolls the mutation back to zero rows when the revocation commits first", async () => {
      const { companyId, agentId, otherAgentId, runId, targetIssueId, decision } = await seed();

      // Connection B reassigns the target — the basis is gone — and commits
      // before the persisting transaction reaches its write.
      await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, targetIssueId));

      await expect(db.transaction(async (tx) => {
        await assertCrossIssueWriteFence(db, tx, decision?.fence);
        await tx.insert(activityLog).values(mutationRow(companyId, agentId, runId, targetIssueId));
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_write_grant_required" },
      });

      // Zero mutation. The stale allow from the cap gate did not write.
      expect(await countMutations(companyId)).toBe(0);
      // The refusal is audited on the pooled handle, so the rollback that
      // erased the mutation does not also erase the evidence.
      const audited = await db
        .select({ action: activityLog.action })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.cross_issue_write_grant_revoked_in_flight"),
        ));
      expect(audited).toHaveLength(1);
    });

    it("makes a revocation racing the write wait for it instead of racing past it", async () => {
      const { companyId, agentId, otherAgentId, runId, targetIssueId, decision } = await seed();

      let releaseFence!: () => void;
      const fenceTaken = new Promise<void>((resolve) => { releaseFence = resolve; });
      let revocationSettled = false;

      const persisted = db.transaction(async (tx) => {
        // Passes: nothing has changed yet, and the `FOR SHARE` locks it takes
        // are held until this transaction commits.
        await assertCrossIssueWriteFence(db, tx, decision?.fence);
        releaseFence();
        // Give the reassignment a chance to land if the locks did not hold.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(revocationSettled).toBe(false);
        await tx.insert(activityLog).values(mutationRow(companyId, agentId, runId, targetIssueId));
      });

      await fenceTaken;
      const revocation = db
        .update(issues)
        .set({ assigneeAgentId: otherAgentId })
        .where(eq(issues.id, targetIssueId))
        .then(() => { revocationSettled = true; });

      await persisted;
      await revocation;

      // The write was authorized through commit, so it stands; the revocation
      // applies after it rather than sliding underneath it.
      expect(await countMutations(companyId)).toBe(1);
      const [target] = await db
        .select({ assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, targetIssueId));
      expect(target?.assigneeAgentId).toBe(otherAgentId);
    });
  });
});

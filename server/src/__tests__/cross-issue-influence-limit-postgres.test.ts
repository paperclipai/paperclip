import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  principalGrantLock,
  principalPermissionGrants,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  assertCrossIssueWriteFence,
  assertCrossIssueWriteFenceUnexpiredAtCommit,
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";
import { accessService, grantRowsPreservingExpiry } from "../services/access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cross-issue influence limit PostgreSQL serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-cap-");
    db = createDb(tempDb.connectionString);
  }, 900_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Blocks until PostgreSQL reports a session actually waiting on a lock, and
   * fails if none appears.
   *
   * The serialization tests below used a bare `setTimeout` to let the racing
   * transaction "get far enough". A sleep proves nothing: it passes identically
   * whether the other session is blocked on our lock or simply has not been
   * scheduled yet, so the test would still be green with the lock removed. Ask
   * the server instead — an ungranted row in `pg_locks` is PostgreSQL stating
   * that a session is queued behind a lock we hold.
   */
  async function waitForLockWaiter(
    options: { locktype?: string; expected?: number; timeoutMs?: number } = {},
  ) {
    const { locktype = "advisory", expected = 1, timeoutMs = 10_000 } = options;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await db.execute(sql`
        SELECT count(*)::int AS waiting
        FROM pg_locks
        WHERE NOT granted
          AND locktype = ${locktype}
          AND pid <> pg_backend_pid()
      `);
      const waiting = Number((Array.isArray(rows) ? rows[0] : null)?.waiting ?? 0);
      if (waiting >= expected) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `expected ${expected} session(s) blocked on a ${locktype} lock within ${timeoutMs}ms, saw ${waiting}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

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

    /**
     * The grant is the authority this issue introduces, so revoking it has to
     * be as binding mid-write as reassigning the target. `explicitGrantScope`
     * takes `FOR SHARE` on the grant row inside the persisting transaction, so
     * a `DELETE` that commits first is seen and the write rolls back whole.
     */
    it("rolls back when the explicit grant is revoked before the write", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const otherAgentId = randomUUID();
      const runId = randomUUID();
      const sourceIssueId = randomUUID();
      const targetIssueId = randomUUID();
      const projectId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      });
      await db.insert(agents).values([agentId, otherAgentId].map((id, index) => ({
        id,
        companyId,
        name: index === 0 ? "Sweeper" : "Owner",
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
      // The grant scope names this project, so it has to be a real row: the
      // target issue's `project_id` is a foreign key.
      await db.insert(projects).values({ id: projectId, companyId, name: "Sweeps" });
      await db.insert(issues).values([
        { id: sourceIssueId, companyId, title: "Sweep task" },
        // Held by someone else and unrelated by tree or origin: the grant is
        // the only thing that can authorize this write.
        { id: targetIssueId, companyId, title: "Peer task", assigneeAgentId: otherAgentId, projectId },
      ]);
      // An `issues:cross-write` grant confers nothing without an active
      // membership behind it, the same rule `decidePrincipalGrant` applies to
      // every other permission key (FAI-10144 round 3).
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        status: "active",
        membershipRole: "member",
      });
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "issues:cross-write",
        scope: { projectId },
      });

      const decision = await observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId,
        targetIssueIdentifier: "GRANT-1",
        kind: "update",
        now: NOW,
        enforceGrantAt: ENFORCE_AT,
      });
      expect(decision?.fence).toMatchObject({ basisAtCheck: "explicit_permission_grant" });

      // Connection B revokes the grant and commits.
      await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));

      await expect(db.transaction(async (tx) => {
        await assertCrossIssueWriteFence(db, tx, decision?.fence);
        await tx.insert(activityLog).values(mutationRow(companyId, agentId, runId, targetIssueId));
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_write_grant_required" },
      });

      expect(await countMutations(companyId)).toBe(0);
    });

    /**
     * FAI-10144. An expiry is a revocation the operator scheduled in advance, so
     * it has to bind at exactly the same point: the fence re-reads `expires_at`
     * under the same `FOR SHARE` that covers a `DELETE`, and re-evaluates it
     * against the clock at write time rather than the clock the cap gate used.
     *
     * The expiry is moved into the past by an `UPDATE` that commits between the
     * gate and the write, rather than by waiting for wall-clock time to pass, so
     * the test proves the property without racing a real timer.
     */
    it("rolls back when the grant expires between the cap gate and the write", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const otherAgentId = randomUUID();
      const runId = randomUUID();
      const sourceIssueId = randomUUID();
      const targetIssueId = randomUUID();
      const projectId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      });
      await db.insert(agents).values([agentId, otherAgentId].map((id, index) => ({
        id,
        companyId,
        name: index === 0 ? "Two Week Sweeper" : "Owner",
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
      await db.insert(projects).values({ id: projectId, companyId, name: "Sweeps" });
      await db.insert(issues).values([
        { id: sourceIssueId, companyId, title: "Sweep task" },
        { id: targetIssueId, companyId, title: "Peer task", assigneeAgentId: otherAgentId, projectId },
      ]);
      // The board's actual ask: authority over this project, for two weeks.
      // An `issues:cross-write` grant confers nothing without an active
      // membership behind it, the same rule `decidePrincipalGrant` applies to
      // every other permission key (FAI-10144 round 3).
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        status: "active",
        membershipRole: "member",
      });
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "issues:cross-write",
        scope: { projectId },
        expiresAt: new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000),
      });

      const decision = await observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId,
        targetIssueIdentifier: "EXPIRY-1",
        kind: "update",
        now: NOW,
        enforceGrantAt: ENFORCE_AT,
      });
      // Inside the window, the grant is the basis exactly as before.
      expect(decision?.fence).toMatchObject({ basisAtCheck: "explicit_permission_grant" });

      // The window closes before the write reaches the fence.
      await db
        .update(principalPermissionGrants)
        .set({ expiresAt: new Date(NOW.getTime() - 1) })
        .where(eq(principalPermissionGrants.companyId, companyId));

      await expect(db.transaction(async (tx) => {
        await assertCrossIssueWriteFence(db, tx, decision?.fence);
        await tx.insert(activityLog).values(mutationRow(companyId, agentId, runId, targetIssueId));
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_write_grant_required" },
      });

      expect(await countMutations(companyId)).toBe(0);
      // The row is still there — an expired grant is evidence, not garbage — so
      // the audit trail can tell "it lapsed" from "it was never granted".
      const surviving = await db
        .select({ expiresAt: principalPermissionGrants.expiresAt })
        .from(principalPermissionGrants)
        .where(eq(principalPermissionGrants.companyId, companyId));
      expect(surviving).toHaveLength(1);
      expect(surviving[0]!.expiresAt).not.toBeNull();
    });

    /** A grant with no expiry keeps working: null means "never expires". */
    it("still authorizes the write when the grant has no expiry", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const otherAgentId = randomUUID();
      const runId = randomUUID();
      const sourceIssueId = randomUUID();
      const targetIssueId = randomUUID();
      const projectId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      });
      await db.insert(agents).values([agentId, otherAgentId].map((id, index) => ({
        id,
        companyId,
        name: index === 0 ? "Standing Sweeper" : "Owner",
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
      await db.insert(projects).values({ id: projectId, companyId, name: "Sweeps" });
      await db.insert(issues).values([
        { id: sourceIssueId, companyId, title: "Sweep task" },
        { id: targetIssueId, companyId, title: "Peer task", assigneeAgentId: otherAgentId, projectId },
      ]);
      // An `issues:cross-write` grant confers nothing without an active
      // membership behind it, the same rule `decidePrincipalGrant` applies to
      // every other permission key (FAI-10144 round 3).
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        status: "active",
        membershipRole: "member",
      });
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "issues:cross-write",
        scope: { projectId },
        expiresAt: null,
      });

      const decision = await observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId,
        targetIssueIdentifier: "NOEXPIRY-1",
        kind: "update",
        now: NOW,
        enforceGrantAt: ENFORCE_AT,
      });
      expect(decision?.fence).toMatchObject({ basisAtCheck: "explicit_permission_grant" });

      await db.transaction(async (tx) => {
        await assertCrossIssueWriteFence(db, tx, decision?.fence);
        await tx.insert(activityLog).values(mutationRow(companyId, agentId, runId, targetIssueId));
      });

      expect(await countMutations(companyId)).toBe(1);
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

    /**
     * A `subtree:` scope is the one selector `scopeAllows` answers by walking
     * `agents.reportsTo` rather than by comparing ids, and that walk used to run
     * unlocked inside the fence. So the hierarchy could be rewritten *after* the
     * fence read it and *before* the write committed — the assignee left the
     * authorized subtree and the mutation landed anyway. Same shape as the
     * intermediate-ancestor race, on the agent tree instead of the issue tree.
     *
     * The fence now takes `FOR SHARE` on the company's agent rows before the
     * walk, so a reparent has to wait for the write instead of sliding under it.
     * Without that lock `reparentSettled` is true by the time the mutation runs.
     */
    it("makes a reparent racing a subtree-scoped write wait for it", async () => {
      const companyId = randomUUID();
      const actorAgentId = randomUUID();
      const managerAgentId = randomUUID();
      const assigneeAgentId = randomUUID();
      const runId = randomUUID();
      const sourceIssueId = randomUUID();
      const targetIssueId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      });
      await db.insert(agents).values([
        { id: managerAgentId, name: "Manager", reportsTo: null },
        // Under the manager, so a `subtree:<manager>` grant covers its issues.
        { id: assigneeAgentId, name: "Report", reportsTo: managerAgentId },
        { id: actorAgentId, name: "Sweeper", reportsTo: null },
      ].map((agent) => ({
        ...agent,
        companyId,
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })));
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: actorAgentId,
        status: "running",
        responsibleUserId: "board-user",
        contextSnapshot: { issueId: sourceIssueId },
      });
      await db.insert(issues).values([
        { id: sourceIssueId, companyId, title: "Sweep task" },
        { id: targetIssueId, companyId, title: "Report's task", assigneeAgentId },
      ]);
      // An `issues:cross-write` grant confers nothing without an active
      // membership behind it, the same rule `decidePrincipalGrant` applies to
      // every other permission key (FAI-10144 round 3).
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "agent",
        principalId: actorAgentId,
        status: "active",
        membershipRole: "member",
      });
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: actorAgentId,
        permissionKey: "issues:cross-write",
        // The `allow` selector form, so this covers the prefixed path too.
        scope: { allow: [`subtree:${managerAgentId}`] },
      });

      const decision = await observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId: actorAgentId,
        targetIssueId,
        targetIssueIdentifier: "SUBTREE-1",
        kind: "update",
        now: NOW,
        enforceGrantAt: ENFORCE_AT,
      });
      expect(decision?.fence).toMatchObject({ basisAtCheck: "explicit_permission_grant" });

      let releaseFence!: () => void;
      const fenceTaken = new Promise<void>((resolve) => { releaseFence = resolve; });
      let reparentSettled = false;

      const persisted = db.transaction(async (tx) => {
        await assertCrossIssueWriteFence(db, tx, decision?.fence);
        releaseFence();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(reparentSettled).toBe(false);
        await tx.insert(activityLog).values(
          mutationRow(companyId, actorAgentId, runId, targetIssueId),
        );
      });

      await fenceTaken;
      // The assignee leaves the manager's subtree: the grant no longer covers it.
      const reparent = db
        .update(agents)
        .set({ reportsTo: null })
        .where(eq(agents.id, assigneeAgentId))
        .then(() => { reparentSettled = true; });

      await persisted;
      await reparent;

      expect(await countMutations(companyId)).toBe(1);
    });

    /**
     * FAI-10151 finding 3. `FOR SHARE` on the grant row cannot survive a
     * wholesale replacement. Under READ COMMITTED a locking read that waits on a
     * row the replacement deletes resumes with that row skipped and holds no
     * lock; the fence's next statement is a new snapshot that sees the
     * *reinserted* row, so it decides on a row nothing is holding. A shortening
     * or revocation arriving after that read used to commit immediately and the
     * mutation still landed behind it — authority checked, then withdrawn, then
     * written.
     *
     * The fence now takes `principalGrantLock` in shared mode before it reads —
     * the same advisory lock, keyed on the principal's identity, that every
     * grant writer takes exclusively. An identity cannot be deleted and
     * reinserted, so it is the one thing the reader and the replacement can both
     * name. The shortening waits for the mutation instead of racing under it.
     */
    it("keeps its authority lock across a grant replacement landing under the fence", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const otherAgentId = randomUUID();
      const runId = randomUUID();
      const sourceIssueId = randomUUID();
      const targetIssueId = randomUUID();
      const projectId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      });
      await db.insert(agents).values([agentId, otherAgentId].map((id, index) => ({
        id,
        companyId,
        name: index === 0 ? "Replaced Sweeper" : "Owner",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })));
      // The grant confers nothing without an active membership behind it.
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        membershipRole: "member",
        status: "active",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        responsibleUserId: "board-user",
        contextSnapshot: { issueId: sourceIssueId },
      });
      await db.insert(projects).values({ id: projectId, companyId, name: "Sweeps" });
      await db.insert(issues).values([
        { id: sourceIssueId, companyId, title: "Sweep task" },
        { id: targetIssueId, companyId, title: "Peer task", assigneeAgentId: otherAgentId, projectId },
      ]);
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "issues:cross-write",
        scope: { projectId },
        expiresAt: null,
      });

      /** What every wholesale-replacement caller runs: lock, read, delete, reinsert. */
      const replaceGrant = async (
        tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
        expiresAt?: Date | null,
      ) => {
        const rows = await grantRowsPreservingExpiry(tx, {
          companyId,
          principalType: "agent",
          principalId: agentId,
          grants: [{
            permissionKey: "issues:cross-write",
            scope: { projectId },
            ...(expiresAt === undefined ? {} : { expiresAt }),
          }],
          grantedByUserId: null,
          now: new Date(),
        });
        await tx
          .delete(principalPermissionGrants)
          .where(and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, "agent"),
            eq(principalPermissionGrants.principalId, agentId),
          ));
        if (rows.length > 0) await tx.insert(principalPermissionGrants).values(rows);
      };

      const decision = await observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId,
        targetIssueIdentifier: "REPLACED-1",
        kind: "update",
        now: NOW,
        enforceGrantAt: ENFORCE_AT,
      });
      expect(decision?.fence).toMatchObject({ basisAtCheck: "explicit_permission_grant" });

      let releaseReplacement!: () => void;
      const replacementTaken = new Promise<void>((resolve) => { releaseReplacement = resolve; });
      let releaseFence!: () => void;
      const fenceTaken = new Promise<void>((resolve) => { releaseFence = resolve; });
      let shorteningSettled = false;

      // Connection B: an unrelated edit that rewrites the grant row's identity
      // while the fence is trying to lock it. Held open so the fence genuinely
      // blocks behind it rather than merely running after it.
      const replacement = db.transaction(async (tx) => {
        await replaceGrant(tx);
        releaseReplacement();
        // Held until PostgreSQL confirms the fence is queued behind this lock.
        await waitForLockWaiter();
      });

      await replacementTaken;
      // Connection A: the persisting write. It waits for B, then re-reads the
      // grant — which is now a different row than the one it tried to lock.
      const persisted = db.transaction(async (tx) => {
        await assertCrossIssueWriteFence(db, tx, decision?.fence);
        releaseFence();
        // The shortening must be *blocked*, not merely slow. Proving a waiter
        // exists is the whole assertion: with the fence's shared lock removed
        // the shortening commits immediately and there is no waiter to find.
        await waitForLockWaiter();
        // Without the shared advisory lock this is already true: the fence holds
        // nothing on the reinserted row, so the shortening commits underneath it.
        expect(shorteningSettled).toBe(false);
        await tx.insert(activityLog).values(mutationRow(companyId, agentId, runId, targetIssueId));
      });

      await fenceTaken;
      // Connection C: the operator withdraws the authority the fence just read.
      const shortening = db
        .transaction((tx) => replaceGrant(tx, new Date(NOW.getTime() - 1)))
        .then(() => { shorteningSettled = true; });

      await replacement;
      await persisted;
      await shortening;

      // Serialized, not raced: the write stands and the withdrawal applies after it.
      expect(await countMutations(companyId)).toBe(1);
      const surviving = await db
        .select({ expiresAt: principalPermissionGrants.expiresAt })
        .from(principalPermissionGrants)
        .where(eq(principalPermissionGrants.companyId, companyId));
      expect(surviving).toHaveLength(1);
      expect(surviving[0]!.expiresAt?.getTime()).toBe(NOW.getTime() - 1);
    });
  });

  /**
   * `grantRowsPreservingExpiry` carries an omitted expiry forward so that a
   * client round-tripping the grant list without the field cannot un-time-box a
   * grant. Locking the grant rows alone does not make that safe, because a
   * replacement deletes and reinserts them instead of updating in place: under
   * READ COMMITTED a `SELECT ... FOR UPDATE` that blocks on a row the winner
   * deletes resumes with that row skipped, and the winner's reinserted row is
   * not in the waiter's statement snapshot either. The preservation map comes
   * back empty, the omitted expiry falls through to null, and the bound the
   * winner just set is silently cleared — omission widening authority.
   *
   * The serializing lock is therefore an advisory lock keyed on the principal's
   * identity (`principalGrantLock`), which exists whether or not any row does,
   * so the grant read that follows it is a new statement with a new snapshot.
   */
  describe("two grant replacements racing (FAI-10144)", () => {
    const PERMISSION_KEY = "issues:cross-write" as const;
    const NOW = new Date("2026-08-23T00:00:00.000Z");

    /** The three statements every `grantRowsPreservingExpiry` caller runs. */
    async function replaceGrants(
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
      input: { companyId: string; principalId: string; expiresAt?: Date | null },
    ) {
      const rows = await grantRowsPreservingExpiry(tx, {
        companyId: input.companyId,
        principalType: "agent",
        principalId: input.principalId,
        grants: [{
          permissionKey: PERMISSION_KEY,
          scope: { projectId: "p" },
          // Absent means "keep the existing bound". Passing the key through
          // without it is exactly what an older client does.
          ...("expiresAt" in input ? { expiresAt: input.expiresAt } : {}),
        }],
        grantedByUserId: null,
        now: new Date(),
      });
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, input.companyId),
            eq(principalPermissionGrants.principalType, "agent"),
            eq(principalPermissionGrants.principalId, input.principalId),
          ),
        );
      if (rows.length > 0) await tx.insert(principalPermissionGrants).values(rows);
    }

    /** An agent holding a single two-week `issues:cross-write` grant. */
    async function seedBoundedGrant() {
      const companyId = randomUUID();
      const agentId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Two Week Sweeper",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        membershipRole: "member",
        status: "active",
      });
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: PERMISSION_KEY,
        scope: { projectId: "p" },
        expiresAt: new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000),
      });

      return { companyId, agentId };
    }

    /** The single grant row left behind, whatever id it now carries. */
    async function grantRowsFor(companyId: string) {
      return db
        .select({ expiresAt: principalPermissionGrants.expiresAt })
        .from(principalPermissionGrants)
        .where(eq(principalPermissionGrants.companyId, companyId));
    }

    it("preserves the winner's shortened bound instead of clearing it", async () => {
      const { companyId, agentId } = await seedBoundedGrant();

      // The operator shortens the bound to one day.
      const shortened = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);

      let releaseLock!: () => void;
      const lockTaken = new Promise<void>((resolve) => { releaseLock = resolve; });

      const winner = db.transaction(async (tx) => {
        await replaceGrants(tx, { companyId, principalId: agentId, expiresAt: shortened });
        releaseLock();
        // Held until PostgreSQL confirms the other session is queued behind
        // this lock. A sleep would pass just as happily with no lock at all.
        await waitForLockWaiter();
      });

      await lockTaken;
      // An older client flips some unrelated permission and writes the list
      // back with no `expiresAt` field at all.
      const waiter = db.transaction(async (tx) => {
        await replaceGrants(tx, { companyId, principalId: agentId });
      });

      await winner;
      await waiter;

      const rows = await grantRowsFor(companyId);

      expect(rows).toHaveLength(1);
      // Without the advisory lock this is null: the bound is gone and the
      // grant is indefinite again.
      expect(rows[0]!.expiresAt).not.toBeNull();
      expect(rows[0]!.expiresAt!.getTime()).toBe(shortened.getTime());
    });

    /**
     * The same race, on a principal with no `company_memberships` row.
     *
     * This is why the lock is advisory rather than a row lock on the membership.
     * Nothing in the schema ties a grant to a membership: there is no foreign
     * key, the revoke path never requires one, and a membership removed after
     * grants were written leaves them behind. A `SELECT ... FOR UPDATE` that
     * matches no rows takes no lock and raises no error, so the previous design
     * degraded silently to no serialization at all on exactly the rows an
     * operator is least likely to be watching — and the omitted-expiry carry
     * forward is a read-then-write, so losing the lock means losing the bound.
     */
    it("serializes replacements for a principal with no membership row", async () => {
      const { companyId, agentId } = await seedBoundedGrant();
      // Membership gone, grants left behind: the orphan state the schema allows.
      await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));

      const shortened = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);

      let releaseLock!: () => void;
      const lockTaken = new Promise<void>((resolve) => { releaseLock = resolve; });

      const winner = db.transaction(async (tx) => {
        await replaceGrants(tx, { companyId, principalId: agentId, expiresAt: shortened });
        releaseLock();
        await waitForLockWaiter();
      });

      await lockTaken;
      const waiter = db.transaction(async (tx) => {
        await replaceGrants(tx, { companyId, principalId: agentId });
      });

      await winner;
      await waiter;

      const rows = await grantRowsFor(companyId);

      expect(rows).toHaveLength(1);
      // With the membership-row lock this is null — and `waitForLockWaiter`
      // above never finds a waiter, because nothing was ever locked.
      expect(rows[0]!.expiresAt).not.toBeNull();
      expect(rows[0]!.expiresAt!.getTime()).toBe(shortened.getTime());
    });

    /**
     * The other writer of these rows. `setPrincipalPermission` backs the
     * per-permission endpoint, and it is a read-then-write too: it used to find
     * the grant row and then update it by id. A replacement landing in between
     * deletes the row it read and inserts a new one with a new id, so the
     * update matched nothing and the operator's shortened bound was discarded
     * with no error — the failure direction that leaves authority open longer
     * than intended (Greptile P1 at `1b6afcce`).
     *
     * The replacement here is the one that carries an omitted expiry forward,
     * so if the update is lost the row keeps the original two-week bound rather
     * than the one day the operator asked for.
     */
    it("keeps an in-place expiry update that races a replacement", async () => {
      const { companyId, agentId } = await seedBoundedGrant();
      const access = accessService(db);
      const shortened = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);

      let releaseLock!: () => void;
      const lockTaken = new Promise<void>((resolve) => { releaseLock = resolve; });

      const replacement = db.transaction(async (tx) => {
        await replaceGrants(tx, { companyId, principalId: agentId });
        releaseLock();
        // Held until the in-place update is provably queued behind this lock.
        await waitForLockWaiter();
      });

      await lockTaken;
      const update = access.setPrincipalPermission(
        companyId,
        "agent",
        agentId,
        PERMISSION_KEY,
        true,
        null,
        { projectId: "p" },
        shortened,
      );

      await replacement;
      await update;

      const rows = await grantRowsFor(companyId);

      expect(rows).toHaveLength(1);
      // Without the shared lock this is the original two-week bound: the update
      // addressed a row the replacement had already destroyed.
      expect(rows[0]!.expiresAt).not.toBeNull();
      expect(rows[0]!.expiresAt!.getTime()).toBe(shortened.getTime());
    });
  });
  /**
   * The `issues:cross-write` grant is read by its own lookup in
   * `cross-issue-write-basis.ts`, not by `decidePrincipalGrant`, and round 3 of
   * the FAI-10144 gate found the two had drifted apart (FAI-10152).
   */
  describe("cross-issue grant authority (FAI-10144 round 3)", () => {
    const ENFORCE_AT = new Date("2026-01-01T00:00:00.000Z");
    const NOW = new Date("2026-08-23T00:00:00.000Z");
    const MUTATION_ACTION = "issue.test_persisted_mutation";

    /**
     * An agent whose *only* route to the target is an `issues:cross-write`
     * grant: the target is held by another agent, in no shared tree, from a
     * different origin. Every structural basis is absent by construction, so
     * whatever the grant lookup decides is the whole decision.
     */
    async function seedGrantedAgent(input: {
      membershipStatus: "active" | "suspended" | "pending" | null;
      expiresAt: Date | null;
    }) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const otherAgentId = randomUUID();
      const runId = randomUUID();
      const sourceIssueId = randomUUID();
      const targetIssueId = randomUUID();
      const projectId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      });
      await db.insert(agents).values([agentId, otherAgentId].map((id, index) => ({
        id,
        companyId,
        name: index === 0 ? "Granted Sweeper" : "Owner",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })));
      if (input.membershipStatus) {
        await db.insert(companyMemberships).values({
          companyId,
          principalType: "agent",
          principalId: agentId,
          membershipRole: "member",
          status: input.membershipStatus,
        });
      }
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        responsibleUserId: "board-user",
        contextSnapshot: { issueId: sourceIssueId },
      });
      await db.insert(projects).values({ id: projectId, companyId, name: "Sweeps" });
      await db.insert(issues).values([
        { id: sourceIssueId, companyId, title: "Sweep task" },
        { id: targetIssueId, companyId, title: "Peer task", assigneeAgentId: otherAgentId, projectId },
      ]);
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "issues:cross-write",
        scope: { projectId },
        expiresAt: input.expiresAt,
      });

      return { companyId, agentId, runId, targetIssueId, projectId };
    }

    type Seeded = Awaited<ReturnType<typeof seedGrantedAgent>>;

    const gate = (seeded: Seeded, identifier: string) => observeCrossIssueInfluence(db, {
      companyId: seeded.companyId,
      runId: seeded.runId,
      agentId: seeded.agentId,
      targetIssueId: seeded.targetIssueId,
      targetIssueIdentifier: identifier,
      kind: "update" as const,
      now: NOW,
      enforceGrantAt: ENFORCE_AT,
    });

    const mutationRow = (seeded: Seeded) => ({
      companyId: seeded.companyId,
      actorType: "agent" as const,
      actorId: seeded.agentId,
      agentId: seeded.agentId,
      runId: seeded.runId,
      action: MUTATION_ACTION,
      entityType: "issue",
      entityId: seeded.targetIssueId,
    });

    async function countMutations(companyId: string) {
      const rows = await db
        .select({ action: activityLog.action })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, MUTATION_ACTION)));
      return rows.length;
    }

    /**
     * `decidePrincipalGrant` denies every other permission key with
     * `deny_missing_membership` before it ever looks at the grant row. This
     * lookup skipped that check, and nothing in the schema ties a grant to a
     * membership, so an agent suspended out of the company kept writing across
     * it for as long as the row sat there — the exact standing this issue exists
     * to time-box, held open by a different hole.
     */
    const membershipCases: Array<[string, "suspended" | "pending" | null]> = [
      ["suspended", "suspended"],
      ["pending", "pending"],
      ["removed", null],
    ];

    it.each(membershipCases)("refuses a live grant when the agent's membership is %s", async (
      _label,
      membershipStatus,
    ) => {
      const seeded = await seedGrantedAgent({ membershipStatus, expiresAt: null });

      await expect(gate(seeded, "MEMBERSHIP-1")).rejects.toThrow();
      expect(await countMutations(seeded.companyId)).toBe(0);
    });

    it("still allows the grant when the membership is active", async () => {
      const seeded = await seedGrantedAgent({ membershipStatus: "active", expiresAt: null });

      const decision = await gate(seeded, "MEMBERSHIP-2");
      expect(decision?.fence).toMatchObject({ basisAtCheck: "explicit_permission_grant" });
    });

    /**
     * Acceptance criterion 2: the denial has to be distinguishable in the audit
     * trail. The basis walk returns "no basis" either way, so the instant the
     * grant lapsed has to travel out with the decision or the evidence is gone —
     * "denied because it expired" and "denied because it was never granted"
     * were the same audit row.
     */
    it("records when a lapsed grant expired on the denial it caused", async () => {
      // Relative to the pinned gate clock, not the wall clock: the gate forwards
      // its `now` into the basis walk, so an expiry measured from `Date.now()`
      // would still be in that clock'''s future.
      const expiresAt = new Date(NOW.getTime() - 60_000);
      const seeded = await seedGrantedAgent({ membershipStatus: "active", expiresAt });

      await expect(gate(seeded, "EXPIRED-1")).rejects.toThrow();

      const denials = await db
        .select({ action: activityLog.action, details: activityLog.details })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, seeded.companyId),
          eq(activityLog.action, "issue.cross_issue_write_grant_denied"),
        ));
      expect(denials).toHaveLength(1);
      expect(denials[0]!.details).toMatchObject({
        basis: null,
        grantExpiredAt: expiresAt.toISOString(),
      });
    });

    it("leaves grantExpiredAt null when there was never a grant to expire", async () => {
      const seeded = await seedGrantedAgent({ membershipStatus: "active", expiresAt: null });
      await db.delete(principalPermissionGrants)
        .where(eq(principalPermissionGrants.companyId, seeded.companyId));

      await expect(gate(seeded, "ABSENT-1")).rejects.toThrow();

      const denials = await db
        .select({ details: activityLog.details })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, seeded.companyId),
          eq(activityLog.action, "issue.cross_issue_write_grant_denied"),
        ));
      expect(denials).toHaveLength(1);
      expect(denials[0]!.details).toMatchObject({ basis: null, grantExpiredAt: null });
    });

    /**
     * The fence took its clock reading on entry and then blocked on locks.
     * Every lock it takes can queue behind a transaction of unbounded length, so
     * that reading can be arbitrarily stale by the time the expiry is actually
     * evaluated — a grant that lapsed while the fence sat in the queue was still
     * measured against the instant the fence arrived, and the write landed on
     * authority that no longer existed. The clock is now read after the locks.
     *
     * Nothing here writes the grant. The bound is committed before the fence
     * starts; what the fence has to catch is the wall clock crossing it.
     */
    it("measures grant expiry from when the fence got through its locks", async () => {
      const seeded = await seedGrantedAgent({ membershipStatus: "active", expiresAt: null });

      const decision = await gate(seeded, "FENCE-CLOCK-1");
      expect(decision?.fence).toMatchObject({ basisAtCheck: "explicit_permission_grant" });

      const expiresAt = new Date(Date.now() + 300);
      await db
        .update(principalPermissionGrants)
        .set({ expiresAt })
        .where(eq(principalPermissionGrants.companyId, seeded.companyId));

      let releaseHold!: () => void;
      const holdTaken = new Promise<void>((resolve) => { releaseHold = resolve; });

      // An unrelated writer holding the principal's grant lock, so the fence has
      // to queue for it. Released only once the bound has genuinely lapsed.
      const holder = db.transaction(async (tx) => {
        await tx.execute(principalGrantLock({
          companyId: seeded.companyId,
          principalType: "agent",
          principalId: seeded.agentId,
        }));
        releaseHold();
        await waitForLockWaiter();
        while (Date.now() <= expiresAt.getTime()) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      });

      await holdTaken;
      const persisted = db.transaction(async (tx) => {
        await assertCrossIssueWriteFence(db, tx, decision?.fence);
        await tx.insert(activityLog).values(mutationRow(seeded));
      });

      const [holderResult, persistedResult] = await Promise.allSettled([holder, persisted]);

      expect(holderResult.status).toBe("fulfilled");
      // Entered while the grant was live, got through the queue after it had
      // lapsed. A clock read on entry would have let this write land.
      expect(persistedResult.status).toBe("rejected");
      expect(await countMutations(seeded.companyId)).toBe(0);
    });

    /**
     * The fence answered "still authorized" and *then* the grant ran out while
     * the mutation statements executed. Locking cannot catch this: the fence
     * holds every row its decision read, but `expires_at` is compared against
     * the clock, and no lock stops the clock. So the boundary that has to be
     * authorized is the last one before COMMIT, not the first one after BEGIN.
     *
     * Deterministic rather than timing-dependent: the bound is crossed by
     * waiting for it explicitly between the fence and the write, so the window
     * this proves is the one the code has to close, not one the scheduler
     * happened to produce.
     */
    it("rolls the write back when the grant expires after the fence but before the commit", async () => {
      const seeded = await seedGrantedAgent({ membershipStatus: "active", expiresAt: null });

      const decision = await gate(seeded, "COMMIT-EXPIRY-1");
      expect(decision?.fence).toMatchObject({ basisAtCheck: "explicit_permission_grant" });

      const expiresAt = new Date(Date.now() + 200);
      await db
        .update(principalPermissionGrants)
        .set({ expiresAt })
        .where(eq(principalPermissionGrants.companyId, seeded.companyId));

      const persisted = db.transaction(async (tx) => {
        // Passes: the grant is still live at this instant.
        const basis = await assertCrossIssueWriteFence(db, tx, decision?.fence);
        expect(basis).toBe("explicit_permission_grant");

        while (Date.now() <= expiresAt.getTime()) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        await tx.insert(activityLog).values(mutationRow(seeded));
        await assertCrossIssueWriteFenceUnexpiredAtCommit(db, tx, decision?.fence, basis);
      });

      await expect(persisted).rejects.toThrow();
      // The whole point: not "denied next time", but zero rows from this write.
      expect(await countMutations(seeded.companyId)).toBe(0);

      const refusals = await db
        .select({ details: activityLog.details })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, seeded.companyId),
          eq(activityLog.action, "issue.cross_issue_write_grant_expired_in_flight"),
        ));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]!.details).toMatchObject({
        basisAtCheck: "explicit_permission_grant",
        basisAtWrite: "explicit_permission_grant",
        grantExpiredAt: expiresAt.toISOString(),
      });
    });

    it("commits normally when the grant is still live at the commit boundary", async () => {
      const seeded = await seedGrantedAgent({ membershipStatus: "active", expiresAt: null });

      const decision = await gate(seeded, "COMMIT-EXPIRY-2");
      await db
        .update(principalPermissionGrants)
        .set({ expiresAt: new Date(Date.now() + 60_000) })
        .where(eq(principalPermissionGrants.companyId, seeded.companyId));

      await db.transaction(async (tx) => {
        const basis = await assertCrossIssueWriteFence(db, tx, decision?.fence);
        await tx.insert(activityLog).values(mutationRow(seeded));
        await assertCrossIssueWriteFenceUnexpiredAtCommit(db, tx, decision?.fence, basis);
      });

      expect(await countMutations(seeded.companyId)).toBe(1);
    });

    /**
     * A write riding a structural basis has no expiry to cross, so the commit
     * boundary must not start refusing it because some unrelated grant row
     * happens to have lapsed. Guards against the re-check being wired to the
     * grant table rather than to the basis the fence actually accepted.
     */
    it("ignores a lapsed grant when the write is riding a structural basis", async () => {
      const seeded = await seedGrantedAgent({ membershipStatus: "active", expiresAt: null });
      // Make the actor the target's assignee, so the basis walk stops before it
      // ever reaches the grant.
      await db
        .update(issues)
        .set({ assigneeAgentId: seeded.agentId })
        .where(eq(issues.id, seeded.targetIssueId));

      const decision = await gate(seeded, "COMMIT-EXPIRY-3");
      expect(decision?.fence).toMatchObject({ basisAtCheck: "actor_is_target_assignee" });

      await db
        .update(principalPermissionGrants)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(principalPermissionGrants.companyId, seeded.companyId));

      await db.transaction(async (tx) => {
        const basis = await assertCrossIssueWriteFence(db, tx, decision?.fence);
        expect(basis).toBe("actor_is_target_assignee");
        await tx.insert(activityLog).values(mutationRow(seeded));
        await assertCrossIssueWriteFenceUnexpiredAtCommit(db, tx, decision?.fence, basis);
      });

      expect(await countMutations(seeded.companyId)).toBe(1);
    });
  });
});

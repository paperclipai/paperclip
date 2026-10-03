import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import { activityLog, agents, heartbeatRuns, issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { observeCrossIssueInfluence } from "../services/cross-issue-influence-limit.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/**
 * `GET /api/issues/:id/heartbeat-context` must let a run read its OWN issue scope.
 *
 * A sandboxed run reaches the control plane through the callback bridge, whose route
 * allowlist refuses every run-introspection route — `heartbeat-runs/:runId`,
 * `issues/:id/runs`, `issues/:id/active-run`, `companies/:id/heartbeat-runs`. So this
 * already-allowed route is the only place a run can observe whether it is issue-scoped,
 * and without that a verification of the unscoped-run write path cannot tell a pass that
 * used it from a pass that never reached it.
 */
describeEmbeddedPostgres("heartbeat-context self run scope", () => {
  const ctx = useEmbeddedPostgres("paperclip-self-run-scope-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      // Order matters twice over: issues reference runs and agents
      // (`checkoutRunId`, `assigneeAgentId`), and runs and agents reference the
      // company that `resetCompanyIssueFixtures` deletes last.
      await db.delete(issues);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seed() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Self run scope");
    const companyId = company.companyId;
    const agentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();

    await ctx.db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Senior Engineer",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await ctx.db.insert(issues).values([
      {
        id: issueId,
        companyId,
        identifier: "SRS-1",
        title: "Subject issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        identifier: "SRS-2",
        title: "Another issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);

    return { companyId, agentId, issueId, otherIssueId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function seedRun(
    seeded: Seeded,
    contextSnapshot: Record<string, unknown>,
    overrides: { agentId?: string; companyId?: string } = {},
  ) {
    const runId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values({
      id: runId,
      companyId: overrides.companyId ?? seeded.companyId,
      agentId: overrides.agentId ?? seeded.agentId,
      status: "running",
      contextSnapshot,
    });
    return runId;
  }

  function agentApp(seeded: Seeded, runId: string | null) {
    const actor = {
      type: "agent",
      source: "agent_jwt",
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      ...(runId ? { runId } : {}),
      onBehalfOfUserId: null,
      onBehalfOfMemberships: [],
      isInstanceAdmin: false,
    };
    return routeApp(ctx.db, actor as never, issueRoutes);
  }

  async function readRunScope(seeded: Seeded, runId: string | null, issueId?: string) {
    const res = await request(agentApp(seeded, runId)).get(
      `/api/issues/${issueId ?? seeded.issueId}/heartbeat-context`,
    );
    expect(res.status).toBe(200);
    return res.body.runScope;
  }

  it("reports a run scoped to the issue being read", async () => {
    const seeded = await seed();
    const runId = await seedRun(seeded, { issueId: seeded.issueId });

    expect(await readRunScope(seeded, runId)).toEqual({
      runId,
      runResolved: true,
      scoped: true,
      scopedIssueId: seeded.issueId,
      scopedToThisIssue: true,
    });
  });

  it("reports an unscoped run as unscoped, not as unreadable", async () => {
    const seeded = await seed();
    // What an `on_demand` run's snapshot looks like: no issue, nothing the caller can
    // send to supply one. This is the case the verification had to reach and
    // could not confirm it had reached.
    const runId = await seedRun(seeded, { conversationMode: true });

    expect(await readRunScope(seeded, runId)).toEqual({
      runId,
      runResolved: true,
      scoped: false,
      scopedIssueId: null,
      scopedToThisIssue: false,
    });
  });

  it("distinguishes a run scoped to a different issue from an unscoped run", async () => {
    const seeded = await seed();
    const runId = await seedRun(seeded, { issueId: seeded.otherIssueId });

    expect(await readRunScope(seeded, runId)).toEqual({
      runId,
      runResolved: true,
      scoped: true,
      scopedIssueId: seeded.otherIssueId,
      scopedToThisIssue: false,
    });
  });

  it("accepts the identifier form of a scope, as the write guard does", async () => {
    const seeded = await seed();
    // `contextSnapshot` may carry a human identifier instead of a uuid, and the cap
    // guard treats that as the same issue. A hand-rolled `=== issue.id` comparison here
    // would report `scopedToThisIssue: false` for a write the guard leaves uncharged.
    const runId = await seedRun(seeded, { issueId: "srs-1" });

    expect(await readRunScope(seeded, runId)).toMatchObject({
      scoped: true,
      scopedIssueId: "srs-1",
      scopedToThisIssue: true,
    });
  });

  it("reads `taskId` when `issueId` is absent, as the write guard does", async () => {
    const seeded = await seed();
    const runId = await seedRun(seeded, { taskId: seeded.issueId });

    expect(await readRunScope(seeded, runId)).toMatchObject({
      scoped: true,
      scopedIssueId: seeded.issueId,
      scopedToThisIssue: true,
    });
  });

  it("never discloses the scope of another agent's run", async () => {
    const seeded = await seed();
    const otherAgentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: otherAgentId,
      companyId: seeded.companyId,
      name: "Junior",
      role: "engineer",
      adapterType: "pi_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const foreignRunId = await seedRun(
      seeded,
      { issueId: seeded.issueId },
      { agentId: otherAgentId },
    );

    expect(await readRunScope(seeded, foreignRunId)).toEqual({
      runId: foreignRunId,
      runResolved: false,
      scoped: null,
      scopedIssueId: null,
      scopedToThisIssue: null,
    });
  });

  it("reports an unresolvable run id as unresolved rather than unscoped", async () => {
    const seeded = await seed();
    const staleRunId = randomUUID();

    expect(await readRunScope(seeded, staleRunId)).toEqual({
      runId: staleRunId,
      runResolved: false,
      scoped: null,
      scopedIssueId: null,
      scopedToThisIssue: null,
    });
  });

  it("reports a missing run id without claiming the run is unscoped", async () => {
    const seeded = await seed();
    // The bridge strips `X-Paperclip-Run-Id`, so a legacy API-key caller arrives with no
    // run at all. `scoped: null` is the honest answer; `false` would read as a verified
    // unscoped run.
    expect(await readRunScope(seeded, null)).toEqual({
      runId: null,
      runResolved: false,
      scoped: null,
      scopedIssueId: null,
      scopedToThisIssue: null,
    });
  });

  it("omits run scope for a board caller, which has no heartbeat run", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Board reader");
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId: company.companyId,
      identifier: "SRS-9",
      title: "Board-read issue",
      status: "todo",
      priority: "medium",
    });

    const res = await request(routeApp(ctx.db, company.actor, issueRoutes)).get(
      `/api/issues/${issueId}/heartbeat-context`,
    );

    expect(res.status).toBe(200);
    expect(res.body.runScope).toBeNull();
  });

  // The field is only evidence if it reports the same state the write guard branches on.
  // These two pin that agreement: the same run row that drives `scoped` also drives which
  // path `observeCrossIssueInfluence` takes.
  it("reports `scoped: false` exactly when the write guard takes its unscoped path", async () => {
    const seeded = await seed();
    const runId = await seedRun(seeded, { conversationMode: true });
    await ctx.db
      .update(issues)
      .set({ checkoutRunId: runId })
      .where(eq(issues.id, seeded.issueId));

    // The guard's unscoped sole-checkout branch: permitted and uncharged.
    await expect(
      observeCrossIssueInfluence(ctx.db, {
        companyId: seeded.companyId,
        runId,
        agentId: seeded.agentId,
        targetIssueId: seeded.issueId,
        kind: "comment",
      }),
    ).resolves.toBeNull();

    expect(await readRunScope(seeded, runId)).toMatchObject({
      runResolved: true,
      scoped: false,
    });
  });

  it("reports `scoped: true` exactly when the write guard takes its same-issue path", async () => {
    const seeded = await seed();
    const runId = await seedRun(seeded, { issueId: seeded.issueId });

    await expect(
      observeCrossIssueInfluence(ctx.db, {
        companyId: seeded.companyId,
        runId,
        agentId: seeded.agentId,
        targetIssueId: seeded.issueId,
        kind: "comment",
      }),
    ).resolves.toBeNull();

    expect(await readRunScope(seeded, runId)).toMatchObject({
      runResolved: true,
      scoped: true,
      scopedToThisIssue: true,
    });
  });
});

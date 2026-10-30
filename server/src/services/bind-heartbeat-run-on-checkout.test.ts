import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
} from "../__tests__/helpers/embedded-postgres.js";
import { bindHeartbeatRunOnCheckout } from "./bind-heartbeat-run-on-checkout.js";
import { observeCrossIssueInfluence } from "./cross-issue-influence-limit.js";
import { issueService } from "./issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("bindHeartbeatRunOnCheckout (DEF-963)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-checkout-bind-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedUnscopedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Platform Engineer",
      role: "engineer",
      adapterType: "cursor",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "DEF-963 bind fixture",
      status: "todo",
      priority: "critical",
    });
    // Unassigned wake: company-scoped run with empty snapshot (no PAPERCLIP_TASK_ID).
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      scopeKind: "company",
      issueId: null,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: { wakeReason: "deferred_wake_probe_nudge" },
    });

    return { companyId, agentId, runId, issueId };
  }

  it("binds an unscoped run on checkout so same-issue PATCH attribution passes", async () => {
    const f = await seedUnscopedRun();

    // Before bind: unscoped write spends the cross-issue cap.
    await expect(
      observeCrossIssueInfluence(db, {
        companyId: f.companyId,
        runId: f.runId,
        agentId: f.agentId,
        targetIssueId: f.issueId,
        targetIssueIdentifier: "DEF-963",
        kind: "update",
      }),
    ).resolves.toMatchObject({ count: 1, allowed: true });

    const bound = await bindHeartbeatRunOnCheckout(db, {
      companyId: f.companyId,
      agentId: f.agentId,
      runId: f.runId,
      issueId: f.issueId,
    });
    expect(bound).toEqual({ bound: true, reason: "unscoped" });

    const [run] = await db
      .select({
        scopeKind: heartbeatRuns.scopeKind,
        issueId: heartbeatRuns.issueId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.runId));

    expect(run).toMatchObject({
      scopeKind: "issue",
      issueId: f.issueId,
      contextSnapshot: expect.objectContaining({
        issueId: f.issueId,
        wakeReason: "deferred_wake_probe_nudge",
        checkoutBoundIssueId: f.issueId,
      }),
    });

    // After bind: same-issue write is not cross-issue (no new activity row).
    await expect(
      observeCrossIssueInfluence(db, {
        companyId: f.companyId,
        runId: f.runId,
        agentId: f.agentId,
        targetIssueId: f.issueId,
        targetIssueIdentifier: "DEF-963",
        kind: "comment",
      }),
    ).resolves.toBeNull();
  });

  it("does not steal a binding from a different issue", async () => {
    const f = await seedUnscopedRun();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: f.companyId,
      title: "other",
      status: "todo",
      priority: "medium",
    });
    await db
      .update(heartbeatRuns)
      .set({
        scopeKind: "issue",
        issueId: otherIssueId,
        contextSnapshot: { issueId: otherIssueId },
      })
      .where(eq(heartbeatRuns.id, f.runId));

    const result = await bindHeartbeatRunOnCheckout(db, {
      companyId: f.companyId,
      agentId: f.agentId,
      runId: f.runId,
      issueId: f.issueId,
    });
    expect(result).toEqual({ bound: false, reason: "different_issue" });

    const [run] = await db
      .select({ issueId: heartbeatRuns.issueId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.runId));
    expect(run.issueId).toBe(otherIssueId);
  });

  it("treats issueId column alone as same-issue source after fill", async () => {
    const f = await seedUnscopedRun();
    // Snapshot empty but typed column set (partial bind / older writers).
    await db
      .update(heartbeatRuns)
      .set({
        scopeKind: "issue",
        issueId: f.issueId,
        contextSnapshot: { wakeReason: "deferred_wake_probe_nudge" },
      })
      .where(eq(heartbeatRuns.id, f.runId));

    await expect(
      observeCrossIssueInfluence(db, {
        companyId: f.companyId,
        runId: f.runId,
        agentId: f.agentId,
        targetIssueId: f.issueId,
        kind: "update",
      }),
    ).resolves.toBeNull();
  });

  it("refuses when snapshot and typed columns disagree across issues", async () => {
    const f = await seedUnscopedRun();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: f.companyId,
      title: "typed-column-origin",
      status: "todo",
      priority: "medium",
    });
    // Snapshot already points at checkout target B, but typed issueId still A.
    await db
      .update(heartbeatRuns)
      .set({
        scopeKind: "issue",
        issueId: otherIssueId,
        contextSnapshot: { issueId: f.issueId },
      })
      .where(eq(heartbeatRuns.id, f.runId));

    const result = await bindHeartbeatRunOnCheckout(db, {
      companyId: f.companyId,
      agentId: f.agentId,
      runId: f.runId,
      issueId: f.issueId,
    });
    expect(result).toEqual({ bound: false, reason: "different_issue" });

    const [run] = await db
      .select({
        issueId: heartbeatRuns.issueId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.runId));
    expect(run.issueId).toBe(otherIssueId);
    expect(run.contextSnapshot).toEqual({ issueId: f.issueId });
  });

  it("issueService.checkout binds an unscoped run so same-issue observe is free", async () => {
    const f = await seedUnscopedRun();
    const svc = issueService(db);

    await svc.checkout(f.issueId, f.agentId, ["todo"], f.runId);

    const [run] = await db
      .select({
        scopeKind: heartbeatRuns.scopeKind,
        issueId: heartbeatRuns.issueId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.runId));
    expect(run).toMatchObject({
      scopeKind: "issue",
      issueId: f.issueId,
      contextSnapshot: expect.objectContaining({ issueId: f.issueId }),
    });

    const [issue] = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({
      status: "in_progress",
      checkoutRunId: f.runId,
      executionRunId: f.runId,
    });

    await expect(
      observeCrossIssueInfluence(db, {
        companyId: f.companyId,
        runId: f.runId,
        agentId: f.agentId,
        targetIssueId: f.issueId,
        kind: "comment",
      }),
    ).resolves.toBeNull();
  });
});

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_STALLED_BLOCKER_THRESHOLD_MS,
  STALLED_BLOCKER_ESCALATION_ORIGIN_KIND,
  stalledBlockerEscalationService,
} from "../services/stalled-blocker-escalation.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stalled-blocker escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("stalledBlockerEscalationService.reconcileStalledBlockerEscalations", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stalled-blocker-escalation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const now = new Date("2026-05-14T12:00:00.000Z");
  const stalledBefore = new Date(now.getTime() - DEFAULT_STALLED_BLOCKER_THRESHOLD_MS - 60_000);
  const recentlyUpdated = new Date(now.getTime() - 60_000);

  async function seedScenario(opts: {
    dependentPriority: "critical" | "high" | "medium" | "low";
    dependentStatus?: string;
    blockerStatus?: string;
    blockerUpdatedAt?: Date;
    blockerHasAssignee?: boolean;
  }) {
    const companyId = randomUUID();
    const ctoId = randomUUID();
    const engineerId = randomUUID();
    const dependentIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const issuePrefix = `SBE${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: ctoId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: engineerId,
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "idle",
        reportsTo: ctoId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const issueNumber = Math.floor(Math.random() * 10000);
    const blockerNumber = issueNumber + 1;

    await db.insert(issues).values([
      {
        id: dependentIssueId,
        companyId,
        title: "Dependent issue (blocked)",
        status: opts.dependentStatus ?? "blocked",
        priority: opts.dependentPriority,
        identifier: `${issuePrefix}-${issueNumber}`,
        issueNumber,
        assigneeAgentId: null,
        updatedAt: stalledBefore,
        createdAt: stalledBefore,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Blocker issue",
        status: opts.blockerStatus ?? "in_progress",
        priority: "high",
        identifier: `${issuePrefix}-${blockerNumber}`,
        issueNumber: blockerNumber,
        assigneeAgentId: opts.blockerHasAssignee !== false ? engineerId : null,
        updatedAt: opts.blockerUpdatedAt ?? stalledBefore,
        createdAt: stalledBefore,
      },
    ]);

    // issueId=blocker blocks relatedIssueId=dependent
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
    });

    return { companyId, ctoId, engineerId, dependentIssueId, blockerIssueId, issuePrefix };
  }

  it("creates an escalation task when a critical blocked issue has a 25h-stalled blocker", async () => {
    const { companyId, engineerId, dependentIssueId, blockerIssueId } = await seedScenario({
      dependentPriority: "critical",
      blockerStatus: "in_progress",
      blockerUpdatedAt: stalledBefore,
    });

    const svc = stalledBlockerEscalationService(db);
    const result = await svc.reconcileStalledBlockerEscalations({ companyId, now });

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.escalationIssueIds).toHaveLength(1);

    const escalationId = result.escalationIssueIds[0]!;
    const escalation = await db
      .select()
      .from(issues)
      .where(eq(issues.id, escalationId))
      .then((rows) => rows[0]);

    expect(escalation).toBeDefined();
    expect(escalation!.parentId).toBe(dependentIssueId);
    expect(escalation!.assigneeAgentId).toBe(engineerId);
    expect(escalation!.originKind).toBe(STALLED_BLOCKER_ESCALATION_ORIGIN_KIND);
    expect(escalation!.originId).toBe(blockerIssueId);
    expect(escalation!.originFingerprint).not.toBe("default");
    expect(escalation!.status).toBe("todo");
    expect(escalation!.priority).toBe("high");
  });

  it("creates an escalation task when a high-priority blocked issue has a stalled blocker", async () => {
    const { companyId } = await seedScenario({
      dependentPriority: "high",
      blockerStatus: "blocked",
      blockerUpdatedAt: stalledBefore,
    });

    const svc = stalledBlockerEscalationService(db);
    const result = await svc.reconcileStalledBlockerEscalations({ companyId, now });

    expect(result.created).toBe(1);
  });

  it("does NOT create escalation for medium-priority dependent issues", async () => {
    const { companyId } = await seedScenario({
      dependentPriority: "medium",
      blockerUpdatedAt: stalledBefore,
    });

    const svc = stalledBlockerEscalationService(db);
    const result = await svc.reconcileStalledBlockerEscalations({ companyId, now });

    expect(result.created).toBe(0);
    expect(result.scanned).toBe(0);
  });

  it("does NOT create escalation when blocker was updated recently", async () => {
    const { companyId } = await seedScenario({
      dependentPriority: "critical",
      blockerUpdatedAt: recentlyUpdated,
    });

    const svc = stalledBlockerEscalationService(db);
    const result = await svc.reconcileStalledBlockerEscalations({ companyId, now });

    expect(result.created).toBe(0);
    expect(result.scanned).toBe(0);
  });

  it("does NOT create escalation when dependent issue is not blocked", async () => {
    const { companyId } = await seedScenario({
      dependentPriority: "critical",
      dependentStatus: "in_progress",
      blockerUpdatedAt: stalledBefore,
    });

    const svc = stalledBlockerEscalationService(db);
    const result = await svc.reconcileStalledBlockerEscalations({ companyId, now });

    expect(result.created).toBe(0);
  });

  it("posts a recovery comment on the dependent issue", async () => {
    const { companyId, dependentIssueId } = await seedScenario({
      dependentPriority: "critical",
      blockerUpdatedAt: stalledBefore,
    });

    const svc = stalledBlockerEscalationService(db);
    await svc.reconcileStalledBlockerEscalations({ companyId, now });

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, dependentIssueId));

    expect(comments).toHaveLength(1);
    const body = comments[0]!.body;
    expect(body).toContain("**Failure type:**");
    expect(body).toContain("**Failing endpoint / action:**");
    expect(body).toContain("**Unblock owner:**");
    expect(body).toContain("**Next wake condition:**");
  });

  it("does NOT create a duplicate escalation on the second run (idempotency)", async () => {
    const { companyId } = await seedScenario({
      dependentPriority: "critical",
      blockerUpdatedAt: stalledBefore,
    });

    const svc = stalledBlockerEscalationService(db);

    const first = await svc.reconcileStalledBlockerEscalations({ companyId, now });
    expect(first.created).toBe(1);

    const second = await svc.reconcileStalledBlockerEscalations({ companyId, now });
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);

    const allEscalations = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALLED_BLOCKER_ESCALATION_ORIGIN_KIND),
        ),
      );
    expect(allEscalations).toHaveLength(1);
  });

  it("assigns escalation to blocker assignee, falls back to CTO when blocker has no assignee", async () => {
    const { companyId, ctoId } = await seedScenario({
      dependentPriority: "critical",
      blockerUpdatedAt: stalledBefore,
      blockerHasAssignee: false,
    });

    const svc = stalledBlockerEscalationService(db);
    const result = await svc.reconcileStalledBlockerEscalations({ companyId, now });

    expect(result.created).toBe(1);
    const escalationId = result.escalationIssueIds[0]!;
    const escalation = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, escalationId))
      .then((rows) => rows[0]);

    expect(escalation!.assigneeAgentId).toBe(ctoId);
  });

  it("creates a new escalation in a new week even when previous week's escalation exists", async () => {
    const { companyId } = await seedScenario({
      dependentPriority: "critical",
      blockerUpdatedAt: stalledBefore,
    });

    const svc = stalledBlockerEscalationService(db);

    // First run in week W
    const firstResult = await svc.reconcileStalledBlockerEscalations({ companyId, now });
    expect(firstResult.created).toBe(1);

    // Mark the escalation as done to simulate it was resolved
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.originKind, STALLED_BLOCKER_ESCALATION_ORIGIN_KIND));

    // Second run in the NEXT week (7 days + 1 hour later)
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);
    // Ensure blocker is still stalled relative to nextWeek
    const stillStalledBefore = new Date(nextWeek.getTime() - DEFAULT_STALLED_BLOCKER_THRESHOLD_MS - 60_000);
    await db
      .update(issues)
      .set({ updatedAt: stillStalledBefore })
      .where(eq(issues.originKind, "manual"));

    const secondResult = await svc.reconcileStalledBlockerEscalations({ companyId, now: nextWeek });
    expect(secondResult.created).toBe(1);
  });
});

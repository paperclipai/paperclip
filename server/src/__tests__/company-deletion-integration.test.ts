import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { companyService } from "../services/companies.ts";
import { eq, sql } from "drizzle-orm";
import {
  companies,
  budgetPolicies,
  budgetIncidents,
  feedbackVotes,
  issues,
  approvals,
  projects,
  goals,
  companySkills,
  issueReadStates,
  issueInboxArchives,
  workspaceOperations,
  workspaceRuntimeServices,
  documents,
  documentRevisions,
  agents,
} from "@paperclipai/db";

/**
 * HAP-4 integration regression: seeds representative blocker rows into a
 * real FK-enforced PostgreSQL database and proves companyService.remove()
 * succeeds without a foreign-key failure.
 *
 * Requires DATABASE_URL pointing to a migrated test database.
 */

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("DATABASE_URL required");

const db = createDb(TEST_DB_URL);

describe("companyService.remove() deletion closure (HAP-4 integration)", () => {
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    // Create the test company with unique prefix
    const ts = Date.now().toString(36);
    const companyResult = await db
      .insert(companies)
      .values({
        name: `HAP-4 Deletion Test ${ts}`,
        status: "active",
        issuePrefix: `T${ts}`,
      })
      .returning()
      .then((r) => r[0]);

    companyId = companyResult.id;

    // Create a seeded agent under this company
    agentId = crypto.randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "delete-test-agent",
      role: "engineer",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      status: "active",
    });

    // --- budget_policies + budget_incidents chain ---
    // budget_incidents.policy_id -> budget_policies.id (no onDelete)
    // budget_incidents.approval_id -> approvals.id (no onDelete)
    const policy = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 1000,
        isActive: true,
      })
      .returning()
      .then((r) => r[0]);

    const approval = await db
      .insert(approvals)
      .values({
        companyId,
        type: "agent_hire",
        payload: {},
      })
      .returning()
      .then((r) => r[0]);

    const now = new Date();
    const windowStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const windowEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // Incident referencing policy (no onDelete on policy_id FK)
    await db.insert(budgetIncidents).values({
      companyId,
      policyId: policy.id,
      approvalId: null,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      windowStart,
      windowEnd,
      thresholdType: "hard_stop",
      amountLimit: 1000,
      amountObserved: 1500,
      status: "open",
    });

    // Incident referencing approval (no onDelete on approval_id FK)
    await db.insert(budgetIncidents).values({
      companyId,
      policyId: policy.id,
      approvalId: approval.id,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      windowStart: new Date(windowStart.getTime() + 86400000),
      windowEnd: new Date(windowEnd.getTime() + 86400000),
      thresholdType: "hard_stop",
      amountLimit: 1000,
      amountObserved: 1500,
      status: "open",
    });

    // --- goals + projects chain ---
    // projects.goalId -> goals.id (onDelete: set null)
    const goal = await db
      .insert(goals)
      .values({
        companyId,
        title: "Test Goal",
      })
      .returning()
      .then((r) => r[0]);

    await db.insert(projects).values({
      companyId,
      name: "Test Project",
      goalId: goal.id,
    });

    // --- issues + feedback_votes chain ---
    // feedback_votes.issue_id -> issues.id (no onDelete)
    const issue = await db
      .insert(issues)
      .values({
        companyId,
        title: "Test Issue",
        status: "todo",
      })
      .returning()
      .then((r) => r[0]);

    await db.insert(feedbackVotes).values({
      companyId,
      issueId: issue.id,
      targetType: "issue",
      targetId: issue.id,
      authorUserId: "00000000-0000-0000-0000-000000000002",
      vote: "positive",
    });

    // --- remaining blocker tables ---
    await db.insert(companySkills).values({
      companyId,
      key: "test-skill",
      slug: "test-skill",
      name: "Test Skill",
      markdown: "# Test",
    });

    await db.insert(issueReadStates).values({
      companyId,
      issueId: issue.id,
      userId: "00000000-0000-0000-0000-000000000002",
    });

    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: issue.id,
      userId: "00000000-0000-0000-0000-000000000002",
    });

    // documents + document_revisions
    const doc = await db
      .insert(documents)
      .values({
        companyId,
        format: "markdown",
        latestBody: "# v1",
      })
      .returning()
      .then((r) => r[0]);

    await db.insert(documentRevisions).values({
      companyId,
      documentId: doc.id,
      revisionNumber: 1,
      body: "# v1",
    });

    // workspace_operations
    await db.insert(workspaceOperations).values({
      companyId,
      phase: "test",
    });

    // workspace_runtime_services
    await db.insert(workspaceRuntimeServices).values({
      id: crypto.randomUUID(),
      companyId,
      scopeType: "test",
      serviceName: "test",
      status: "stopped",
      lifecycle: "stopped",
      provider: "test",
    });
  });

  afterAll(async () => {
    try {
      await db.delete(companies).where(eq(companies.name, "HAP-4 Deletion Test"));
    } catch {
      // Already deleted
    }
  });

  it("deletes a company with all seeded blocker rows without FK failure", async () => {
    const svc = companyService(db);
    const result = await svc.remove(companyId);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(companyId);
  });

  it("company is actually gone from the database", async () => {
    const remaining = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((r) => r);

    expect(remaining).toHaveLength(0);
  });
});

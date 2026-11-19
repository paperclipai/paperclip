import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { recoveryService } from "./service.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("restored configuration recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("restored-configuration-");
    db = createDb(database.connectionString);
  });
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  it.each(["same_source", "new_source", "unresolved", "other_task"])("reconciles %s after configuration repair", async mode => {
    const [company] = await db.insert(companies).values({ name: "Restored configuration", issuePrefix: `R${randomUUID().slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", status: "idle", lifecycleState: "ready" }).returning();
    const [task] = await db.insert(issues).values({ companyId: company.id, title: "Resume repaired work", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "failed",
      errorCode: "configuration_incomplete", error: "Missing personal account",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, configurationIncomplete: { reason: "secret_binding_missing" } },
      startedAt: new Date("2026-07-15T20:00:00Z"), finishedAt: new Date("2026-07-15T20:01:00Z"),
      contextSnapshot: { issueId: task.id } }).returning();
    const otherTask = mode === "other_task" ? (await db.insert(issues).values({ companyId: company.id, title: "Other task" }).returning())[0] : task;
    const [resolved] = await db.insert(issueRecoveryActions).values({ companyId: company.id, sourceIssueId: otherTask.id,
      kind: "stranded_assigned_issue", cause: "configuration_incomplete", fingerprint: randomUUID(),
      status: mode === "unresolved" ? "active" : "resolved", outcome: mode === "unresolved" ? null : "restored",
      evidence: { latestRunId: mode === "new_source" ? randomUUID() : run.id }, nextAction: "Repair the account" }).returning();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    await recovery.reconcileStrandedAssignedIssues({ companyId: company.id, issueId: task.id });
    const [current] = await db.select().from(issues).where(eq(issues.id, task.id));
    expect(current).toMatchObject({ status: mode === "same_source" ? "in_progress" : "blocked", assigneeAgentId: agent.id });
    if (mode === "same_source") {
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, task.id))).toEqual([resolved]);
      await recovery.reconcileStrandedAssignedIssues({ companyId: company.id, issueId: task.id });
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]).toEqual(current);
    }
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});

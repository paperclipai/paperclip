import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, applyPendingMigrations, heartbeatRuns, issueRelations, issues,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { requestTaskRetry } from "../services/task-retry.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_HEARTBEAT_TEST_DATABASE_URL");
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("board retry held by an unresolved blocker", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (externalDatabaseUrl) await applyPendingMigrations(externalDatabaseUrl);
    database = externalDatabaseUrl ? { connectionString: externalDatabaseUrl, cleanup: async () => {} }
      : await startEmbeddedPostgresTestDatabase("task-retry-blocker-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("keeps the saved Retry and names the blocker without a new skipped receipt on later sweeps", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Blocked retry", issuePrefix: `B${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Assignee", adapterType: "paperclip_runner" });
    const [parent] = await db.insert(issues).values({ companyId, title: "Write the brief", identifier: "PAP-5",
      status: "in_progress", assigneeAgentId: agentId }).returning();
    const [blocker] = await db.insert(issues).values({ companyId, title: "Part 2", identifier: "PAP-10",
      status: "blocked", assigneeAgentId: agentId }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: parent.id, type: "blocks" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId: parent.id, nativeIssueId: parent.id,
      scopeKind: "issue", status: "failed", runtimeMode: "native", errorCode: "native_session_interrupted",
      finishedAt: new Date(Date.now() - 60_000), contextSnapshot: { issueId: parent.id } });
    const receipt = await requestTaskRetry({ db, companyId, issueId: parent.id, actorId: "board-user",
      actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: runId });
    expect(receipt).toMatchObject({ accepted: true, requestId: expect.any(String) });

    const presentation = await taskInterruptionPresentation(db, parent);
    expect(presentation).toMatchObject({ state: "working", canRetry: false,
      retryWait: { reason: "dependency_blocked", unresolvedBlockerIssueIds: [blocker.id] } });
    expect(presentation?.retryWait?.message).toContain("blocked task");

    const heartbeat = heartbeatService(db);
    const skipped = () => db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "skipped"),
      eq(agentWakeupRequests.reason, "issue_dependencies_blocked"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${parent.id}`,
    ));
    await heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
    await heartbeat.resumeExecutionWaitComments({ companyId });
    expect(await skipped()).toEqual([]);
    const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
    expect(saved).toMatchObject({ status: "deferred_issue_execution", reason: "task_retry", runId: null });
    await heartbeat.resumeExecutionWaitComments({ companyId });
    expect(await skipped()).toEqual([]);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
  });
});

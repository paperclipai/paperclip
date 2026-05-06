import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
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
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const maybeDescribe = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres continuation suppression tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

maybeDescribe("user-cancel suppresses continuation recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-continuation-suppression-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // CASCADE handles all FK-linked child tables in one shot
    await db.execute(sql`TRUNCATE
      heartbeat_run_events,
      heartbeat_runs,
      agent_wakeup_requests,
      issue_comments,
      issues,
      agent_runtime_state,
      agents,
      companies
      CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let testCounter = 0;

  async function setupAgentAndIssue() {
    testCounter += 1;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const prefix = `TS${testCounter}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // issueNumber=1 so any recovery issue created gets issueNumber=2 (no identifier collision)
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-1`,
      issueNumber: 1,
      title: "Test issue",
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    return { companyId, agentId, issueId };
  }

  async function insertRunningRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId },
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
    return runId;
  }

  it("user-initiated cancel does NOT enqueue a continuation recovery run", async () => {
    const { companyId, agentId, issueId } = await setupAgentAndIssue();
    await insertRunningRun(companyId, agentId, issueId);

    await heartbeatService(db).cancelActiveForAgent(agentId);

    const allRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));

    const continuationRun = allRuns.find(
      (r) =>
        r.status === "queued" &&
        typeof r.contextSnapshot === "object" &&
        r.contextSnapshot !== null &&
        (r.contextSnapshot as Record<string, unknown>).retryReason === "issue_continuation_needed",
    );
    expect(continuationRun).toBeUndefined();
  });

  it("user-initiated cancel does NOT enqueue any continuation wakeup request", async () => {
    const { companyId, agentId, issueId } = await setupAgentAndIssue();
    await insertRunningRun(companyId, agentId, issueId);

    await heartbeatService(db).cancelActiveForAgent(agentId);

    const recoveryWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    const continuationWakeup = recoveryWakeups.find(
      (w) => w.reason === "issue_continuation_needed",
    );
    expect(continuationWakeup).toBeUndefined();
  });
});

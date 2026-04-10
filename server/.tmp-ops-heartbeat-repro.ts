import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import {
  createDb,
  companies,
  agents,
  issues,
  issueComments,
  agentWakeupRequests,
  heartbeatRuns,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { issueService, heartbeatService } from "./src/services/index.ts";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  throw new Error(`Embedded Postgres unsupported: ${support.reason ?? "unknown"}`);
}

const testDb = await startEmbeddedPostgresTestDatabase("paperclip-ops-heartbeat-smoke-");
const db = createDb(testDb.connectionString);

try {
  const companyId = randomUUID();
  const issuePrefix = `OPS-${companyId.slice(0, 6).toUpperCase()}`;

  const [company] = await db
    .insert(companies)
    .values({
      id: companyId,
      name: "Ops Heartbeat Smoke Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    })
    .returning();

  const [opsAgent] = await db
    .insert(agents)
    .values({
      companyId: company.id,
      name: "Operations Agent",
      role: "operations",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { executionBoundary: "orchestrator_only" },
      permissions: {},
    })
    .returning();

  const [specialist] = await db
    .insert(agents)
    .values({
      companyId: company.id,
      name: "Specialist Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })
    .returning();

  const issuesSvc = issueService(db);
  const heartbeat = heartbeatService(db);

  const [brokenIssue] = await db
    .insert(issues)
    .values({
      companyId: company.id,
      title: "Recover broken execution work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: specialist.id,
    })
    .returning();

  const continuationIssue = await issuesSvc.create(company.id, {
    title: "Reissue continuation",
    status: "todo",
    assigneeAgentId: specialist.id,
    assigneeUserId: null,
    priority: "medium",
    recoveryFromIssueId: brokenIssue.id,
    recoveryDisposition: "recovered_by_reissue",
  });

  const beforeIssue = await db
    .select()
    .from(issues)
    .where(eq(issues.id, brokenIssue.id))
    .then((rows) => rows[0]);

  const run = await heartbeat.invoke(opsAgent.id, "on_demand", {
    triggeredBy: "manual-smoke",
    marker: "ops-heartbeat-test",
  }, "manual");

  if (!run) {
    throw new Error("Heartbeat invocation skipped");
  }

  let current = run;
  for (let i = 0; i < 40; i += 1) {
    const polled = await heartbeat.getRun(run.id);
    if (!polled) throw new Error("run disappeared");
    current = polled;
    if (polled.status === "succeeded" || polled.status === "failed" || polled.status === "cancelled") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const afterIssue = await db
    .select()
    .from(issues)
    .where(eq(issues.id, brokenIssue.id))
    .then((rows) => rows[0]);

  const followupIssue = await db
    .select()
    .from(issues)
    .where(eq(issues.id, continuationIssue.id))
    .then((rows) => rows[0]);

  const comments = await db
    .select()
    .from(issueComments)
    .where(eq(issueComments.issueId, brokenIssue.id))
    .orderBy(desc(issueComments.createdAt));

  const wakeups = await db
    .select()
    .from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.agentId, specialist.id));

  const opsRuns = await db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.agentId, opsAgent.id));

  console.log("RUN_STATUS", JSON.stringify(current, null, 2));
  console.log("BEFORE_BROKEN_ISSUE", JSON.stringify(beforeIssue, null, 2));
  console.log("AFTER_BROKEN_ISSUE", JSON.stringify(afterIssue, null, 2));
  console.log("CONTINUATION", JSON.stringify(followupIssue, null, 2));
  console.log("BROKEN_COMMENTS", comments.length);
  for (const c of comments) {
    console.log("COMMENT", c.id, c.createdByRunId, c.body);
  }
  console.log("SPECIALIST_WAKEUPS", wakeups.length);
  for (const w of wakeups) {
    console.log("WAKEUP", w.id, w.status, w.reason, w.source, w.triggerDetail);
  }
  console.log("OPS_RUNS", opsRuns.map((row) => `${row.id}:${row.status}`).join(", "));
} finally {
  await testDb.cleanup();
}

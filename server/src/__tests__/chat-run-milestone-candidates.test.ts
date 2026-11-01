import { randomUUID } from "node:crypto";
import { and, asc, gte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, chatConversations, chatEndpoints, companies, createDb, heartbeatRuns,
  issues, toolApplications, toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { chatRunMilestoneSource } from "../services/chat-run-milestone-candidates.js";
import { boundRunIssueIdSql } from "../services/run-task-binding.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat milestone candidate prefilter", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("chat-milestone-candidates-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  it("preserves complete rows, binding precedence, company scope and the recovery window", async () => {
    const companyId = randomUUID(), foreignCompanyId = randomUUID(), agentId = randomUUID();
    const issueId = randomUUID(), foreignIssueId = randomUUID(), closedIssueId = randomUUID();
    const applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID();
    const since = new Date("2026-10-20T00:00:00.000Z");
    await db.insert(companies).values([
      { id: companyId, name: "Chat candidates", issuePrefix: "CHAT" },
      { id: foreignCompanyId, name: "Foreign", issuePrefix: "FRGN" },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat agent" });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Active" },
      { id: closedIssueId, companyId, title: "Closed" },
      { id: foreignIssueId, companyId: foreignCompanyId, title: "Foreign" },
    ]);
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Slack", type: "native" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId, assignedAgentId: agentId });
    await db.insert(chatConversations).values([
      { companyId, endpointId, issueId, externalConversationId: "active", externalLabel: "Active", state: "waiting" },
      { companyId, endpointId, issueId: closedIssueId, externalConversationId: "closed", externalLabel: "Closed", state: "completed" },
    ]);
    const cases = [
      { context: { issueId }, matches: true },
      { context: { issueId: `  ${issueId}  ` }, matches: true },
      { context: { issueId: " ", taskId: issueId }, matches: true },
      { context: { issueId: 12, taskId: issueId }, matches: true },
      { context: { issueId: { id: issueId }, taskId: issueId }, matches: true },
      { context: { issueId: [issueId], taskId: issueId }, matches: true },
      { context: { issueId: issueId.toUpperCase() }, matches: false },
      { context: { issueId: "malformed", taskId: issueId }, matches: false },
      { context: { issueId: "malformed" }, nativeIssueId: issueId, matches: true },
      { context: { issueId: "malformed" }, runIssueId: issueId, matches: true },
      { context: { issueId }, nativeIssueId: foreignIssueId, runIssueId: issueId, matches: false },
      { context: { issueId: foreignIssueId }, matches: false },
      { context: { issueId: closedIssueId }, matches: false },
      { context: null, matches: false },
      { context: "scalar", matches: false },
      { context: [{ issueId }], matches: false },
      { context: { issueId }, updatedAt: new Date(since.getTime() - 1), matches: false },
    ];
    const expectedIds: string[] = [];
    // Historical row shapes must survive the fixture's insert-time UUID
    // normalization so this tests legacy reads, including uppercase text.
    await db.$client.unsafe("alter table heartbeat_runs disable trigger heartbeat_runs_set_scope_kind");
    try {
      for (const item of cases) {
        const runId = randomUUID();
        await db.$client.unsafe(`insert into heartbeat_runs
          (id, company_id, agent_id, status, scope_kind, issue_id, native_issue_id, context_snapshot, updated_at)
          values ($1, $2, $3, 'running', $4, $5, $6, $7::jsonb, $8)`,
        [runId, companyId, agentId, "runIssueId" in item ? "issue" : "company",
          "runIssueId" in item ? item.runIssueId : null, "nativeIssueId" in item ? item.nativeIssueId : null,
          JSON.stringify(item.context), (item.updatedAt ?? since).toISOString()]);
        if (item.matches) expectedIds.push(runId);
      }
    } finally {
      await db.$client.unsafe("alter table heartbeat_runs enable trigger heartbeat_runs_set_scope_kind");
    }
    const fields = {
      id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, updatedAt: heartbeatRuns.updatedAt,
      nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
      contextSnapshot: heartbeatRuns.contextSnapshot, resultJson: heartbeatRuns.resultJson,
    };
    const original = await db.select(fields).from(heartbeatRuns).where(and(
      gte(heartbeatRuns.updatedAt, since),
      sql`exists (select 1 from ${chatConversations}
        where ${chatConversations.companyId} = ${heartbeatRuns.companyId}
          and ${chatConversations.issueId}::text = ${boundRunIssueIdSql()}
          and ${chatConversations.state} in ('active', 'waiting'))`,
    )).orderBy(asc(heartbeatRuns.id));
    const filtered = await db.select(fields).from(chatRunMilestoneSource(since)).orderBy(asc(heartbeatRuns.id));
    expect(filtered).toEqual(original);
    expect(filtered.map(row => row.id)).toEqual(expectedIds.sort());
  });
});

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { settleConversationTurnForRun } from "../services/agent-conversations.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("conversation settlement transfer", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-conversation-settlement-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); }, 60_000);

  async function seed(reply: "response" | "interaction" | "reset" | "none" = "response") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), wakeId = randomUUID();
    const padding = "saved conversation ".repeat(32_768);
    await db.insert(companies).values({ id: companyId, name: "Settlement transfer", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Conversation agent", role: "engineer" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Conversation", description: padding,
      status: "in_progress", conversationState: "active", conversationUserId: "conversation-owner",
      conversationAgentId: agentId, assigneeAgentId: agentId, conversationSessionGeneration: 3 });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded",
      contextSnapshot: { issueId, conversationSessionGeneration: 3, wakeCommentId: wakeId,
        conversationReset: reply === "reset", savedInput: padding },
      runnerProfileJson: { savedProfile: padding }, resultJson: { savedResult: padding },
      stdoutExcerpt: padding, stderrExcerpt: padding });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const wakeTime = new Date(Date.now() - 10_000);
    await db.insert(issueComments).values({ id: wakeId, companyId, issueId, authorUserId: "conversation-owner",
      body: padding, createdAt: wakeTime });
    if (reply === "response") await db.insert(issueComments).values({ companyId, issueId,
      createdByRunId: runId, authorAgentId: agentId, origin: "comment", body: padding });
    if (reply === "interaction") await db.insert(issueThreadInteractions).values({ companyId, issueId,
      sourceRunId: runId, createdByAgentId: agentId, status: "pending", kind: "request_confirmation", payload: { version: 1 } });
    return { companyId, agentId, issueId, runId, wakeId, wakeTime };
  }

  async function sourceDigests(input: Awaited<ReturnType<typeof seed>>) {
    return db.execute(sql`select
      (select encode(sha256(convert_to(jsonb_build_array(context_snapshot,runner_profile_json,result_json,stdout_excerpt,stderr_excerpt)::text,'UTF8')),'hex')
        from heartbeat_runs where id=${input.runId}::uuid) as run_digest,
      (select encode(sha256(convert_to(description,'UTF8')),'hex') from issues where id=${input.issueId}::uuid) as description_digest,
      (select encode(sha256(convert_to(jsonb_agg(jsonb_build_array(id,body) order by id)::text,'UTF8')),'hex')
        from issue_comments where issue_id=${input.issueId}::uuid) as comments_digest`);
  }

  it.each(["response", "interaction", "reset"] as const)("bounds %s settlement reads and retains all saved text and run payloads", async reply => {
    const input = await seed(reply), before = await sourceDigests(input);
    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { heartbeatRuns, issues, issueComments }, capture);
    try { expect(await settleConversationTurnForRun(db, input.companyId, input.runId)).toBe(true); }
    finally { capture.flush(); }
    const reads = events.filter(event => event.event === "paperclip.db_response_capture.entry.v1"
      && ["heartbeat_runs", "issues", "issue_comments"].includes(String(event.table))
      && (event.operation === "select" || event.operation === "execute"));
    expect(reads.reduce((sum, event) => sum + Number(event.calls), 0)).toBeGreaterThanOrEqual(4);
    expect(reads.reduce((sum, event) => sum + Number(event.responseValueBytes), 0)).toBeLessThan(16_384);
    const [issue] = await db.select({ status: issues.status, state: issues.conversationState }).from(issues).where(eq(issues.id, input.issueId));
    expect(issue).toEqual({ status: "in_review", state: "waiting" });
    expect(await sourceDigests(input)).toEqual(before);
  });

  it.each(["conversationReplyBoundaryCommentId", "wakeCommentId", "commentId"] as const)("keeps later user messages active through %s", async key => {
    const input = await seed();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: input.issueId,
      conversationSessionGeneration: 3, [key]: input.wakeId } }).where(eq(heartbeatRuns.id, input.runId));
    await db.insert(issueComments).values({ companyId: input.companyId, issueId: input.issueId,
      authorUserId: "conversation-owner", body: "A new instruction", createdAt: new Date(input.wakeTime.getTime() + 1000) });
    expect(await settleConversationTurnForRun(db, input.companyId, input.runId)).toBe(true);
    const [issue] = await db.select({ status: issues.status, state: issues.conversationState }).from(issues).where(eq(issues.id, input.issueId));
    expect(issue).toEqual({ status: "in_progress", state: "active" });
  });

  it.each(["missing", "company", "issue-company", "generation", "owner", "failed", "no-reply"] as const)("refuses to settle a %s mismatch", async fault => {
    const input = await seed(fault === "no-reply" ? "none" : "response");
    if (fault === "generation") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: input.issueId,
      conversationSessionGeneration: 2, wakeCommentId: input.wakeId } }).where(eq(heartbeatRuns.id, input.runId));
    if (fault === "owner") {
      const otherRun = randomUUID();
      await db.insert(heartbeatRuns).values({ id: otherRun, companyId: input.companyId, agentId: input.agentId });
      await db.update(issues).set({ executionRunId: otherRun }).where(eq(issues.id, input.issueId));
    }
    if (fault === "failed") await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, input.runId));
    if (fault === "issue-company") {
      const otherCompany = randomUUID(), otherIssue = randomUUID(), otherAgent = randomUUID();
      await db.insert(companies).values({ id: otherCompany, name: "Other company", issuePrefix: otherCompany.slice(0, 8) });
      await db.insert(agents).values({ id: otherAgent, companyId: otherCompany, name: "Other agent" });
      await db.insert(issues).values({ id: otherIssue, companyId: otherCompany, title: "Other conversation",
        conversationUserId: "other-owner", conversationAgentId: otherAgent, assigneeAgentId: otherAgent,
        conversationState: "active", conversationSessionGeneration: 3 });
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: otherIssue, conversationSessionGeneration: 3,
        conversationReset: true } }).where(eq(heartbeatRuns.id, input.runId));
    }
    expect(await settleConversationTurnForRun(db, fault === "company" ? randomUUID() : input.companyId,
      fault === "missing" ? randomUUID() : input.runId)).toBe(false);
    const [issue] = await db.select({ status: issues.status }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    expect(issue.status).toBe("in_progress");
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues, runIdentityContexts } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { boundRunIssueId, boundRunIssueIdSql } from "../run-task-binding.js";
import { chatRunSourceMessageId } from "./run-origin.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("channel task provenance", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-channel-origin-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Channel continuation", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Channel agent", role: "general", adapterType: "codex_local" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Channel task", assigneeAgentId: agent.id }).returning();
    const [source, continued] = await db.insert(heartbeatRuns).values([
      { companyId: company.id, agentId: agent.id, status: "succeeded", contextSnapshot: { issueId: issue.id }, responsibleUserId: "requester" },
      { companyId: company.id, agentId: agent.id, status: "running", nativeIssueId: issue.id, contextSnapshot: {}, responsibleUserId: "requester" },
    ]).returning();
    const messageId = randomUUID();
    const [origin] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: source.id, revision: 1, responsibleUserId: "requester", messageId, cause: "instruction", correlationId: "message" }).returning();
    const [context] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: continued.id, revision: 1, responsibleUserId: "requester", parentContextId: origin.id, cause: "monitor", correlationId: "dispatch" }).returning();
    const [run] = await db.update(heartbeatRuns).set({ activeIdentityContextId: context.id }).where(eq(heartbeatRuns.id, continued.id)).returning();
    return { company, agent, issue, source, run, origin, context, messageId };
  }

  it("recovers the accepted message across repeated native and legacy task continuations", async () => {
    const f = await fixture();
    expect(await chatRunSourceMessageId(db, f.run)).toBe(f.messageId);
    const [next] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running", issueId: f.issue.id, responsibleUserId: "requester" }).returning();
    const [context] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: next.id, revision: 1, responsibleUserId: "requester", parentContextId: f.context.id, cause: "retry", correlationId: "dispatch" }).returning();
    const [run] = await db.update(heartbeatRuns).set({ activeIdentityContextId: context.id }).where(eq(heartbeatRuns.id, next.id)).returning();
    expect(await chatRunSourceMessageId(db, run)).toBe(f.messageId);
  });

  it("keeps valid channel authority after more than 100 continuations", async () => {
    const f = await fixture();
    const runs = Array.from({ length: 120 }, () => ({ id: randomUUID(), companyId: f.company.id, agentId: f.agent.id, status: "succeeded", nativeIssueId: f.issue.id, responsibleUserId: "requester" }));
    await db.insert(heartbeatRuns).values(runs);
    const ids = runs.map(() => randomUUID());
    await db.insert(runIdentityContexts).values(runs.map((run, index) => ({ id: ids[index], companyId: f.company.id, runId: run.id, revision: 1, responsibleUserId: "requester", parentContextId: index ? ids[index - 1] : f.context.id, cause: "monitor", correlationId: "dispatch" })));
    const [run] = await db.update(heartbeatRuns).set({ activeIdentityContextId: ids.at(-1)! }).where(eq(heartbeatRuns.id, runs.at(-1)!.id)).returning();
    expect(await chatRunSourceMessageId(db, run)).toBe(f.messageId);
  });

  it("stops at a new accepted message instead of borrowing an earlier person's origin", async () => {
    const f = await fixture();
    const messageId = randomUUID();
    await db.update(runIdentityContexts).set({ messageId, responsibleUserId: "new-requester" }).where(eq(runIdentityContexts.id, f.context.id));
    const [run] = await db.update(heartbeatRuns).set({ responsibleUserId: "new-requester", contextSnapshot: { wakeCommentId: f.messageId } }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    expect(await chatRunSourceMessageId(db, run, { allowLegacyWakeComment: true })).toBe(messageId);
  });

  it("recovers a legacy wake only through a verified same-requester parent run", async () => {
    const f = await fixture();
    await db.update(runIdentityContexts).set({ messageId: null }).where(eq(runIdentityContexts.id, f.origin.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id, wakeCommentId: f.messageId } }).where(eq(heartbeatRuns.id, f.source.id));
    expect(await chatRunSourceMessageId(db, f.run)).toBeNull();
    expect(await chatRunSourceMessageId(db, f.run, { allowLegacyWakeComment: true })).toBe(f.messageId);
    await db.update(heartbeatRuns).set({ responsibleUserId: "another-person" }).where(eq(heartbeatRuns.id, f.source.id));
    expect(await chatRunSourceMessageId(db, f.run, { allowLegacyWakeComment: true })).toBeNull();
  });

  it("does not borrow GitHub origin from an earlier requester after a board message", async () => {
    const f = await fixture();
    const [message] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "user", authorUserId: "new-requester", body: "Continue" }).returning();
    await db.update(runIdentityContexts).set({ messageId: message.id, responsibleUserId: "new-requester" }).where(eq(runIdentityContexts.id, f.context.id));
    const [run] = await db.update(heartbeatRuns).set({ responsibleUserId: "new-requester", contextSnapshot: { wakeCommentId: f.messageId } }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    expect(await chatRunSourceMessageId(db, run, { provider: "github", allowLegacyWakeComment: true })).toBeNull();
  });

  it("recovers a legacy GitHub source after a verified same-user board message", async () => {
    const f = await fixture();
    const [message] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "user", authorUserId: "requester", body: "Continue" }).returning();
    await db.update(runIdentityContexts).set({ messageId: null }).where(eq(runIdentityContexts.id, f.origin.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id, wakeCommentId: f.messageId } }).where(eq(heartbeatRuns.id, f.source.id));
    await db.update(runIdentityContexts).set({ messageId: message.id }).where(eq(runIdentityContexts.id, f.context.id));
    const [run] = await db.update(heartbeatRuns).set({ contextSnapshot: { wakeCommentId: message.id } }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    expect(await chatRunSourceMessageId(db, run, { provider: "github", allowLegacyWakeComment: true })).toBe(f.messageId);
    await db.update(heartbeatRuns).set({ responsibleUserId: "another-person" }).where(eq(heartbeatRuns.id, f.source.id));
    expect(await chatRunSourceMessageId(db, run, { provider: "github", allowLegacyWakeComment: true })).toBeNull();
  });

  it.each(["task", "agent", "company", "requester", "missing-parent", "pending-parent", "pending-current", "cycle"])(
    "rejects a %s break in inherited authority", async fault => {
      const f = await fixture();
      if (fault === "task") {
        const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Other task" }).returning();
        const [otherRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "succeeded", nativeIssueId: other.id }).returning();
        await db.update(runIdentityContexts).set({ runId: otherRun.id }).where(eq(runIdentityContexts.id, f.origin.id));
      }
      if (fault === "agent") {
        const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Other agent", role: "general", adapterType: "codex_local" }).returning();
        await db.update(heartbeatRuns).set({ agentId: other.id }).where(eq(heartbeatRuns.id, f.source.id));
      }
      if (fault === "company") {
        const [other] = await db.insert(companies).values({ name: "Other company", issuePrefix: randomUUID().slice(0, 8) }).returning();
        await db.update(runIdentityContexts).set({ companyId: other.id }).where(eq(runIdentityContexts.id, f.origin.id));
      }
      if (fault === "requester") await db.update(runIdentityContexts).set({ responsibleUserId: "another-person" }).where(eq(runIdentityContexts.id, f.origin.id));
      if (fault === "missing-parent") await db.update(runIdentityContexts).set({ parentContextId: randomUUID() }).where(eq(runIdentityContexts.id, f.context.id));
      if (fault === "pending-parent") await db.update(runIdentityContexts).set({ status: "pending" }).where(eq(runIdentityContexts.id, f.origin.id));
      if (fault === "pending-current") await db.update(runIdentityContexts).set({ status: "pending" }).where(eq(runIdentityContexts.id, f.context.id));
      if (fault === "cycle") await db.update(runIdentityContexts).set({ messageId: null, parentContextId: f.context.id }).where(eq(runIdentityContexts.id, f.origin.id));
      await expect(chatRunSourceMessageId(db, f.run)).rejects.toMatchObject({ status: 403 });
    },
  );

  async function delegatedFixture() {
    const f = await fixture();
    const [delegator] = await db.insert(agents).values({ companyId: f.company.id, name: "Delegator", role: "general", adapterType: "codex_local" }).returning();
    const [parentTask] = await db.insert(issues).values({ companyId: f.company.id, title: "Parent task", assigneeAgentId: delegator.id }).returning();
    const [delegatorRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: delegator.id, status: "succeeded", nativeIssueId: parentTask.id, responsibleUserId: "requester" }).returning();
    await db.update(runIdentityContexts).set({ runId: delegatorRun.id, messageId: null, cause: "issue_assigned" }).where(eq(runIdentityContexts.id, f.origin.id));
    return { ...f, delegator, parentTask, delegatorRun };
  }

  async function comeBack(f: Awaited<ReturnType<typeof delegatedFixture>>, values: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [earlier] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "succeeded", nativeIssueId: f.issue.id, responsibleUserId: "requester", ...values }).returning();
    const [back] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: earlier.id, revision: 1, responsibleUserId: "requester", cause: "issue_assigned", correlationId: "dispatch" }).returning();
    await db.update(runIdentityContexts).set({ parentContextId: back.id }).where(eq(runIdentityContexts.id, f.origin.id));
    return back;
  }

  it("stops at a delegating run on another task only when asked, and keeps rejecting by default", async () => {
    const f = await delegatedFixture();
    await expect(chatRunSourceMessageId(db, f.run)).rejects.toMatchObject({ status: 403 });
    expect(await chatRunSourceMessageId(db, f.run, { provider: "github", allowLegacyWakeComment: true, stopAtOtherTask: true })).toBeNull();
    const wakeCommentId = randomUUID();
    const [run] = await db.update(heartbeatRuns).set({ contextSnapshot: { wakeCommentId } }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    expect(await chatRunSourceMessageId(db, run, { provider: "github", allowLegacyWakeComment: true, stopAtOtherTask: true })).toBe(wakeCommentId);
  });

  it("follows a chain that leaves the task and comes back, and judges the task's own earlier context", async () => {
    const f = await delegatedFixture();
    const back = await comeBack(f);
    expect(await chatRunSourceMessageId(db, f.run, { provider: "github", allowLegacyWakeComment: true, stopAtOtherTask: true })).toBeNull();
    await expect(chatRunSourceMessageId(db, f.run)).rejects.toMatchObject({ status: 403 });
    await db.update(runIdentityContexts).set({ responsibleUserId: "another-person" }).where(eq(runIdentityContexts.id, back.id));
    await expect(chatRunSourceMessageId(db, f.run, { provider: "github", allowLegacyWakeComment: true, stopAtOtherTask: true })).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a chain that comes back through another agent on the same task", async () => {
    const f = await delegatedFixture();
    await comeBack(f, { agentId: f.delegator.id });
    await expect(chatRunSourceMessageId(db, f.run, { provider: "github", allowLegacyWakeComment: true, stopAtOtherTask: true })).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    { requester: "requester", allowLegacyWakeComment: true, collected: true },
    { requester: "another-person", allowLegacyWakeComment: true, collected: false },
    { requester: "requester", allowLegacyWakeComment: false, collected: false },
  ])("recovers a legacy wake where the chain comes back only for the same requester ($requester, legacy=$allowLegacyWakeComment)", async ({ requester, allowLegacyWakeComment, collected }) => {
    const f = await delegatedFixture();
    const wakeCommentId = randomUUID();
    await comeBack(f, { responsibleUserId: requester, contextSnapshot: { wakeCommentId } });
    expect(await chatRunSourceMessageId(db, f.run, { provider: "github", allowLegacyWakeComment, stopAtOtherTask: true })).toBe(collected ? wakeCommentId : null);
  });

  it.each(["reentry", "missing-run", "foreign-cycle"])("still rejects a delegated chain with a %s", async fault => {
    const f = await delegatedFixture();
    if (fault === "reentry") {
      const [back] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: f.source.id, revision: 1, responsibleUserId: "requester", messageId: randomUUID(), cause: "instruction", correlationId: "message" }).returning();
      await db.update(runIdentityContexts).set({ parentContextId: back.id }).where(eq(runIdentityContexts.id, f.origin.id));
    }
    if (fault === "missing-run") {
      const [ghost] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: randomUUID(), revision: 1, responsibleUserId: "requester", cause: "monitor", correlationId: "dispatch" }).returning();
      await db.update(runIdentityContexts).set({ parentContextId: ghost.id }).where(eq(runIdentityContexts.id, f.origin.id));
    }
    if (fault === "foreign-cycle") await db.update(runIdentityContexts).set({ parentContextId: f.origin.id }).where(eq(runIdentityContexts.id, f.origin.id));
    await expect(chatRunSourceMessageId(db, f.run, { provider: "github", allowLegacyWakeComment: true, stopAtOtherTask: true })).rejects.toMatchObject({ status: 403 });
  });

  it.each(["native", "issue-column", "legacy-issue", "legacy-task"])("uses the same %s task binding in SQL and runtime authority", async source => {
    const f = await fixture();
    const values = {
      nativeIssueId: source === "native" ? f.issue.id : null,
      issueId: source === "issue-column" ? f.issue.id : null,
      contextSnapshot: source === "legacy-task" ? { issueId: "", taskId: f.issue.id }
        : { issueId: source === "native" ? randomUUID() : source === "issue-column" ? [] : f.issue.id },
    };
    const [run] = await db.update(heartbeatRuns).set(values).where(eq(heartbeatRuns.id, f.run.id)).returning();
    const [projection] = await db.select({ issueId: boundRunIssueIdSql() }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(projection.issueId).toBe(f.issue.id);
    expect(boundRunIssueId(run)).toBe(projection.issueId);
  });
});

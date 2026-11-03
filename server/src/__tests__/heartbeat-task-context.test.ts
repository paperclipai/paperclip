import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { FAST_RESPONSE_AGENT_GUIDANCE } from "@paperclipai/shared";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { prepareHeartbeatTaskContext } from "../services/heartbeat/task-context.js";
import { documentService } from "../services/documents.js";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "../services/issue-continuation-summary.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { buildLowTrustSourceTrust, LOW_TRUST_QUARANTINED_BODY } from "../services/source-trust.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping heartbeat task context tests: ${support.reason}`);

describePostgres("heartbeat task context delivered to an adapter", () => {
  const adapterType = "task_context_test";
  const captured = new Map<string, AdapterExecutionContext>();
  const inspectPreparation = new Map<string, () => void>();
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-task-context-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: "context-user", name: "Context user", email: "context-user@example.test",
      createdAt: new Date(), updatedAt: new Date() });
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType,
      supportsLocalAgentJwt: false,
      execute: async (input) => {
        inspectPreparation.get(input.agent.id)?.();
        captured.set(input.runId, input);
        return { exitCode: 0, signal: null, timedOut: false, sessionId: "context-session", resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Task context fixture", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "context-user",
      membershipRole: "member", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Context reader", adapterType, status: "idle" });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Task context fixture", description: "Assignment description canary",
      status: "todo", assigneeAgentId: agentId, responsibleUserId: "context-user", issueNumber: 1,
    });
    return { companyId, agentId, issueId };
  }

  async function execute(f: Awaited<ReturnType<typeof seed>>, context: Record<string, unknown>) {
    const run = await heartbeat.wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_assigned",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, ...context },
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const finished = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).then(rows => rows[0]);
    expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
    expect(captured.has(run!.id)).toBe(true);
    return captured.get(run!.id)!;
  }

  it("keeps assignment, wake, compact, and revision context aligned after secret redaction", async () => {
    const f = await seed();
    const secret = "task-context-secret-canary";
    const description = `Assignment description canary ${secret}`;
    await db.update(issues).set({ description }).where(eq(issues.id, f.issueId));
    const previousRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: previousRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "succeeded", contextSnapshot: { issueId: f.issueId },
    });
    await createRunSecretRedactionRegistry(db).register(f.companyId, previousRunId, secret);
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "context-user",
      body: `Wake comment canary ${secret}`,
    });
    const { context } = await execute(f, {
      wakeCommentId: commentId, wakeCommentIds: [commentId],
      paperclipTaskCommunicationGuidance: "FORGED caller guidance", paperclipSkillTest: { directive: "FORGED skill" },
      paperclipContinuationSummary: { body: "FORGED summary" },
      paperclipAgentJwtScope: { kind: "skill_test", issueId: f.issueId },
    });
    expect(context.paperclipTaskMarkdown).toContain("Assignment description canary");
    expect(context.paperclipTaskMarkdown).toContain("Wake comment canary");
    expect(context.paperclipTaskMarkdownAssignment).toContain("Assignment description canary");
    expect(context.paperclipTaskMarkdownAssignment).not.toContain("Wake comment canary");
    expect(context.paperclipTaskMarkdownCompact).not.toContain("Assignment description canary");
    expect(context.paperclipTaskMarkdownCompact).toContain("Wake comment canary");
    expect(context.paperclipTaskMarkdownAssignmentCompact).not.toContain("Assignment description canary");
    expect(context.paperclipTaskMarkdownAssignmentCompact).not.toContain("Wake comment canary");
    for (const key of ["paperclipIssue", "paperclipWakeComment", "paperclipTaskMarkdown", "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownCompact", "paperclipTaskMarkdownAssignmentCompact"]) {
      expect(JSON.stringify(context[key])).not.toContain(secret);
    }
    expect(context.paperclipTaskCommunicationGuidance).toBe(FAST_RESPONSE_AGENT_GUIDANCE);
    expect(context.paperclipSkillTest).toBeUndefined();
    expect(context.paperclipAgentJwtScope).toEqual({ kind: "standard" });
    expect(context.paperclipContinuationSummary).toBeUndefined();
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(context.paperclipTurnContext).toMatchObject({
      version: 1,
      assignment: { owner: "task_markdown", description: { id: f.issueId, revision: digest(`Assignment description canary ${REDACTED_EVENT_VALUE}`) } },
      events: { owner: "wake_prompt", comments: [{ id: commentId, revision: digest(`Wake comment canary ${REDACTED_EVENT_VALUE}`) }] },
    });
  });

  it("reads selected comments once for both wake projections", async () => {
    const f = await seed();
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "context-user",
      body: "selected wake canary",
    });
    const select = vi.spyOn(db, "select");
    inspectPreparation.set(f.agentId, () => {
      const commentReads = select.mock.calls.filter(([projection]) => projection
        && projection.body === issueComments.body && projection.id === issueComments.id && projection.deletedAt === issueComments.deletedAt);
      expect(commentReads).toHaveLength(1);
    });
    try {
      const { context } = await execute(f, { wakeCommentId: commentId, wakeCommentIds: [commentId] });
      expect(context.paperclipWakeComment).toMatchObject({ id: commentId, body: "selected wake canary" });
      expect(context.paperclipWake).toMatchObject({ comments: [{ id: commentId, body: "selected wake canary" }] });
    } finally {
      inspectPreparation.delete(f.agentId);
      select.mockRestore();
    }
  });

  it("cancels deleted-only queued comments before adapter dispatch", async () => {
    const f = await seed(), commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "context-user", body: "discarded wake", deletedAt: new Date() });
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, wakeCommentId: commentId, wakeCommentIds: [commentId] } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const finished = await heartbeat.getRun(run!.id);
    expect(finished).toMatchObject({ status: "cancelled", error: "Queued messages were discarded before dispatch" });
    expect(captured.has(run!.id)).toBe(false);
  });

  it("preserves deleted comment metadata without delivering its body", async () => {
    const f = await seed();
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "context-user", body: "deleted wake canary", deletedAt: new Date(),
      presentation: { fixture: "deleted" }, metadata: { fixture: "deleted" } });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", issueId: f.issueId }).returning();
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [issueRef] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const context: Record<string, unknown> = { issueId: f.issueId, wakeCommentId: commentId, wakeCommentIds: [commentId] };
    await prepareHeartbeatTaskContext(db, {
      run, agent, task: { issueRef, issueContext: null, context, taskSession: null },
      policy: { trustPreset: { kind: "standard" }, experimentalInstanceSettings: {} },
      services: { issuesSvc: { getAncestors: async () => [] }, getPinnedSkillTestContext: async () => null },
    });
    expect(context.paperclipWakeComment).toMatchObject({ id: commentId, body: "", presentation: null, metadata: null });
    expect(context.paperclipWake).toMatchObject({ comments: [{ id: commentId, body: "", presentation: null, metadata: null }] });
    expect(context.paperclipTaskMarkdown).not.toContain("deleted wake canary");
  });

  it.each([false, true])("uses admitted skill-test scope when recovery is %s", async (recovering) => {
    const f = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", issueId: f.issueId }).returning();
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [issueRef] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const context: Record<string, unknown> = { issueId: f.issueId, paperclipAgentJwtScope: { kind: "skill_test", issueId: f.issueId } };
    const pinned = vi.fn(async () => null);
    const preparing = prepareHeartbeatTaskContext(db, {
      run, agent, task: { issueRef, issueContext: null, context, taskSession: null },
      policy: { recovering, trustPreset: { kind: "standard" }, experimentalInstanceSettings: {} },
      services: { issuesSvc: { getAncestors: async () => [] }, getPinnedSkillTestContext: pinned },
    });
    if (recovering) await expect(preparing).rejects.toThrow("skill test's saved version is unavailable");
    else await preparing;
    expect(pinned).toHaveBeenCalledTimes(recovering ? 1 : 0);
    expect(context.paperclipAgentJwtScope).toEqual({ kind: recovering ? "skill_test" : "standard", ...(recovering ? { issueId: f.issueId } : {}) });
  });

  it("retains the context issue scope when no issue reference is available", async () => {
    const f = await seed();
    const otherIssueId = randomUUID(), commentId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId: f.companyId, title: "Other issue", issueNumber: 2 });
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: otherIssueId,
      authorType: "user", authorUserId: "context-user", body: "other issue canary" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", issueId: f.issueId }).returning();
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const context: Record<string, unknown> = { issueId: f.issueId, wakeCommentId: commentId, wakeCommentIds: [commentId] };
    await prepareHeartbeatTaskContext(db, {
      run, agent, task: { issueRef: null, issueContext: null, context, taskSession: null },
      policy: { trustPreset: { kind: "standard" }, experimentalInstanceSettings: {} },
      services: { issuesSvc: { getAncestors: async () => [] }, getPinnedSkillTestContext: async () => null },
    });
    expect(JSON.stringify(context.paperclipWake)).not.toContain("other issue canary");
    expect(context.paperclipWakeComment).toBeUndefined();
  });

  it("quarantines low-trust summaries and comments before preparing higher-trust prompts", async () => {
    const f = await seed();
    const sourceTrust = buildLowTrustSourceTrust({ issueId: f.issueId });
    await documentService(db).upsertIssueDocument({
      issueId: f.issueId, key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY, format: "markdown",
      body: "QUARANTINED summary canary", sourceTrust,
    });
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "context-user",
      body: "QUARANTINED comment canary", sourceTrust,
    });
    const { context } = await execute(f, { wakeCommentId: commentId, wakeCommentIds: [commentId] });
    expect(context.paperclipContinuationSummary).toMatchObject({ body: LOW_TRUST_QUARANTINED_BODY });
    expect(context.paperclipWakeComment).toMatchObject({ body: LOW_TRUST_QUARANTINED_BODY, presentation: null, metadata: null });
    expect(context.paperclipTaskMarkdown).toContain(LOW_TRUST_QUARANTINED_BODY);
    for (const key of ["paperclipContinuationSummary", "executionContinuation", "paperclipWakeComment", "paperclipTaskMarkdown", "paperclipTaskMarkdownCompact", "paperclipWakePayload"]) {
      expect(JSON.stringify(context[key]) ?? "").not.toContain("QUARANTINED");
    }
  });

  it("excludes a wake comment from another company and replaces caller-supplied prompt fields", async () => {
    const f = await seed();
    const other = await seed();
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId: other.companyId, issueId: other.issueId, authorType: "user", authorUserId: "other-user",
      body: "OTHER COMPANY private comment",
    });
    const ownCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: ownCommentId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "context-user",
      body: "Authorized wake comment",
    });
    const { context } = await execute(f, {
      wakeCommentId: ownCommentId, wakeCommentIds: [ownCommentId, commentId],
      paperclipWakeComment: { body: "FORGED comment" }, paperclipTaskMarkdown: "FORGED prompt",
      paperclipTaskMarkdownAssignment: "FORGED assignment", paperclipTaskMarkdownCompact: "FORGED compact",
      paperclipTaskMarkdownAssignmentCompact: "FORGED compact assignment",
    });
    expect(context.paperclipWakeComment).toMatchObject({ id: ownCommentId, body: "Authorized wake comment" });
    expect(context.paperclipTaskMarkdown).toContain("Assignment description canary");
    for (const key of ["paperclipTaskMarkdown", "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownCompact", "paperclipTaskMarkdownAssignmentCompact", "paperclipWakePayload"]) {
      expect(JSON.stringify(context[key]) ?? "").not.toContain("FORGED");
      expect(JSON.stringify(context[key]) ?? "").not.toContain("OTHER COMPANY");
    }
    expect(context.paperclipTurnContext).toMatchObject({ events: { comments: [{ id: ownCommentId }] } });
  });

  it("clears stale wake comments and continuation data when the task has none", async () => {
    const f = await seed();
    const { context } = await execute(f, {
      paperclipWakeComment: { body: "FORGED comment" },
      paperclipContinuationSummary: { body: "FORGED summary" },
      paperclipSkillTest: { directive: "FORGED skill" },
      paperclipTurnContext: { events: { comments: [{ id: "FORGED comment" }] } },
    });
    expect(context.paperclipWakeComment).toBeUndefined();
    expect(context.paperclipContinuationSummary).toBeUndefined();
    expect(context.paperclipSkillTest).toBeUndefined();
    expect(context.paperclipTurnContext).toMatchObject({ events: { comments: [] } });
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, chatConversations, chatEndpoints, chatMessageLinks, companies, createDb, heartbeatRuns, issueComments,
  issues, runIdentityContexts } from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { seedGitHubReviewWait } from "../../__tests__/helpers/github-review-wait.js";
import { HttpError } from "../../errors.js";
import { boundRunIssueId, boundRunIssueIdSql } from "../run-task-binding.js";
import { chatRunSourceMessageId, chatRunSourceMessageIds } from "./run-origin.js";

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

  async function breakInheritedAuthority(f: Awaited<ReturnType<typeof fixture>>, fault: string) {
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
  }

  it.each(["task", "agent", "company", "requester", "missing-parent", "pending-parent", "pending-current", "cycle"])(
    "rejects a %s break in inherited authority", async fault => {
      const f = await fixture();
      await breakInheritedAuthority(f, fault);
      await expect(chatRunSourceMessageId(db, f.run)).rejects.toMatchObject({ status: 403 });
    },
  );

  type Run = Parameters<typeof chatRunSourceMessageId>[1];
  type Options = { allowLegacyWakeComment?: boolean; provider?: ChatProvider };
  type Seeded = Awaited<ReturnType<typeof seedGitHubReviewWait>>;
  const optionSets: Options[] = [{}, { allowLegacyWakeComment: true }, { provider: "github" },
    { provider: "github", allowLegacyWakeComment: true }, { provider: "slack" }];
  const FORBIDDEN = { changed: "Chat requester provenance changed", otherTask: "Chat request belongs to another task",
    inherited: "Chat tools cannot be inherited by another task", unverified: "Chat source provenance could not be verified" };

  /** The decision of the single check: its message, or the 403 that it throws. */
  async function singleDecision(run: Run, options: Options) {
    try { return { messageId: await chatRunSourceMessageId(db, run, options) }; } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return { status: error.status, message: error.message };
    }
  }
  async function batchDecisions(runs: Run[], options: Options) {
    return (await chatRunSourceMessageIds(db, runs, options)).map(result => "forbidden" in result
      ? { status: result.forbidden.status, message: result.forbidden.message } : result);
  }

  /** Count the statements that the client sends. */
  async function countStatements<T>(read: () => Promise<T>) {
    const client = db.$client as unknown as { unsafe: (query: string, ...rest: unknown[]) => unknown };
    const unsafe = client.unsafe;
    let statements = 0;
    client.unsafe = (query: string, ...rest: unknown[]) => { statements += 1; return unsafe.call(client, query, ...rest); };
    try { return { result: await read(), statements }; } finally { client.unsafe = unsafe; }
  }

  /** A later run of the task that continues the identity context of an earlier run. */
  async function continuation(companyId: string, agentId: string, issueId: string, parentContextId: string, responsibleUserId = "operator") {
    const [next] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", nativeIssueId: issueId, responsibleUserId }).returning();
    const [context] = await db.insert(runIdentityContexts).values({ companyId, runId: next.id, revision: 1, responsibleUserId, parentContextId, cause: "monitor", correlationId: "dispatch" }).returning();
    const [run] = await db.update(heartbeatRuns).set({ activeIdentityContextId: context.id }).where(eq(heartbeatRuns.id, next.id)).returning();
    return run;
  }

  /** Runs in every provenance state, each with the decision that the GitHub
   * check of a separate call must make. The states are a GitHub request with
   * an inbound message link, its breaks, and the states of the tests above. */
  async function provenanceStates() {
    const states: Array<{ state: string; run: Run; github: string | null | { forbidden: string } }> = [];

    // A GitHub request: the accepted message has an inbound link to the
    // conversation of the task, on a GitHub endpoint.
    const linked = await seedGitHubReviewWait(db);
    states.push({ state: "linked request", run: linked.run, github: linked.commentId });
    states.push({ state: "the same run again", run: linked.run, github: linked.commentId });
    states.push({ state: "continuation of a linked request", github: linked.commentId,
      run: await continuation(linked.companyId, linked.agentId, linked.issueId, linked.activeIdentityContextId) });
    const [otherTask] = await db.insert(issues).values({ companyId: linked.companyId, title: "Other task", assigneeAgentId: linked.agentId }).returning();
    states.push({ state: "continuation on another task", github: { forbidden: FORBIDDEN.inherited },
      run: await continuation(linked.companyId, linked.agentId, otherTask.id, linked.activeIdentityContextId) });
    states.push({ state: "continuation by another requester", github: { forbidden: FORBIDDEN.changed },
      run: await continuation(linked.companyId, linked.agentId, linked.issueId, linked.activeIdentityContextId, "another-person") });
    states.push({ state: "run of another requester", github: { forbidden: FORBIDDEN.changed },
      run: { ...linked.run, responsibleUserId: "another-person" } });
    states.push({ state: "run of another company", github: { forbidden: FORBIDDEN.changed },
      run: { ...linked.run, companyId: (await seedGitHubReviewWait(db)).companyId } });
    states.push({ state: "no identity context", github: null,
      run: { ...linked.run, activeIdentityContextId: null, contextSnapshot: { wakeCommentId: linked.commentId } } });

    // A run of another company whose accepted message is the linked message
    // of the first company. The link, the conversation and the endpoint of
    // another company are never read for this run.
    const borrower = await seedGitHubReviewWait(db);
    await db.update(runIdentityContexts).set({ messageId: linked.commentId }).where(eq(runIdentityContexts.id, borrower.activeIdentityContextId));
    states.push({ state: "message linked in another company", run: borrower.run, github: { forbidden: FORBIDDEN.changed } });

    // A run of another task of the same company whose accepted message is
    // the linked message of the first task.
    const sibling = await seedGitHubReviewWait(db, { companyId: linked.companyId, agentId: linked.agentId });
    await db.update(runIdentityContexts).set({ messageId: linked.commentId }).where(eq(runIdentityContexts.id, sibling.activeIdentityContextId));
    states.push({ state: "message linked to another task", run: sibling.run, github: { forbidden: FORBIDDEN.otherTask } });

    const moved = await seedGitHubReviewWait(db);
    const [elsewhere] = await db.insert(issues).values({ companyId: moved.companyId, title: "Other task" }).returning();
    await db.update(chatConversations).set({ issueId: elsewhere.id }).where(eq(chatConversations.id, moved.conversationId));
    states.push({ state: "conversation moved to another task", run: moved.run, github: { forbidden: FORBIDDEN.otherTask } });

    const otherProvider = await seedGitHubReviewWait(db);
    await db.update(chatEndpoints).set({ provider: "slack" }).where(eq(chatEndpoints.id, otherProvider.endpointId));
    states.push({ state: "link of another provider", run: otherProvider.run, github: null });

    const rejected = await seedGitHubReviewWait(db);
    await db.update(runIdentityContexts).set({ status: "rejected" }).where(eq(runIdentityContexts.id, rejected.activeIdentityContextId));
    states.push({ state: "rejected identity context", run: rejected.run, github: { forbidden: FORBIDDEN.changed } });

    const reassigned = await seedGitHubReviewWait(db);
    await db.update(runIdentityContexts).set({ responsibleUserId: "another-person" }).where(eq(runIdentityContexts.id, reassigned.activeIdentityContextId));
    states.push({ state: "identity context of another requester", run: reassigned.run, github: { forbidden: FORBIDDEN.changed } });

    // Without an inbound link, the accepted message must be a board message
    // of the requester on the task of the run.
    const unlinked = async (change: (f: Seeded) => Promise<unknown>) => {
      const f = await seedGitHubReviewWait(db);
      await db.delete(chatMessageLinks).where(eq(chatMessageLinks.commentId, f.commentId));
      await change(f);
      return f.run;
    };
    const message = (f: Seeded, values: Partial<typeof issueComments.$inferInsert>) =>
      db.update(issueComments).set(values).where(eq(issueComments.id, f.commentId));
    states.push({ state: "missing link, board message of the requester", run: await unlinked(async () => {}), github: null });
    states.push({ state: "missing link, message of another person", github: { forbidden: FORBIDDEN.changed },
      run: await unlinked(f => message(f, { authorUserId: "another-person" })) });
    states.push({ state: "missing link, agent message", github: { forbidden: FORBIDDEN.changed },
      run: await unlinked(f => message(f, { authorType: "agent" })) });
    states.push({ state: "missing link, deleted message", github: { forbidden: FORBIDDEN.changed },
      run: await unlinked(f => message(f, { deletedAt: new Date() })) });
    states.push({ state: "missing link, message of another task", github: { forbidden: FORBIDDEN.changed },
      run: await unlinked(async f => {
        const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Other task" }).returning();
        await message(f, { issueId: other.id });
      }) });
    const outbound = await seedGitHubReviewWait(db);
    await db.update(chatMessageLinks).set({ direction: "outbound" }).where(eq(chatMessageLinks.commentId, outbound.commentId));
    states.push({ state: "outbound link only", run: outbound.run, github: null });

    // The states of the single-check tests above: a continuation whose
    // accepted message has no link and is not a board message.
    states.push({ state: "continuation of an unlinked message", run: (await fixture()).run, github: { forbidden: FORBIDDEN.changed } });
    for (const fault of ["task", "agent", "company", "requester", "missing-parent", "pending-parent", "pending-current", "cycle"]) {
      const f = await fixture();
      await breakInheritedAuthority(f, fault);
      states.push({ state: `${fault} break in inherited authority`, run: f.run, github: { forbidden:
        fault === "task" || fault === "agent" ? FORBIDDEN.inherited : fault === "cycle" ? FORBIDDEN.unverified : FORBIDDEN.changed } });
    }

    // A legacy wake comment, through a verified parent run of the same
    // requester, and after a board message of the same requester.
    const legacy = await fixture();
    await db.update(runIdentityContexts).set({ messageId: null }).where(eq(runIdentityContexts.id, legacy.origin.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: legacy.issue.id, wakeCommentId: legacy.messageId } }).where(eq(heartbeatRuns.id, legacy.source.id));
    states.push({ state: "legacy wake of a verified parent run", run: legacy.run, github: null });
    const board = await fixture();
    const [boardMessage] = await db.insert(issueComments).values({ companyId: board.company.id, issueId: board.issue.id, authorType: "user", authorUserId: "requester", body: "Continue" }).returning();
    await db.update(runIdentityContexts).set({ messageId: null }).where(eq(runIdentityContexts.id, board.origin.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: board.issue.id, wakeCommentId: board.messageId } }).where(eq(heartbeatRuns.id, board.source.id));
    await db.update(runIdentityContexts).set({ messageId: boardMessage.id }).where(eq(runIdentityContexts.id, board.context.id));
    const [boardRun] = await db.update(heartbeatRuns).set({ contextSnapshot: { wakeCommentId: boardMessage.id } }).where(eq(heartbeatRuns.id, board.run.id)).returning();
    states.push({ state: "legacy wake after a board message of the requester", run: boardRun, github: null });
    const later = await fixture();
    const [laterMessage] = await db.insert(issueComments).values({ companyId: later.company.id, issueId: later.issue.id, authorType: "user", authorUserId: "new-requester", body: "Continue" }).returning();
    await db.update(runIdentityContexts).set({ messageId: laterMessage.id, responsibleUserId: "new-requester" }).where(eq(runIdentityContexts.id, later.context.id));
    const [laterRun] = await db.update(heartbeatRuns).set({ responsibleUserId: "new-requester", contextSnapshot: { wakeCommentId: later.messageId } }).where(eq(heartbeatRuns.id, later.run.id)).returning();
    states.push({ state: "board message of a new requester", run: laterRun, github: null });

    // A long lineage: the request is twelve continuations back.
    let deep = linked.run;
    for (let depth = 0; depth < 12; depth++) deep = await continuation(linked.companyId, linked.agentId, linked.issueId, deep.activeIdentityContextId!);
    states.push({ state: "long lineage of a linked request", run: deep, github: linked.commentId });
    return states;
  }

  it("gives every run of a batch the decision of its own check, in every provenance state", async () => {
    const states = await provenanceStates();
    const runs = states.map(state => state.run);
    // The GitHub decision of each state is the documented one.
    const github: Array<Awaited<ReturnType<typeof singleDecision>>> = [];
    for (const run of runs) github.push(await singleDecision(run, { provider: "github" }));
    expect(Object.fromEntries(states.map((state, index) => [state.state, github[index]]))).toEqual(
      Object.fromEntries(states.map(state => [state.state, state.github !== null && typeof state.github === "object"
        ? { status: 403, message: state.github.forbidden } : { messageId: state.github }])));
    for (const options of optionSets) {
      const single: Array<Awaited<ReturnType<typeof singleDecision>>> = [];
      for (const run of runs) single.push(await singleDecision(run, options));
      // Every state is decided in one batch, beside every other state.
      expect(await batchDecisions(runs, options)).toEqual(single);
      // The decision of a run does not depend on its position or on its neighbors.
      expect((await batchDecisions([...runs].reverse(), options)).reverse()).toEqual(single);
      for (const [index, run] of runs.entries()) expect(await batchDecisions([run], options)).toEqual([single[index]]);
    }
    // The legacy wake is returned only when the caller allows it.
    const legacyWake = states.findIndex(state => state.state === "legacy wake of a verified parent run");
    expect((await batchDecisions(runs, { provider: "github", allowLegacyWakeComment: true }))[legacyWake])
      .toEqual({ messageId: expect.any(String) });
    expect(await chatRunSourceMessageIds(db, [])).toEqual([]);
  }, 120_000);

  it("checks the runs of a batch with statements that follow the lineage, not the number of runs", async () => {
    const first = await seedGitHubReviewWait(db);
    const few = [first.run], many = [first.run];
    for (let wait = 1; wait < 40; wait++) {
      const { run } = await seedGitHubReviewWait(db, { companyId: first.companyId, agentId: first.agentId });
      many.push(run);
      if (wait < 4) few.push(run);
    }
    const options = { provider: "github" as const };
    const batchOfFew = await countStatements(() => chatRunSourceMessageIds(db, few, options));
    const batchOfMany = await countStatements(() => chatRunSourceMessageIds(db, many, options));
    // One identity-context read and one message-link read for the whole batch.
    expect(batchOfFew.statements).toBe(2);
    expect(batchOfMany.statements).toBe(2);
    expect(new Set(batchOfMany.result.map(result => "messageId" in result ? result.messageId : null)).size).toBe(many.length);
    // Separate checks send both reads for every run.
    const separate = await countStatements(() => Promise.all(many.map(run => chatRunSourceMessageId(db, run, options))));
    expect(separate.statements).toBe(2 * many.length);
    expect(batchOfMany.result).toEqual(separate.result.map(messageId => ({ messageId })));

    // One continuation in every lineage adds the two reads of that step to
    // the batch, not two reads for every run.
    const continued: Run[] = [];
    for (const run of many) continued.push(await continuation(first.companyId, first.agentId, run.nativeIssueId!, run.activeIdentityContextId!));
    const batchOfContinued = await countStatements(() => chatRunSourceMessageIds(db, continued, options));
    expect(batchOfContinued.statements).toBe(4);
    expect(batchOfContinued.result).toEqual(batchOfMany.result);
  }, 120_000);

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

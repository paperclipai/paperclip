import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { ANTIGRAVITY_SWARM_REQUESTED_ACTION, recordAntigravitySwarmRequest, resolveAntigravitySwarmRun } from "./antigravity-swarm.js";
import { instanceSettingsService } from "./instance-settings.js";

const support = await getEmbeddedPostgresTestSupport();
const USER = "swarm-user";

describe.skipIf(!support.supported)("trusted /swarm run selection (database)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-antigravity-swarm-");
    db = createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAntigravitySwarm: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(options: { author?: "user" | "agent"; record?: "match" | "none" | "other-actor" | "other-comment" } = {}) {
    const [company] = await db.insert(companies).values({ name: "Swarm", issuePrefix: `S${randomUUID().slice(0, 4)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Gemma", adapterType: "paperclip_runner",
      adapterConfig: { provider: "acpx", acpxAgent: "antigravity", model: "gemini-3.8-flash-low" } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "Swarm", status: "todo", assigneeAgentId: agent!.id }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId: company!.id, issueId: issue!.id,
      ...(options.author === "agent" ? { authorType: "agent", authorAgentId: agent!.id } : { authorType: "user", authorUserId: USER }), body: "two helpers" }).returning();
    const record = options.record ?? "match";
    if (record !== "none") {
      await recordAntigravitySwarmRequest(db, { companyId: company!.id, issueId: issue!.id,
        commentId: record === "other-comment" ? randomUUID() : comment!.id, userId: record === "other-actor" ? "someone-else" : USER });
    }
    return { company: company!, agent: agent!, issue: issue!, comment: comment! };
  }
  const resolve = (f: Awaited<ReturnType<typeof seed>>, overrides: Partial<Parameters<typeof resolveAntigravitySwarmRun>[1]> = {}) =>
    resolveAntigravitySwarmRun(db, { companyId: f.company.id, issueId: f.issue.id, runId: randomUUID(), agent: f.agent,
      context: { antigravitySwarmCommentId: f.comment.id }, remote: false, planning: false, ...overrides });

  it("selects the swarm for the user's recorded request and logs that it started", async () => {
    const f = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running", runtimeMode: "native",
      runtimeModeResolvedAt: new Date(), nativeIssueId: f.issue.id, responsibleUserId: USER, startedAt: new Date(), contextSnapshot: { issueId: f.issue.id } }).returning();
    expect(await resolve(f, { runId: run!.id })).toBe(true);
    const started = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issue.id), eq(activityLog.action, "issue.antigravity_swarm_started")));
    expect(started).toHaveLength(1);
    expect(String((started[0]!.details as Record<string, unknown>).summary)).toMatch(/does not sandbox the helpers/);
  });

  it.each([
    ["no recorded request", { record: "none" as const }],
    ["a record by another actor", { record: "other-actor" as const }],
    ["a record for another comment", { record: "other-comment" as const }],
    ["an agent-authored comment", { author: "agent" as const }],
  ])("never selects the swarm for %s", async (_name, options) => {
    expect(await resolve(await seed(options))).toBe(false);
  });

  it("never selects the swarm for a comment an agent wrote on a user's behalf", async () => {
    const f = await seed();
    await db.update(issueComments).set({ authorAgentId: f.agent.id }).where(eq(issueComments.id, f.comment.id));
    expect(await resolve(f)).toBe(false);
  });

  it("never selects the swarm for another task's comment, even with a record on this task", async () => {
    const f = await seed();
    const [otherIssue] = await db.insert(issues).values({ companyId: f.company.id, title: "Other", status: "todo", assigneeAgentId: f.agent.id }).returning();
    const [otherComment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: otherIssue!.id, authorType: "user", authorUserId: USER, body: "x" }).returning();
    await recordAntigravitySwarmRequest(db, { companyId: f.company.id, issueId: f.issue.id, commentId: otherComment!.id, userId: USER });
    expect(await resolve(f, { context: { antigravitySwarmCommentId: otherComment!.id } })).toBe(false);
  });

  it("never borrows a marker from another task or company", async () => {
    const f = await seed();
    const other = await seed();
    expect(await resolve(f, { context: { antigravitySwarmCommentId: other.comment.id } })).toBe(false);
    expect(await resolve(other, { companyId: f.company.id })).toBe(false);
  });

  it("treats a recovery or retry of a swarm run as the same swarm request, never as ordinary work", async () => {
    const f = await seed();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "failed", runtimeMode: "native",
      nativeIssueId: f.issue.id, responsibleUserId: USER, contextSnapshot: { issueId: f.issue.id, antigravitySwarmCommentId: f.comment.id } }).returning();
    const [retry] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running", runtimeMode: "native",
      nativeIssueId: f.issue.id, responsibleUserId: USER, contextSnapshot: { issueId: f.issue.id, retryOfRunId: source!.id } }).returning();
    // A recovery wake carries only the retry link (wakeReason issue_recovery_action_restored), not the marker.
    expect(await resolve(f, { runId: retry!.id, context: { issueId: f.issue.id, retryOfRunId: source!.id, wakeReason: "issue_recovery_action_restored" } })).toBe(true);
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, retry!.id));
    const [second] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running", runtimeMode: "native",
      nativeIssueId: f.issue.id, responsibleUserId: USER, contextSnapshot: { issueId: f.issue.id, retryOfRunId: retry!.id } }).returning();
    expect(await resolve(f, { runId: second!.id, context: { issueId: f.issue.id, retryOfRunId: retry!.id } })).toBe(true);
    // A retry chain from another task never borrows its swarm request.
    const other = await seed({ record: "none" });
    expect(await resolve(other, { context: { retryOfRunId: source!.id } })).toBe(false);
  });

  async function insertRun(f: Awaited<ReturnType<typeof seed>>, values: Record<string, unknown>) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running", runtimeMode: "native",
      nativeIssueId: f.issue.id, responsibleUserId: USER, contextSnapshot: { issueId: f.issue.id }, ...values } as never).returning();
    return run!;
  }

  it("inherits the swarm request through a retry link stored only on the run row", async () => {
    const f = await seed();
    const source = await insertRun(f, { status: "failed", contextSnapshot: { issueId: f.issue.id, antigravitySwarmCommentId: f.comment.id } });
    const retry = await insertRun(f, { retryOfRunId: source.id });
    expect(await resolve(f, { runId: retry.id, context: { issueId: f.issue.id, wakeReason: "issue_recovery_action_restored" } })).toBe(true);
  });

  it.each(["issue_blocker_stalled", "issue_assigned", "issue_continuation_needed"])(
    "runs a %s wake as the swarm while the user's latest message is an unfulfilled swarm request", async wakeReason => {
      const f = await seed();
      const run = await insertRun(f, {});
      expect(await resolve(f, { runId: run.id, context: { issueId: f.issue.id, wakeReason } })).toBe(true);
    });

  it("runs ordinary work once the swarm succeeded, or after a newer ordinary message", async () => {
    const f = await seed();
    await insertRun(f, { status: "succeeded", contextSnapshot: { issueId: f.issue.id, antigravitySwarmCommentId: f.comment.id } });
    expect(await resolve(f, { context: { issueId: f.issue.id, wakeReason: "issue_assigned" } })).toBe(false);
    const g = await seed();
    await db.insert(issueComments).values({ companyId: g.company.id, issueId: g.issue.id, authorType: "user", authorUserId: USER, body: "thanks", createdAt: new Date(Date.now() + 1000) });
    expect(await resolve(g, { context: { issueId: g.issue.id, wakeReason: "issue_commented" } })).toBe(false);
  });

  const setStatus = (id: string, status: string) => db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, id));
  const automatic = (f: Awaited<ReturnType<typeof seed>>, runId: string, wakeReason = "issue_assigned") =>
    resolve(f, { runId, context: { issueId: f.issue.id, wakeReason } });

  it("records the request on the run it selects, so a fallback-selected swarm that succeeded is not run again", async () => {
    const f = await seed();
    const first = await insertRun(f, {});
    expect(await automatic(f, first.id)).toBe(true);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.id)))[0]!.contextSnapshot).toMatchObject({ antigravitySwarmCommentId: f.comment.id });
    await setStatus(first.id, "succeeded");
    expect(await automatic(f, (await insertRun(f, {})).id, "issue_blocker_stalled")).toBe(false);
  });

  it("does not run a swarm again after a retried swarm succeeded", async () => {
    const f = await seed();
    const failed = await insertRun(f, {});
    expect(await resolve(f, { runId: failed.id })).toBe(true);
    await setStatus(failed.id, "failed");
    const retry = await insertRun(f, { retryOfRunId: failed.id });
    expect(await resolve(f, { runId: retry.id, context: { issueId: f.issue.id, wakeReason: "issue_recovery_action_restored" } })).toBe(true);
    await setStatus(retry.id, "succeeded");
    expect(await automatic(f, (await insertRun(f, {})).id, "issue_continuation_needed")).toBe(false);
  });

  it("keeps a failed swarm pending, and refuses plainly after three failed attempts", async () => {
    const f = await seed();
    for (let attempt = 0; attempt < 3; attempt++) {
      const run = await insertRun(f, {});
      expect(await automatic(f, run.id)).toBe(true);
      await setStatus(run.id, "failed");
    }
    await expect(automatic(f, (await insertRun(f, {})).id)).rejects.toMatchObject({ code: "antigravity_swarm_unavailable", message: expect.stringMatching(/three attempts/) });
  });

  it("starts exactly one swarm for one request when two wakes arrive together", async () => {
    const f = await seed();
    const [a, b] = [await insertRun(f, {}), await insertRun(f, {})];
    const results = await Promise.allSettled([automatic(f, a.id), automatic(f, b.id)]);
    expect(results.filter(result => result.status === "fulfilled" && result.value === true)).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });

  it("after Stop, automatic wakes refuse plainly and a manual Retry runs the swarm again", async () => {
    const f = await seed();
    const stopped = await insertRun(f, {});
    expect(await automatic(f, stopped.id)).toBe(true);
    await setStatus(stopped.id, "cancelled");
    await expect(automatic(f, (await insertRun(f, {})).id, "issue_blocker_stalled")).rejects.toMatchObject({ message: expect.stringMatching(/stopped/) });
    // resumeTaskRetry's wake: reason task_retry, context { issueId, triggeredBy, actorId, responsibleUserId }, no marker or retry link.
    const retry = await insertRun(f, {});
    expect(await resolve(f, { runId: retry.id, context: { issueId: f.issue.id, triggeredBy: "board", actorId: USER, responsibleUserId: USER, wakeReason: "task_retry" } })).toBe(true);
  });

  it.each([
    ["a remote environment", { remote: true }, /this computer/],
    ["Plan mode", { planning: true }, /Plan mode/],
  ])("refuses in plain language in %s instead of running an ordinary request", async (_name, overrides, message) => {
    await expect(resolve(await seed(), overrides)).rejects.toMatchObject({ code: "antigravity_swarm_unavailable", message: expect.stringMatching(message) });
  });

  it("refuses when the flag is off", async () => {
    const f = await seed();
    await instanceSettingsService(db).updateExperimental({ enableAntigravitySwarm: false });
    try {
      await expect(resolve(f)).rejects.toMatchObject({ code: "antigravity_swarm_unavailable", message: expect.stringMatching(/not turned on/) });
    } finally {
      await instanceSettingsService(db).updateExperimental({ enableAntigravitySwarm: true });
    }
    expect((await db.select().from(activityLog).where(eq(activityLog.action, ANTIGRAVITY_SWARM_REQUESTED_ACTION))).length).toBeGreaterThan(0);
  });
});

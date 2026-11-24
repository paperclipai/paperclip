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

  it("ignores a wake without the marker, and a marker from another task or company", async () => {
    const f = await seed();
    expect(await resolve(f, { context: { commentId: f.comment.id, wakeCommentId: f.comment.id } })).toBe(false);
    const other = await seed();
    expect(await resolve(f, { context: { antigravitySwarmCommentId: other.comment.id } })).toBe(false);
    expect(await resolve(other, { companyId: f.company.id })).toBe(false);
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

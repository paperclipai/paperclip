import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, heartbeatRuns, issues, issueRecoveryActions,
  issueThreadInteractions, routines, routineTriggers,
  toolApplications, toolConnections,
} from "@paperclipai/db";
import { readIdleSleepSafety, type IdleSleepDrainStatus } from "../services/idle-sleep-safety.js";
import { getMergeConfirmationPullRequestReferences } from "../services/issue-thread-interactions.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const now = Date.UTC(2020, 0, 1);
const ownerId = randomUUID();
const owned = (): IdleSleepDrainStatus => ({ ownerId, draining: true, startedAt: new Date(now - 1000),
  expiresAt: new Date(now + 60_000), activeRuns: 0, pendingWakes: 0 });
const none = { version: 1, backgroundWork: "none" };
const present = { version: 1, backgroundWork: "present" };
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping response-wait database tests: ${support.reason}`);
(support.supported ? describe : describe.skip)("idle response-driven waits", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("idle-response-waits-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE companies, plugins, environments CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  const read = (schedules = true) => readIdleSleepSafety(db, owned, () => now, ownerId,
    async () => "none", undefined, undefined, schedules, schedules);

  async function seed(status = "in_review") {
    const companyId = randomUUID(); const agentId = randomUUID(); const runId = randomUUID(); const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Response fixture", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Idle owner", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Awaiting a response", status, assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand",
      status: "succeeded", finishedAt: new Date(now), contextSnapshot: { issueId } });
    return { companyId, agentId, runId, issueId };
  }
  async function wait(f: Awaited<ReturnType<typeof seed>>, change: Partial<typeof issueThreadInteractions.$inferInsert> = {}) {
    const [row] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "pending", sourceRunId: f.runId, effectiveResolverPolicy: "human_only",
      continuationPolicy: "wake_assignee", payload: { version: 1 }, ...change }).returning();
    return row!;
  }

  it.each(["anyone", "not_creator", "human_only"] as const)("preserves the %s response audience while permitting an idle wait", async policy => {
    const f = await seed(); const card = await wait(f, { effectiveResolverPolicy: policy });
    expect(await read(false)).toEqual(present);
    expect(await read()).toEqual(none);
    expect(await db.select().from(issueThreadInteractions)).toEqual([card]);
    expect((await db.select().from(issues))[0]?.status).toBe("in_review");
  });
  it.each(["ask_user_questions", "request_confirmation", "request_checkbox_confirmation", "suggest_tasks"])(
    "permits a persisted %s wait after its producer finishes", async kind => {
      await wait(await seed("in_progress"), { kind });
      expect(await read()).toEqual(none);
    });
  it.each(["human_only", "anyone"])("keeps automatically polled merge confirmations awake with %s audience", async policy => {
    const f = await seed("in_progress");
    const card = { kind: "request_confirmation", title: "Merge PaperclipAI/paperclip#39?", summary: null,
      payload: { version: 1, prompt: "Merge the pull request?" } };
    expect(getMergeConfirmationPullRequestReferences(card)).toHaveLength(1);
    await wait(f, { ...card, effectiveResolverPolicy: policy });
    expect(await read()).toEqual(present);
  });
  it("does not treat an assigned task or an answered interaction as a passive wait", async () => {
    const f = await seed(); expect(await read()).toEqual(present);
    const card = await wait(f); expect(await read()).toEqual(none);
    await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: new Date(now) }).where(eq(issueThreadInteractions.id, card.id));
    expect(await read()).toEqual(present);
  });
  it("allows human-only connection setup without reusable access, and reblocks when access appears", async () => {
    const f = await seed();
    await wait(f, { kind: "connection_intent", addresseeUserId: "fixture-user", payload: {
      version: 1, serviceSlug: "fixture-service", requestingAgentId: f.agentId,
    } });
    expect(await read()).toEqual(none);
    const [app] = await db.insert(toolApplications).values({ companyId: f.companyId,
      type: "mcp_http", name: "Fixture service" }).returning();
    await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: app!.id,
      uid: randomUUID(), name: "Reusable access", connectionPurpose: "tool", transport: "mcp_remote", status: "active", enabled: true });
    expect(await read()).toEqual(present);
  });
  it.each(["wrong_assignee", "unknown_purpose", "no_addressee", "agent_resolver"])("retains unsafe connection wait: %s", async mode => {
    const f = await seed();
    await wait(f, { kind: "connection_intent", addresseeUserId: mode === "no_addressee" ? null : "fixture-user",
      effectiveResolverPolicy: mode === "agent_resolver" ? "anyone" : "human_only", payload: {
        version: 1, serviceSlug: "fixture-service", requestingAgentId: mode === "wrong_assignee" ? randomUUID() : f.agentId,
        ...(mode === "unknown_purpose" ? { purpose: "future" } : {}),
      } });
    expect(await read()).toEqual(present);
  });
  it.each([
    { kind: "connection_intent" }, { kind: "unknown" }, { continuationPolicy: "automatic" },
    { effectiveResolverPolicy: "unknown" }, { resolvedAt: new Date(now) },
  ])("keeps unsupported waiting work awake: %j", async change => {
    const f = await seed(); await wait(f); await wait(f, change);
    expect(await read()).toEqual(present);
  });
  it("does not borrow another company's interaction or ignore a foreign pending sibling", async () => {
    const f = await seed(); const other = await seed("done");
    await wait(f, { companyId: other.companyId, sourceRunId: other.runId });
    expect(await read()).toEqual(present);
    await wait(f); expect(await read()).toEqual(present);
  });
  it.each([
    { status: "running", finishedAt: null }, { finishedAt: null }, { costAccountingPending: true },
    { scheduledRetryAt: new Date(now + 1000) },
  ])("keeps a response producer's unfinished work awake: %j", async change => {
    const f = await seed(); await wait(f);
    await db.update(heartbeatRuns).set(change).where(eq(heartbeatRuns.id, f.runId));
    expect(await read()).toEqual(present);
  });
  it.each([
    { checkoutRunId: randomUUID() }, { executionRunId: randomUUID() },
    { executionState: { status: "pending" } }, { monitorWakeRequestedAt: new Date(now) },
  ])("does not let a response card hide issue execution: %j", async change => {
    const f = await seed(); await wait(f);
    // Checkout and execution fields reference real run rows.
    const patch = { ...change };
    if ("checkoutRunId" in patch) patch.checkoutRunId = f.runId;
    if ("executionRunId" in patch) patch.executionRunId = f.runId;
    await db.update(issues).set(patch).where(eq(issues.id, f.issueId));
    expect(await read()).toEqual(present);
  });
  it("includes response identity and audience in the future schedule generation", async () => {
    const f = await seed(); const card = await wait(f);
    const [routine] = await db.insert(routines).values({ companyId: f.companyId, title: "Later work", status: "active", assigneeAgentId: f.agentId }).returning();
    await db.insert(routineTriggers).values({ companyId: f.companyId, routineId: routine!.id, kind: "schedule",
      cronExpression: "*/15 * * * *", timezone: "UTC", nextRunAt: new Date(now + 600_000), enabled: true, setupPending: false });
    const before = await read(); expect(before.version).toBe(2);
    await db.update(issueThreadInteractions).set({ effectiveResolverPolicy: "anyone" }).where(eq(issueThreadInteractions.id, card.id));
    const after = await read(); expect(after.scheduledWake?.nextWakeAt).toBe(before.scheduledWake?.nextWakeAt);
    expect(after.scheduledWake?.generation).not.toBe(before.scheduledWake?.generation);
  });

  async function boardHold(f: Awaited<ReturnType<typeof seed>>, change: Partial<typeof issueRecoveryActions.$inferInsert> = {}) {
    const [row] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "stranded_assigned_issue", cause: "stranded_assigned_issue", status: "active", ownerType: "board",
      fingerprint: randomUUID(), nextAction: "Board decision required", wakePolicy: { type: "board_escalation", reason: "stranded_assigned_issue", preservesSourceAssignee: true },
      ...change }).returning();
    return row!;
  }
  it.each(["active", "escalated"])("retains visible %s board escalation history without keeping compute running", async status => {
    const f = await seed("blocked"); const action = await boardHold(f, { status });
    expect(await read()).toEqual(none);
    expect(await db.select().from(issueRecoveryActions)).toEqual([action]);
  });
  it.each([
    { ownerType: "agent" }, { ownerType: "system" }, { cause: "native_workspace_finalization_owner_unverified" },
    { timeoutAt: new Date(now + 60_000) }, { monitorPolicy: {} },
    { wakePolicy: { type: "wake_owner" } }, { wakePolicy: { type: "board_escalation", retryAt: "2099-01-01" } },
    { wakePolicy: null }, { resolvedAt: new Date(now) },
  ])("keeps automatic or unproved recovery work awake: %j", async change => {
    await boardHold(await seed("blocked"), change);
    expect(await read()).toEqual(present);
  });
  it("rejects a foreign recovery source and an escalation whose source still runs", async () => {
    const f = await seed("blocked"); const other = await seed("done");
    const action = await boardHold(f, { companyId: other.companyId });
    expect(await read()).toEqual(present);
    await db.update(issueRecoveryActions).set({ companyId: f.companyId }).where(eq(issueRecoveryActions.id, action.id));
    expect(await read()).toEqual(none);
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    expect(await read()).toEqual(present);
  });
});

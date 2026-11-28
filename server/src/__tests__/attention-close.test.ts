import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  decisions,
  heartbeatRuns,
  inboxDismissals,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { attentionRoutes } from "../routes/attention.js";
import { approvalRoutes } from "../routes/approvals.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { attentionCloseModes, attentionService } from "../services/attention.js";
import { decisionHistoryService, interactionHistoryLabel } from "../services/decision-history.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention close tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("attentionCloseModes (PAP-749 task 2b)", () => {
  it("offers withdraw only where the source has a real withdraw or cancel", () => {
    const none = { metadata: undefined };
    expect(attentionCloseModes("issue_thread_interaction", none)).toEqual(["withdraw", "archive", "snooze"]);
    expect(attentionCloseModes("decision", none)).toEqual(["withdraw", "archive", "snooze"]);
    expect(attentionCloseModes("approval", { metadata: { type: "request_board_approval" } })).toEqual(["withdraw", "archive", "snooze"]);
    expect(attentionCloseModes("approval", { metadata: { type: "hire_agent" } })).toEqual(["archive", "snooze"]);
    for (const kind of ["budget_alert", "recovery_action", "failed_run", "agent_error_alert", "review", "blocker_attention", "join_request"] as const) {
      expect(attentionCloseModes(kind, none)).toEqual(["archive", "snooze"]);
    }
    expect(attentionCloseModes("productivity_review", none)).toEqual([]);
  });

  it("labels withdrawn, skipped and task-closed history rows by their result outcome", () => {
    const row = (result: unknown, resolvedByUserId: string | null = null, status = "cancelled") =>
      interactionHistoryLabel({ kind: "request_confirmation", status, result, resolvedByUserId });
    expect(row({ outcome: "withdrawn" }, "scott")).toBe("Withdrawn by user");
    expect(row({ outcome: "withdrawn" })).toBe("Withdrawn");
    expect(row({ outcome: "skipped" }, "scott")).toBe("Skipped");
    expect(row({ outcome: "issue_closed" }, null, "expired")).toBe("Closed with task");
    expect(row(null, null, "accepted")).toBe("Approved");
  });
});

// PAP-749 task 2b: one close API. Withdraw closes the request for everyone and
// tells the agent; archive and snooze hide it for one person; transfer routes it
// to another person. Each returns 400/403/404/409/422 consistently.
describeEmbeddedPostgres("attention close, transfer and approval cancel (PAP-749 task 2b)", () => {
  const SCOTT = "scott";
  const DOTTA = "dotta";
  const RILEY = "riley";

  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-close-");
    db = createDb(externalUrl ?? tempDb!.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  let seq = 0;
  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `${prefix} Co`, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: workerId, companyId, name: "Worker", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    for (const userId of [SCOTT, DOTTA, RILEY]) {
      await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}-${randomUUID()}@example.test`, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "admin" });
    }
    return { companyId, workerId };
  }

  async function insertIssue(companyId: string, input: { status?: string; createdByUserId?: string | null; conversation?: { agentId: string; userId: string } } = {}) {
    const id = randomUUID();
    seq += 1;
    await db.insert(issues).values({
      id, companyId, identifier: `${seq}`, title: `Issue ${seq}`, status: input.status ?? "todo", priority: "medium",
      createdByUserId: input.createdByUserId ?? null, originKind: "manual", originFingerprint: `fp-${seq}`,
      conversationAgentId: input.conversation?.agentId ?? null, conversationUserId: input.conversation?.userId ?? null,
      conversationState: input.conversation ? "active" : null, assigneeAgentId: input.conversation?.agentId ?? null,
    });
    return id;
  }

  const PAYLOADS: Record<string, Record<string, unknown>> = {
    request_confirmation: { version: 1, prompt: "Approve this plan?" },
    ask_user_questions: { version: 1, questions: [{ id: "scope", prompt: "Which scope?", selectionMode: "single", options: [{ id: "a", label: "A" }] }] },
    suggest_tasks: { version: 1, tasks: [{ clientKey: "a", title: "Do a thing" }] },
    request_checkbox_confirmation: { version: 1, prompt: "Pick files", options: [{ id: "a", label: "A" }] },
    request_item_verdicts: { version: 1, prompt: "Review items", items: [{ id: "a", label: "A" }], verdicts: ["approve", "reject"] },
  };

  async function insertInteraction(companyId: string, issueId: string, workerId: string, input: { kind?: string; addresseeUserId?: string | null } = {}) {
    const id = randomUUID();
    const kind = input.kind ?? "request_confirmation";
    await db.insert(issueThreadInteractions).values({
      id, companyId, issueId, kind, status: "pending", title: `A ${kind}`, createdByAgentId: workerId,
      addresseeUserId: input.addresseeUserId ?? null, payload: PAYLOADS[kind] as never,
    });
    return id;
  }

  async function insertDecision(companyId: string, workerId: string, originIssueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: workerId, status: "succeeded", contextSnapshot: { issueId: originIssueId } });
    const id = randomUUID();
    await db.insert(decisions).values({
      id, companyId, originAgentId: workerId, originIssueId, originRunId: runId, title: "Pick a vendor", body: "Pick one",
      options: [], status: "open", expiresAt: new Date(Date.now() + 86_400_000), signedSpec: "test", targetSnapshots: {},
    });
    return id;
  }

  const board = (companyId: string, userId: string, extra: Record<string, unknown> = {}) =>
    ({ type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false, ...extra });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", attentionRoutes(db));
    testApp.use("/api", approvalRoutes(db));
    testApp.use(errorHandler);
    return testApp;
  }

  const closeUrl = (companyId: string, kind: string, id: string) => `/api/companies/${companyId}/attention/${kind}/${id}/close`;
  const transferUrl = (companyId: string, kind: string, id: string) => `/api/companies/${companyId}/attention/${kind}/${id}/transfer`;
  const activity = (companyId: string, action: string) =>
    db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));

  it("withdraws every interaction kind for a board user, never as consent, and logs both entries", async () => {
    const { companyId, workerId } = await seedCompany("CLW");
    const issueId = await insertIssue(companyId, { createdByUserId: DOTTA });
    const scott = app(board(companyId, SCOTT));

    for (const kind of Object.keys(PAYLOADS)) {
      const interactionId = await insertInteraction(companyId, issueId, workerId, { kind });
      const response = await request(scott).post(closeUrl(companyId, "issue_thread_interaction", interactionId))
        .send({ mode: "withdraw", reason: "Out of date" });
      expect(response.status, `${kind}: ${JSON.stringify(response.body)}`).toBe(200);
      expect(response.body).toEqual({
        sourceKind: "issue_thread_interaction", sourceId: interactionId, mode: "withdraw", closedByUserId: SCOTT, issueId, until: null,
      });
      const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
      expect(row).toMatchObject({ status: "cancelled", resolvedByUserId: SCOTT });
      expect(row?.result).toMatchObject({ outcome: "withdrawn", reason: "Out of date" });
    }

    expect(await activity(companyId, "issue.thread_interaction_withdrawn")).toHaveLength(5);
    const closed = await activity(companyId, "attention.closed");
    expect(closed).toHaveLength(5);
    expect(closed[0]).toMatchObject({ actorType: "user", actorId: SCOTT, entityType: "issue", entityId: issueId });
    expect(closed[0]?.details).toMatchObject({ sourceKind: "issue_thread_interaction", mode: "withdraw", reason: "Out of date", closedByUserId: SCOTT });

    // Decision history names the withdrawal, who did it and why.
    const history = await decisionHistoryService(db).list(companyId, {
      actor: board(companyId, SCOTT) as never, userId: SCOTT, outcome: "withdrawn_by_user",
    });
    expect(history.items).toHaveLength(5);
    expect(history.items[0]).toMatchObject({ label: "Withdrawn by user", reason: "Out of date", resolvedByUserId: SCOTT });
  });

  it("keeps personally hidden content out of feed, summary, and task membership", async () => {
    const { companyId, workerId } = await seedCompany("HID");
    const issueId = await insertIssue(companyId, { createdByUserId: SCOTT });
    const interactionId = await insertInteraction(companyId, issueId, workerId);
    const decisionId = await insertDecision(companyId, workerId, issueId);
    const approvalId = randomUUID();
    await db.insert(approvals).values({ id: approvalId, companyId, type: "request_board_approval", requestedByUserId: SCOTT, payload: { title: "Ship", details: "Important proposal" } });
    const svc = attentionService(db);
    const actor = board(companyId, SCOTT) as never;
    const before = await svc.list(companyId, { userId: SCOTT, actor, all: true, allowUnscopedAll: true });
    expect(new Set(before.items.map(item => item.subject.id))).toEqual(new Set([interactionId, decisionId, approvalId]));
    for (const item of before.items) {
      await svc.hideForUser(companyId, { sourceKind: item.sourceKind, sourceId: item.subject.id, userId: SCOTT, actor,
        mode: item.sourceKind === "decision" ? "snooze" : "archive", until: new Date(Date.now() + 86_400_000).toISOString(), fingerprint: item.changeFingerprint });
    }
    expect((await svc.list(companyId, { userId: SCOTT, actor })).items).toEqual([]);
    expect(await svc.summary(companyId, { userId: SCOTT, actor })).toMatchObject({ totalCount: 0, deskBadgeCount: 0, viewCounts: { mine: 0, archived: 3 } });
    expect(await svc.taskIndex(companyId, { userId: SCOTT, actor })).toMatchObject({ totalCount: 0, taskIds: [] });
  });

  it.each(["instigator", "assignee", "conversation", "default"])("does not claim work already routed by %s", async (owner) => {
    const { companyId, workerId } = await seedCompany("OWN");
    const issueId = await insertIssue(companyId, owner === "instigator" ? { createdByUserId: DOTTA } : {});
    if (owner === "assignee") await db.update(issues).set({ assigneeUserId: DOTTA }).where(eq(issues.id, issueId));
    if (owner === "conversation") await db.update(issues).set({ conversationAgentId: workerId, conversationUserId: DOTTA, conversationState: "active", assigneeAgentId: workerId, createdByUserId: DOTTA }).where(eq(issues.id, issueId));
    if (owner === "default") await db.update(companies).set({ defaultDecisionOwnerUserId: DOTTA }).where(eq(companies.id, companyId));
    const sourceId = await insertInteraction(companyId, issueId, workerId);
    await expect(attentionService(db).claim(companyId, { sourceKind: "issue_thread_interaction", sourceId, userId: RILEY, actor: board(companyId, RILEY) as never })).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, sourceId)))[0]?.addresseeUserId).toBeNull();
  });

  it("rejects a transfer to a person who cannot read the task", async () => {
    const { companyId, workerId } = await seedCompany("PRI");
    const issueId = await insertIssue(companyId, { createdByUserId: SCOTT });
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, issueId));
    const sourceId = await insertInteraction(companyId, issueId, workerId, { addresseeUserId: SCOTT });
    const previous = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    try {
      await request(app(board(companyId, SCOTT))).post(transferUrl(companyId, "issue_thread_interaction", sourceId)).send({ userId: DOTTA }).expect(422);
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, sourceId)))[0]?.addresseeUserId).toBe(SCOTT);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
      else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previous;
    }
  });

  it("enforces the review requester rule when withdrawing through attention", async () => {
    const { companyId, workerId } = await seedCompany("GOV");
    const issueId = await insertIssue(companyId, { status: "in_review", createdByUserId: SCOTT });
    await db.update(issues).set({ reviewPolicy: "not_creator" }).where(eq(issues.id, issueId));
    const sourceId = await insertInteraction(companyId, issueId, workerId);
    await db.update(issueThreadInteractions).set({ createdByAgentId: null, createdByUserId: SCOTT }).where(eq(issueThreadInteractions.id, sourceId));
    const url = closeUrl(companyId, "issue_thread_interaction", sourceId);
    const denied = await request(app(board(companyId, SCOTT))).post(url).send({ mode: "withdraw" }).expect(403);
    expect(denied.body.details.code).toBe("review_policy_denied");
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, sourceId)))[0]?.status).toBe("pending");
    await request(app(board(companyId, DOTTA))).post(url).send({ mode: "withdraw" }).expect(200);
  });

  it("returns the recorded outcome when the original addressee claims a closed request", async () => {
    const { companyId, workerId } = await seedCompany("RAC");
    const issueId = await insertIssue(companyId);
    const sourceId = await insertInteraction(companyId, issueId, workerId, { addresseeUserId: SCOTT });
    const boardApp = app(board(companyId, SCOTT));
    await request(boardApp).post(closeUrl(companyId, "issue_thread_interaction", sourceId)).send({ mode: "withdraw" }).expect(200);
    const response = await request(boardApp).post(`/api/companies/${companyId}/attention/issue_thread_interaction/${sourceId}/claim`).expect(409);
    expect(response.body.details).toMatchObject({ code: "attention_already_closed", status: "cancelled", resolvedByUserId: SCOTT });
  });

  it("lets a person withdraw a stale card on a closed task", async () => {
    const { companyId, workerId } = await seedCompany("CLD");
    const doneTask = await insertIssue(companyId, { status: "done", createdByUserId: SCOTT });
    const interactionId = await insertInteraction(companyId, doneTask, workerId);
    await request(app(board(companyId, SCOTT))).post(closeUrl(companyId, "issue_thread_interaction", interactionId))
      .send({ mode: "withdraw" }).expect(200);
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(row).toMatchObject({ status: "cancelled", resolvedByUserId: SCOTT });
  });

  it("returns 400, 403, 404, 409 and 422 for close", async () => {
    const { companyId, workerId } = await seedCompany("CLE");
    const issueId = await insertIssue(companyId, { createdByUserId: SCOTT });
    const interactionId = await insertInteraction(companyId, issueId, workerId);
    const hireId = randomUUID();
    await db.insert(approvals).values({ id: hireId, companyId, type: "hire_agent", status: "pending", requestedByUserId: SCOTT, payload: {} });
    const scott = app(board(companyId, SCOTT));
    const url = closeUrl(companyId, "issue_thread_interaction", interactionId);

    // 400: bad source kind, id or body.
    await request(scott).post(closeUrl(companyId, "nonsense", interactionId)).send({ mode: "archive" }).expect(400);
    await request(scott).post(closeUrl(companyId, "issue_thread_interaction", "not-a-uuid")).send({ mode: "archive" }).expect(400);
    await request(scott).post(url).send({ mode: "delete" }).expect(400);
    await request(scott).post(url).send({ mode: "snooze" }).expect(400);
    await request(scott).post(url).send({ mode: "snooze", until: new Date(Date.now() - 60_000).toISOString() }).expect(400);
    await request(scott).post(url).send({ mode: "withdraw", until: new Date(Date.now() + 60_000).toISOString() }).expect(400);
    // 403: agents, outsiders and read-only viewers.
    await request(app({ type: "agent", source: "agent_key", companyId, agentId: workerId, runId: null })).post(url).send({ mode: "withdraw" }).expect(403);
    await request(app(board(companyId, "outsider", { companyIds: [] }))).post(url).send({ mode: "withdraw" }).expect(403);
    await request(app(board(companyId, RILEY, { memberships: [{ companyId, status: "active", membershipRole: "viewer" }] })))
      .post(url).send({ mode: "withdraw" }).expect(403);
    // 422: nothing to withdraw, or a hire request that must be rejected instead.
    const unsupported = await request(scott).post(closeUrl(companyId, "budget_alert", randomUUID())).send({ mode: "withdraw" }).expect(422);
    expect(unsupported.body.details).toMatchObject({ code: "attention_close_mode_unsupported", closeModes: ["archive", "snooze"] });
    await request(scott).post(closeUrl(companyId, "approval", hireId)).send({ mode: "withdraw" }).expect(422);
    // 404: no such card for this person.
    await request(scott).post(closeUrl(companyId, "issue_thread_interaction", randomUUID())).send({ mode: "withdraw" }).expect(404);
    await request(scott).post(closeUrl(companyId, "issue_thread_interaction", randomUUID())).send({ mode: "archive" }).expect(404);

    // 409: the first answer wins; the second person learns who answered.
    await request(scott).post(url).send({ mode: "withdraw" }).expect(200);
    for (const mode of ["withdraw", "archive"]) {
      const late = await request(app(board(companyId, DOTTA))).post(url).send({ mode }).expect(409);
      expect(late.body.details).toMatchObject({
        code: "attention_already_closed", sourceKind: "issue_thread_interaction", sourceId: interactionId,
        status: "cancelled", resolvedByUserId: SCOTT,
      });
    }
    expect(await activity(companyId, "attention.closed")).toHaveLength(1);
  });

  it("withdraws approvals and decisions through their own cancel, recording who and why", async () => {
    const { companyId, workerId } = await seedCompany("CLA");
    const issueId = await insertIssue(companyId, { createdByUserId: SCOTT });
    const approvalId = randomUUID();
    await db.insert(approvals).values({ id: approvalId, companyId, type: "request_board_approval", status: "pending", requestedByUserId: DOTTA, payload: { title: "Ship" } });
    const decisionId = await insertDecision(companyId, workerId, issueId);
    const scott = app(board(companyId, SCOTT));

    await request(scott).post(closeUrl(companyId, "approval", approvalId)).send({ mode: "withdraw", reason: "Plan changed" }).expect(200);
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval).toMatchObject({ status: "cancelled", decidedByUserId: SCOTT, decisionNote: "Plan changed" });
    expect(await activity(companyId, "approval.cancelled")).toHaveLength(1);
    const late = await request(app(board(companyId, DOTTA))).post(closeUrl(companyId, "approval", approvalId)).send({ mode: "withdraw" }).expect(409);
    expect(late.body.details).toMatchObject({ code: "attention_already_closed", status: "cancelled", resolvedByUserId: SCOTT });

    const closedDecision = await request(scott).post(closeUrl(companyId, "decision", decisionId)).send({ mode: "withdraw", reason: "Vendor chosen elsewhere" }).expect(200);
    expect(closedDecision.body).toMatchObject({ sourceKind: "decision", issueId });
    const [decision] = await db.select().from(decisions).where(eq(decisions.id, decisionId));
    expect(decision).toMatchObject({ status: "cancelled", decidedByUserId: SCOTT });
    expect(decision?.metadata).toMatchObject({ cancelReason: "Vendor chosen elsewhere" });
    await request(scott).post(closeUrl(companyId, "decision", decisionId)).send({ mode: "withdraw" }).expect(409);

    const history = await decisionHistoryService(db).list(companyId, { actor: board(companyId, SCOTT) as never, userId: SCOTT, outcome: "withdrawn" });
    // Approvals are in history too (PAP-749 task 2e), so the withdrawn approval shows next to the decision.
    expect(history.items).toHaveLength(2);
    expect(history.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKind: "decision", label: "Withdrawn by user", reason: "Vendor chosen elsewhere" }),
      expect.objectContaining({ sourceKind: "approval", label: "Withdrawn by user", reason: "Plan changed", resultOutcome: "withdrawn" }),
    ]));
  });

  it("serves the approval cancel route to board users only", async () => {
    const { companyId, workerId } = await seedCompany("CAP");
    const approvalId = randomUUID();
    const hireId = randomUUID();
    await db.insert(approvals).values([
      { id: approvalId, companyId, type: "request_board_approval", status: "pending", requestedByUserId: DOTTA, payload: {} },
      { id: hireId, companyId, type: "hire_agent", status: "pending", requestedByUserId: DOTTA, payload: {} },
    ]);
    const cancelUrl = (id: string) => `/api/approvals/${id}/cancel`;
    await request(app({ type: "agent", source: "agent_key", companyId, agentId: workerId, runId: null })).post(cancelUrl(approvalId)).send({}).expect(403);
    await request(app(board(companyId, SCOTT))).post(cancelUrl(approvalId)).send({ reason: 7 }).expect(400);
    await request(app(board(companyId, SCOTT))).post(cancelUrl(randomUUID())).send({}).expect(404);
    await request(app(board(companyId, SCOTT))).post(cancelUrl(hireId)).send({}).expect(422);
    const cancelled = await request(app(board(companyId, SCOTT))).post(cancelUrl(approvalId)).send({ reason: "Stale" }).expect(200);
    expect(cancelled.body).toMatchObject({ id: approvalId, status: "cancelled", decidedByUserId: SCOTT });
    await request(app(board(companyId, SCOTT))).post(cancelUrl(approvalId)).send({}).expect(409);
  });

  it("archives and snoozes a card for one person only and keeps the source open", async () => {
    const { companyId, workerId } = await seedCompany("CLH");
    const issueId = await insertIssue(companyId, { createdByUserId: SCOTT });
    const archived = await insertInteraction(companyId, issueId, workerId);
    const snoozed = await insertInteraction(companyId, issueId, workerId, { kind: "ask_user_questions" });
    const scott = app(board(companyId, SCOTT));
    const visible = async (userId: string, id: string) =>
      (await attentionService(db).list(companyId, { userId, actor: board(companyId, userId) as never })).items.some((item) => item.subject.id === id);

    const archiveResponse = await request(scott).post(closeUrl(companyId, "issue_thread_interaction", archived)).send({ mode: "archive" }).expect(200);
    expect(archiveResponse.body).toMatchObject({ mode: "archive", issueId, until: null });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const snoozeResponse = await request(scott).post(closeUrl(companyId, "issue_thread_interaction", snoozed)).send({ mode: "snooze", until }).expect(200);
    expect(snoozeResponse.body).toMatchObject({ mode: "snooze", until });

    expect(await visible(SCOTT, archived)).toBe(false);
    expect(await visible(SCOTT, snoozed)).toBe(false);
    expect(await visible(DOTTA, archived)).toBe(true);
    expect(await visible(DOTTA, snoozed)).toBe(true);
    const rows = await db.select().from(inboxDismissals).where(eq(inboxDismissals.companyId, companyId));
    expect(rows.map((row) => row.kind).sort()).toEqual(["dismiss", "snooze"]);
    expect(rows.every((row) => row.userId === SCOTT && row.fingerprint)).toBe(true);
    const sources = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId));
    expect(sources.every((row) => row.status === "pending")).toBe(true);
    const closed = await activity(companyId, "attention.closed");
    expect(closed.map((entry) => (entry.details as Record<string, unknown>).mode).sort()).toEqual(["archive", "snooze"]);
  });

  it("does not let a company writer take another person's addressed request and approve it", async () => {
    const { companyId, workerId } = await seedCompany("CTA");
    await db.update(companyMemberships).set({ membershipRole: "operator" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, SCOTT)));
    const issueId = await insertIssue(companyId, { createdByUserId: DOTTA });
    const sourceId = await insertInteraction(companyId, issueId, workerId, { addresseeUserId: DOTTA });
    await request(app(board(companyId, SCOTT))).post(transferUrl(companyId, "issue_thread_interaction", sourceId)).send({ userId: SCOTT }).expect(403);
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, sourceId));
    expect(row).toMatchObject({ addresseeUserId: DOTTA, status: "pending" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    await expect(issueThreadInteractionService(db).acceptInteraction(
      issue, sourceId, {}, { userId: SCOTT },
    )).rejects.toMatchObject({ status: 403, details: { code: "interaction_addressee_mismatch" } });
    expect(await activity(companyId, "attention.transferred")).toEqual([]);
  });

  it("lets the addressed writer delegate without giving other writers routing administration", async () => {
    const { companyId, workerId } = await seedCompany("CTO");
    await db.update(companyMemberships).set({ membershipRole: "operator" }).where(eq(companyMemberships.companyId, companyId));
    const issueId = await insertIssue(companyId);
    const sourceId = await insertInteraction(companyId, issueId, workerId, { addresseeUserId: DOTTA });
    const url = transferUrl(companyId, "issue_thread_interaction", sourceId);
    await request(app(board(companyId, DOTTA))).post(url).send({ userId: RILEY }).expect(200);
    await request(app(board(companyId, DOTTA))).post(url).send({ userId: RILEY }).expect(200);
    await request(app(board(companyId, SCOTT))).post(url).send({ userId: SCOTT }).expect(403);
  });

  it.each(["interaction", "review"] as const)("never routes a request to its excluded %s creator, even for an administrator", async (restriction) => {
    const { companyId, workerId } = await seedCompany(restriction === "review" ? "CTR" : "CTI");
    const issueId = await insertIssue(companyId, { status: restriction === "review" ? "in_review" : "todo", createdByUserId: RILEY });
    const sourceId = await insertInteraction(companyId, issueId, workerId, { addresseeUserId: DOTTA });
    await db.update(issueThreadInteractions).set({ createdByAgentId: null, createdByUserId: RILEY,
      effectiveResolverPolicy: restriction === "interaction" ? "not_creator" : "anyone", resolverPolicyProvenance: "explicit" }).where(eq(issueThreadInteractions.id, sourceId));
    if (restriction === "review") await db.update(issues).set({ reviewPolicy: "not_creator" }).where(eq(issues.id, issueId));
    await request(app(board(companyId, SCOTT))).post(transferUrl(companyId, "issue_thread_interaction", sourceId)).send({ userId: RILEY }).expect(403);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, sourceId)))[0].addresseeUserId).toBe(DOTTA);
    expect(await activity(companyId, "attention.transferred")).toEqual([]);
  });

  it("does not let a viewer claim or route an ownerless request", async () => {
    const { companyId, workerId } = await seedCompany("CTV");
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, SCOTT)));
    const issueId = await insertIssue(companyId);
    const sourceId = await insertInteraction(companyId, issueId, workerId);
    const viewer = app(board(companyId, SCOTT));
    await request(viewer).post(transferUrl(companyId, "issue_thread_interaction", sourceId)).send({ userId: RILEY }).expect(403);
    await request(viewer).post(`/api/companies/${companyId}/attention/issue_thread_interaction/${sourceId}/claim`).expect(403);
  });

  it("does not let an excluded creator claim an ownerless request", async () => {
    const { companyId, workerId } = await seedCompany("CTC");
    const issueId = await insertIssue(companyId);
    const sourceId = await insertInteraction(companyId, issueId, workerId);
    await db.update(issueThreadInteractions).set({ createdByAgentId: null, createdByUserId: SCOTT, effectiveResolverPolicy: "not_creator", resolverPolicyProvenance: "explicit" }).where(eq(issueThreadInteractions.id, sourceId));
    await request(app(board(companyId, SCOTT))).post(`/api/companies/${companyId}/attention/issue_thread_interaction/${sourceId}/claim`).expect(403);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, sourceId)))[0].addresseeUserId).toBeNull();
  });

  it("transfers a card to another person who can answer it, with 400/403/404/409/422", async () => {
    const { companyId, workerId } = await seedCompany("CLT");
    const issueId = await insertIssue(companyId, { createdByUserId: DOTTA });
    const forDotta = await insertInteraction(companyId, issueId, workerId, { addresseeUserId: DOTTA });
    const approvalId = randomUUID();
    await db.insert(approvals).values({ id: approvalId, companyId, type: "request_board_approval", status: "pending", payload: {} });
    const chatIssue = await insertIssue(companyId, { conversation: { agentId: workerId, userId: DOTTA } });
    const chatQuestion = await insertInteraction(companyId, chatIssue, workerId, { kind: "ask_user_questions", addresseeUserId: DOTTA });
    const scott = app(board(companyId, SCOTT));
    const url = transferUrl(companyId, "issue_thread_interaction", forDotta);

    await request(scott).post(url).send({}).expect(400);
    await request(scott).post(url).send({ userId: RILEY, extra: true }).expect(400);
    await request(app({ type: "agent", source: "agent_key", companyId, agentId: workerId, runId: null })).post(url).send({ userId: RILEY }).expect(403);
    await request(scott).post(transferUrl(companyId, "issue_thread_interaction", randomUUID())).send({ userId: RILEY }).expect(404);
    await request(scott).post(transferUrl(companyId, "approval", approvalId)).send({ userId: RILEY }).expect(422);
    await request(scott).post(url).send({ userId: "not-a-member" }).expect(422);
    await request(scott).post(transferUrl(companyId, "issue_thread_interaction", chatQuestion)).send({ userId: RILEY }).expect(422);

    const moved = await request(scott).post(url).send({ userId: RILEY, reason: "Riley owns billing" }).expect(200);
    expect(moved.body).toEqual({
      sourceKind: "issue_thread_interaction", sourceId: forDotta, transferredToUserId: RILEY,
      previousAddresseeUserId: DOTTA, alreadyTransferred: false,
    });
    await request(scott).post(url).send({ userId: RILEY }).expect(200).then((response) => expect(response.body.alreadyTransferred).toBe(true));
    const rileyMine = await attentionService(db).list(companyId, { userId: RILEY, view: "mine" });
    expect(rileyMine.items.find((item) => item.subject.id === forDotta)?.audience).toEqual({ kind: "user", userId: RILEY, reason: "addressee", transferredByUserId: SCOTT });
    const dottaMine = await attentionService(db).list(companyId, { userId: DOTTA, view: "mine" });
    expect(dottaMine.items.some((item) => item.subject.id === forDotta)).toBe(false);
    const entries = await activity(companyId, "attention.transferred");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.details).toMatchObject({ transferredToUserId: RILEY, transferredByUserId: SCOTT, previousAddresseeUserId: DOTTA, reason: "Riley owns billing" });

    // Riley answers first; a late transfer and a late claim get "already answered".
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedByUserId: RILEY, resolvedAt: new Date() })
      .where(eq(issueThreadInteractions.id, forDotta));
    const late = await request(scott).post(url).send({ userId: DOTTA }).expect(409);
    expect(late.body.details).toMatchObject({ code: "attention_already_closed", status: "accepted", resolvedByUserId: RILEY });
    const lateClaim = await request(app(board(companyId, DOTTA))).post(`/api/companies/${companyId}/attention/issue_thread_interaction/${forDotta}/claim`).expect(409);
    expect(lateClaim.body.details).toMatchObject({ code: "attention_already_closed", resolvedByUserId: RILEY });
  });

  it("puts closeModes on feed items", async () => {
    const { companyId, workerId } = await seedCompany("CLM");
    const issueId = await insertIssue(companyId, { createdByUserId: SCOTT });
    const interactionId = await insertInteraction(companyId, issueId, workerId);
    const hireId = randomUUID();
    await db.insert(approvals).values({ id: hireId, companyId, type: "hire_agent", status: "pending", requestedByUserId: SCOTT, payload: {} });
    const feed = await attentionService(db).list(companyId, { userId: SCOTT });
    expect(feed.items.find((item) => item.subject.id === interactionId)?.closeModes).toEqual(["withdraw", "archive", "snooze"]);
    expect(feed.items.find((item) => item.subject.id === hireId)?.closeModes).toEqual(["archive", "snooze"]);
  });
});

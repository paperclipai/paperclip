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
  inboxDismissals,
  issueApprovals,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { attentionReceiptText } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { attentionRoutes } from "../routes/attention.js";
import { approvalRoutes } from "../routes/approvals.js";
import {
  attentionHandledDetails,
  attentionReceiptService,
  readAttentionHandledDetails,
  type AttentionHandledFor,
} from "../services/attention-receipts.js";
import { decisionHistoryService } from "../services/decision-history.js";
import { issueService } from "../services/issues.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention receipt tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("attention receipt details (PAP-749 task 2f)", () => {
  const handledFor: AttentionHandledFor = {
    userId: "dotta",
    actorUserId: "scott",
    sourceKind: "issue_thread_interaction",
    sourceId: "11111111-1111-4111-8111-111111111111",
    issueId: "22222222-2222-4222-8222-222222222222",
    title: "Approve this plan?",
  };

  it("writes handledForUserId and the receipt only when the card was for a different person", () => {
    expect(attentionHandledDetails(null, "answered")).toEqual({});
    expect(attentionHandledDetails(handledFor, "withdrawn", { reason: "  Out of date " })).toEqual({
      handledForUserId: "dotta",
      receipt: {
        outcome: "withdrawn",
        sourceKind: "issue_thread_interaction",
        sourceId: handledFor.sourceId,
        issueId: handledFor.issueId,
        title: "Approve this plan?",
        actorUserId: "scott",
        reason: "Out of date",
      },
    });
    const transferred = attentionHandledDetails(handledFor, "transferred", { transferredToUserId: "riley", reason: " " });
    expect(transferred).toMatchObject({ receipt: { outcome: "transferred", transferredToUserId: "riley" } });
    expect("reason" in (transferred as { receipt: object }).receipt).toBe(false);
  });

  it("reads back stored receipts and ignores malformed ones", () => {
    const details = attentionHandledDetails(handledFor, "answered");
    expect(readAttentionHandledDetails(details)).toMatchObject({ outcome: "answered", actorUserId: "scott", reason: null });
    expect(readAttentionHandledDetails(null)).toBeNull();
    expect(readAttentionHandledDetails({ receipt: { ...((details as { receipt: object }).receipt), outcome: "archived" } })).toBeNull();
    expect(readAttentionHandledDetails({ receipt: { ...((details as { receipt: object }).receipt), actorUserId: "" } })).toBeNull();
  });

  it("names the actor and, for a transfer, the new person", () => {
    expect(attentionReceiptText({ outcome: "answered", actorLabel: "scott" })).toBe("Answered by @scott");
    expect(attentionReceiptText({ outcome: "withdrawn", actorLabel: "scott" })).toBe("Withdrawn by @scott");
    expect(attentionReceiptText({ outcome: "transferred", actorLabel: "scott", transferredToLabel: "riley" }))
      .toBe("Transferred to @riley by @scott");
    // The verbs of the card's buttons and of Decision history (PAP-767).
    expect(attentionReceiptText({ outcome: "approved", actorLabel: "scott" })).toBe("Approved by @scott");
    expect(attentionReceiptText({ outcome: "changes_requested", actorLabel: "scott" })).toBe("Changes requested by @scott");
    expect(attentionReceiptText({ outcome: "decided", actorLabel: "scott" })).toBe("Decided by @scott");
    expect(attentionReceiptText({ outcome: "kept_paused", actorLabel: "dotta" })).toBe("Kept paused by @dotta");
    expect(attentionReceiptText({ outcome: "limit_raised", actorLabel: "dotta" })).toBe("Limit raised by @dotta");
  });
});

// PAP-749 task 2f (plan §6, Rule 12): the person a card was for always sees
// what a different person did with it.
describeEmbeddedPostgres("receipts for the other person (PAP-749 task 2f)", () => {
  const SCOTT = "scott";
  const DOTTA = "dotta";
  const RILEY = "riley";

  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-receipts-");
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
      await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}-${randomUUID()}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "admin" });
    }
    return { companyId, workerId };
  }

  async function insertIssue(companyId: string, createdByUserId: string) {
    const id = randomUUID();
    seq += 1;
    await db.insert(issues).values({
      id, companyId, identifier: `${seq}`, title: `Issue ${seq}`, status: "todo", priority: "medium",
      createdByUserId, originKind: "manual", originFingerprint: `fp-${seq}`,
    });
    return id;
  }

  it.each(["linked", "payload"])("checks every approval task before returning history or receipts (%s)", async (reference) => {
    const { companyId, workerId } = await seedCompany("SEC");
    const publicId = await insertIssue(companyId, SCOTT);
    const privateId = await insertIssue(companyId, SCOTT);
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, privateId));
    const sourceId = randomUUID();
    await db.insert(approvals).values({ id: sourceId, companyId, type: "request_board_approval", status: "cancelled", requestedByAgentId: workerId,
      requestedByUserId: DOTTA, decidedByUserId: SCOTT, decidedAt: new Date(), payload: { title: "Private result", ...(reference === "payload" ? { sourceIssueId: privateId } : {}) } });
    await db.insert(issueApprovals).values([{ companyId, issueId: publicId, approvalId: sourceId }, ...(reference === "linked" ? [{ companyId, issueId: privateId, approvalId: sourceId }] : [])]);
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: SCOTT, action: "approval.cancelled", entityType: "approval", entityId: sourceId,
      details: attentionHandledDetails({ userId: DOTTA, actorUserId: SCOTT, sourceKind: "approval", sourceId, issueId: publicId, title: "Private result" }, "withdrawn", { reason: "Private reason" }) });
    const previous = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    try {
      const actor = board(companyId, DOTTA) as never;
      const receipts = await attentionReceiptService(db).list(companyId, { userId: DOTTA, actor });
      expect(receipts).toEqual([]);
      const history = await decisionHistoryService(db).list(companyId, { userId: DOTTA, actor, scope: "all" });
      expect(history.items).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
      else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previous;
    }
  });

  async function insertInteraction(companyId: string, issueId: string, workerId: string, addresseeUserId: string | null = null) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id, companyId, issueId, kind: "request_confirmation", status: "pending", title: "Approve the launch plan?",
      createdByAgentId: workerId, addresseeUserId, payload: { version: 1, prompt: "Approve the launch plan?" } as never,
    });
    return id;
  }

  const board = (companyId: string, userId: string) =>
    ({ type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false });

  function app(companyId: string, userId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = board(companyId, userId);
      next();
    });
    testApp.use("/api", attentionRoutes(db));
    testApp.use("/api", approvalRoutes(db));
    testApp.use(errorHandler);
    return testApp;
  }

  const forYou = async (companyId: string, userId: string) => {
    const response = await request(app(companyId, userId)).get(`/api/companies/${companyId}/attention?all=true&view=mine`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as { receipts?: Array<Record<string, unknown>>; deskBadgeCount: number; items: Array<Record<string, any>> };
  };

  it("tells Dotta when Scott withdraws her card: one receipt with the reason, the task unread in Mine, Handled for me", async () => {
    const { companyId, workerId } = await seedCompany("RCW");
    const issueId = await insertIssue(companyId, DOTTA);
    const interactionId = await insertInteraction(companyId, issueId, workerId);
    const otherIssueId = await insertIssue(companyId, DOTTA);
    const otherInteractionId = await insertInteraction(companyId, otherIssueId, workerId);
    // Dotta read both tasks, cards included, before anything happened.
    const readAt = new Date();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db.execute(sql`insert into issue_read_states (company_id, issue_id, user_id, last_read_at)
      values (${companyId}, ${issueId}, ${DOTTA}, ${readAt.toISOString()}::timestamptz),
             (${companyId}, ${otherIssueId}, ${DOTTA}, ${readAt.toISOString()}::timestamptz)`);
    expect((await forYou(companyId, DOTTA)).deskBadgeCount).toBe(2);
    expect(await issueService(db).list(companyId, { unreadForUserId: DOTTA })).toEqual([]);

    await request(app(companyId, SCOTT))
      .post(`/api/companies/${companyId}/attention/issue_thread_interaction/${interactionId}/close`)
      .send({ mode: "withdraw", reason: "Plan changed" })
      .expect(200);

    // Both entries name Dotta; she sees one receipt.
    const handled = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), sql`${activityLog.details} ->> 'handledForUserId' = ${DOTTA}`));
    expect(handled.map((row) => row.action).sort()).toEqual(["attention.closed", "issue.thread_interaction_withdrawn"]);

    const dotta = await forYou(companyId, DOTTA);
    expect(dotta.items.map((item) => item.subject.id)).toEqual([otherInteractionId]);
    // A receipt is not a card and is not in the badge.
    expect(dotta.deskBadgeCount).toBe(1);
    expect(dotta.receipts).toHaveLength(1);
    expect(dotta.receipts![0]).toMatchObject({
      outcome: "withdrawn", sourceKind: "issue_thread_interaction", sourceId: interactionId,
      actorUserId: SCOTT, reason: "Plan changed", title: "Approve the launch plan?",
      issue: { id: issueId, href: expect.stringContaining("/RCW/issues/") },
      href: expect.stringContaining(`#interaction-${interactionId}`),
    });
    // The actor gets no receipt.
    expect((await forYou(companyId, SCOTT)).receipts).toEqual([]);

    // Mine: the withdrawn task is unread for Dotta; the untouched one is not.
    const unread = await issueService(db).list(companyId, { unreadForUserId: DOTTA });
    expect(unread.map((issue) => issue.id)).toEqual([issueId]);

    // Decision history: "Handled for me" is Dotta's, not Scott's.
    const mine = await decisionHistoryService(db).list(companyId, { actor: board(companyId, DOTTA) as never, userId: DOTTA, handledForMe: true });
    expect(mine.items.map((item) => item.sourceId)).toEqual([interactionId]);
    expect(mine.items[0]).toMatchObject({ handledForUserId: DOTTA, resolvedByUserId: SCOTT });
    const scotts = await decisionHistoryService(db).list(companyId, { actor: board(companyId, SCOTT) as never, userId: SCOTT, handledForMe: true });
    expect(scotts.items).toEqual([]);

    // Dismissed or older than 7 days: gone.
    await db.insert(inboxDismissals).values({
      companyId, userId: DOTTA, itemKey: dotta.receipts![0]!.dismissalKey as string, kind: "dismiss", dismissedAt: new Date(),
    });
    expect((await forYou(companyId, DOTTA)).receipts).toEqual([]);
    await db.delete(inboxDismissals);
    await db.update(activityLog).set({ createdAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(sql`${activityLog.details} ->> 'handledForUserId' = ${DOTTA}`);
    expect((await forYou(companyId, DOTTA)).receipts).toEqual([]);
  });

  it("makes no receipt when the person closes their own card", async () => {
    const { companyId, workerId } = await seedCompany("RCS");
    const issueId = await insertIssue(companyId, DOTTA);
    const interactionId = await insertInteraction(companyId, issueId, workerId);
    await request(app(companyId, DOTTA))
      .post(`/api/companies/${companyId}/attention/issue_thread_interaction/${interactionId}/close`)
      .send({ mode: "withdraw" })
      .expect(200);
    expect((await forYou(companyId, DOTTA)).receipts).toEqual([]);
    const handled = await db.select().from(activityLog).where(sql`(${activityLog.details} ->> 'handledForUserId') is not null`);
    expect(handled).toEqual([]);
  });

  it("moves a transferred card to Riley with \"Transferred by @scott\" and tells Dotta", async () => {
    const { companyId, workerId } = await seedCompany("RCT");
    const issueId = await insertIssue(companyId, SCOTT);
    const interactionId = await insertInteraction(companyId, issueId, workerId, DOTTA);

    await request(app(companyId, SCOTT))
      .post(`/api/companies/${companyId}/attention/issue_thread_interaction/${interactionId}/transfer`)
      .send({ userId: RILEY })
      .expect(200);

    const dotta = await forYou(companyId, DOTTA);
    expect(dotta.items).toEqual([]);
    expect(dotta.receipts).toHaveLength(1);
    expect(dotta.receipts![0]).toMatchObject({ outcome: "transferred", actorUserId: SCOTT, transferredToUserId: RILEY });

    const riley = await forYou(companyId, RILEY);
    expect(riley.receipts).toEqual([]);
    expect(riley.items).toHaveLength(1);
    expect(riley.items[0]!.audience).toEqual({ kind: "user", userId: RILEY, reason: "addressee", transferredByUserId: SCOTT });
  });

  it("tells Dotta when Scott approves the approval she requested", async () => {
    const { companyId } = await seedCompany("RCA");
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId, type: "request_board_approval", status: "pending", requestedByUserId: DOTTA, payload: { title: "Ship v2" },
    });
    await request(app(companyId, SCOTT)).post(`/api/approvals/${approvalId}/approve`).send({}).expect(200);

    const dotta = await forYou(companyId, DOTTA);
    expect(dotta.receipts).toHaveLength(1);
    expect(dotta.receipts![0]).toMatchObject({
      outcome: "approved", sourceKind: "approval", sourceId: approvalId, actorUserId: SCOTT, title: "Ship v2", issue: null,
      href: `/RCA/approvals/${approvalId}`,
    });
  });
});

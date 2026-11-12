import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  issueApprovals,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type { AttentionAudience, AttentionFeedView, AttentionItem, RequestConfirmationToolActionPayload } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  attentionChangeFingerprint,
  attentionService,
  dismissalCoversChange,
  escalateStaleAudience,
  resolveAttentionStale,
} from "../services/attention.js";
import { expirePendingInteractionsOnClosedIssues } from "../services/closed-issue-interaction-sweep.js";
import { inboxDismissalService } from "../services/inbox-dismissals.js";
import { pendingUserRequestRowCondition } from "../services/issue-participation.js";

const TOOL_ACTION = {
  version: 1,
  actionRequestId: "tool-approval",
  invocationId: "invocation",
  toolName: "calendar.create_event",
  toolDisplayName: "Create event",
  connectionId: null,
  applicationId: "google-calendar",
  appDisplayName: "Google Calendar",
  risk: "write",
  previewMarkdown: "Create the calendar event.",
  argumentsSummaryJson: "{}",
  argumentsHash: "fixture-arguments",
  expiresAt: null,
} satisfies RequestConfirmationToolActionPayload;

const DAY = 86_400_000;
const SCOTT = "scott";
const DOTTA = "dotta";
const POOL: AttentionAudience = { kind: "pool", userId: null, reason: "none" };
const FOR_SCOTT: AttentionAudience = { kind: "user", userId: SCOTT, reason: "addressee" };

// PAP-749 task 2a: the pure stale, escalation and fingerprint rules.
describe("attention stale and change rules (PAP-749 task 2a)", () => {
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const ago = (days: number) => new Date(now - days * DAY);
  const stale = (input: Partial<Parameters<typeof resolveAttentionStale>[0]>) => resolveAttentionStale({
    sourceKind: "issue_thread_interaction",
    issueStatus: "in_progress",
    since: ago(1),
    createdAt: ago(1),
    audience: FOR_SCOTT,
    now,
    ...input,
  });

  it("applies the closed-task, decision, 30-day and 7-day rules in order", () => {
    expect(stale({})).toBeNull();
    expect(stale({ issueStatus: "done" })).toEqual({ reason: "issue_closed" });
    expect(stale({ issueStatus: "cancelled", since: ago(60) })).toEqual({ reason: "issue_closed" });
    expect(stale({ since: ago(29) })).toBeNull();
    expect(stale({ since: ago(30) })).toEqual({ reason: "aged" });
    // The clock is the last important change, not the creation date.
    expect(stale({ createdAt: ago(60), since: ago(2) })).toBeNull();
    expect(stale({ audience: POOL, since: ago(6) })).toBeNull();
    expect(stale({ audience: POOL, since: ago(7) })).toEqual({ reason: "unowned" });
    expect(stale({ audience: POOL, since: ago(31) })).toEqual({ reason: "aged" });
    // 7-day decision window: 85% gone is stale, 50% is not.
    const decision = { sourceKind: "decision" as const, createdAt: ago(6), expiresAt: new Date(now + DAY) };
    expect(stale({ ...decision, createdAt: ago(5.95), since: ago(5.95) })).toEqual({ reason: "decision_expiring" });
    expect(stale({ ...decision, createdAt: ago(3.5), since: ago(3.5), expiresAt: new Date(now + 3.5 * DAY) })).toBeNull();
  });

  it("escalates an old Unassigned card to Company and an old required card to the owner or Company", () => {
    expect(escalateStaleAudience({ audience: POOL, since: ago(6), required: false, now })).toEqual(POOL);
    expect(escalateStaleAudience({ audience: POOL, since: ago(8), required: false, now }))
      .toEqual({ kind: "company", userId: null, reason: "none" });
    // A non-required card keeps its person; only required gates escalate.
    expect(escalateStaleAudience({ audience: FOR_SCOTT, since: ago(45), required: false, now })).toEqual(FOR_SCOTT);
    expect(escalateStaleAudience({ audience: FOR_SCOTT, since: ago(29), required: true, now })).toEqual(FOR_SCOTT);
    expect(escalateStaleAudience({ audience: FOR_SCOTT, since: ago(31), required: true, now }))
      .toEqual({ kind: "company", userId: null, reason: "none" });
    expect(escalateStaleAudience({
      audience: FOR_SCOTT, since: ago(31), required: true, now,
      companyConfig: { defaultDecisionOwnerUserId: DOTTA },
    })).toEqual({ kind: "user", userId: DOTTA, reason: "escalation_owner" });
    const company = { kind: "company" as const, userId: null, reason: "none" as const };
    expect(escalateStaleAudience({ audience: company, since: ago(90), required: true, now })).toEqual(company);
  });

  it("returns a hidden card only when its content changes or it comes to the viewer", () => {
    const content = { kind: "request_confirmation", payload: { prompt: "Ship?" } };
    const mine = attentionChangeFingerprint({ sourceKind: "issue_thread_interaction", content, forViewer: true });
    const other = attentionChangeFingerprint({ sourceKind: "issue_thread_interaction", content, forViewer: false });
    const edited = attentionChangeFingerprint({
      sourceKind: "issue_thread_interaction",
      content: { ...content, payload: { prompt: "Ship today?" } },
      forViewer: true,
    });
    // Key order does not matter; the hash is over canonical JSON.
    expect(attentionChangeFingerprint({
      sourceKind: "issue_thread_interaction",
      content: { payload: { prompt: "Ship?" }, kind: "request_confirmation" },
      forViewer: true,
    })).toBe(mine);

    expect(dismissalCoversChange(null, mine)).toBeNull();
    expect(dismissalCoversChange(mine, mine)).toBe(true);
    expect(dismissalCoversChange(mine, edited)).toBe(false);
    // The card comes to you again: hidden while it was someone else's.
    expect(dismissalCoversChange(other, mine)).toBe(false);
    // A hand-off away from you is an assignee change, not a reason to return.
    expect(dismissalCoversChange(mine, other)).toBe(true);
  });
});

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention current-card tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("attention current cards (PAP-749 task 2a)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-current-");
    db = createDb(externalUrl ?? tempDb!.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix = "CUR") {
    const companyId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: workerId, companyId, name: "Worker", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    return { companyId, workerId };
  }

  let issueSeq = 0;
  async function insertIssue(input: {
    companyId: string;
    status?: string;
    createdByUserId?: string | null;
    createdByAgentId?: string | null;
    assigneeAgentId?: string | null;
  }) {
    const id = randomUUID();
    issueSeq += 1;
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: `${issueSeq}`,
      title: `Issue ${issueSeq}`,
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      originKind: input.createdByAgentId ? "task_watchdog" : "manual",
      originFingerprint: `cur-${issueSeq}`,
    });
    return id;
  }

  async function insertInteraction(input: {
    companyId: string;
    issueId: string;
    workerId: string;
    kind?: string;
    addresseeUserId?: string | null;
    payload?: typeof issueThreadInteractions.$inferInsert.payload;
    ageDays?: number;
    dismissedAt?: Date | null;
  }) {
    const id = randomUUID();
    const at = new Date(Date.now() - (input.ageDays ?? 0) * DAY);
    await db.insert(issueThreadInteractions).values({
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      kind: input.kind ?? "request_confirmation",
      status: "pending",
      title: "Approve the plan",
      createdByAgentId: input.workerId,
      addresseeUserId: input.addresseeUserId ?? null,
      payload: input.payload ?? { version: 1, prompt: "Approve this plan?" },
      dismissedAt: input.dismissedAt ?? null,
      createdAt: at,
      updatedAt: at,
    });
    return id;
  }

  async function list(companyId: string, userId: string, view?: AttentionFeedView) {
    return (await attentionService(db).list(companyId, { userId, view })).items;
  }

  function find(items: AttentionItem[], sourceId: string) {
    return items.find((item) => item.subject.id === sourceId) ?? null;
  }

  it("lists only current interactions, with the same active-request predicate as Mine", async () => {
    const { companyId, workerId } = await seedCompany();
    const task = await insertIssue({ companyId, createdByUserId: SCOTT, assigneeAgentId: workerId });

    const current = await insertInteraction({ companyId, issueId: task, workerId, addresseeUserId: SCOTT });
    // A person deferred an ordinary request: it leaves the required list.
    const deferred = await insertInteraction({
      companyId, issueId: task, workerId, addresseeUserId: SCOTT, kind: "request_checkbox_confirmation",
      payload: { version: 1, prompt: "Pick some", options: [{ id: "a", label: "A" }] },
      dismissedAt: new Date(),
    });
    // A governed request keeps its gate even after a dismiss.
    const governed = await insertInteraction({
      companyId, issueId: task, workerId, addresseeUserId: SCOTT, kind: "request_confirmation",
      payload: { version: 1, prompt: "Allow the tool?", toolAction: TOOL_ACTION },
      dismissedAt: new Date(),
    });
    // An ordinary question answered by a later human comment is historical.
    const historical = await insertInteraction({
      companyId, issueId: task, workerId, addresseeUserId: SCOTT, kind: "ask_user_questions", ageDays: 1,
      payload: { version: 1, questions: [{ id: "q", prompt: "Which one?", selectionMode: "single", options: [{ id: "a", label: "A" }] }] },
    });
    await db.insert(issueComments).values({ companyId, issueId: task, authorUserId: SCOTT, body: "Use the first one." });

    const listed = (await list(companyId, SCOTT))
      .filter((item) => item.sourceKind === "issue_thread_interaction")
      .map((item) => item.subject.id)
      .sort();
    expect(listed).toEqual([current, governed].sort());
    expect(listed).not.toContain(deferred);
    expect(listed).not.toContain(historical);

    // Mine (`pendingUserRequestRowCondition`) selects exactly the same cards.
    const mine = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
      .where(pendingUserRequestRowCondition(companyId, SCOTT));
    expect(mine.map((row) => row.id).sort()).toEqual(listed);
  });

  it("labels 30-day-old cards stale and escalates a stale approval without withdrawing it", async () => {
    const { companyId, workerId } = await seedCompany();
    const task = await insertIssue({ companyId, createdByUserId: SCOTT, assigneeAgentId: workerId });
    const fresh = await insertInteraction({ companyId, issueId: task, workerId, ageDays: 10 });
    const old = await insertInteraction({ companyId, issueId: task, workerId, kind: "suggest_tasks", ageDays: 31,
      payload: { version: 1, tasks: [{ clientKey: "a", title: "Follow up" }] } });
    const governed = await insertInteraction({ companyId, issueId: task, workerId, kind: "request_confirmation",
      addresseeUserId: SCOTT, ageDays: 40, payload: { version: 1, prompt: "Allow?", toolAction: TOOL_ACTION } });
    const approvalId = randomUUID();
    const approvalAt = new Date(Date.now() - 31 * DAY);
    await db.insert(approvals).values({
      id: approvalId, companyId, type: "request_board_approval", status: "pending",
      requestedByUserId: SCOTT, payload: { title: "Ship it" }, createdAt: approvalAt, updatedAt: approvalAt,
    });

    let items = await list(companyId, SCOTT, "all");
    expect(find(items, fresh)?.stale).toBeNull();
    expect(find(items, fresh)?.audience).toEqual({ kind: "user", userId: SCOTT, reason: "instigator" });
    // An ordinary stale card stays with its person, in the Stale group.
    expect(find(items, old)?.stale).toEqual({ reason: "aged" });
    expect(find(items, old)?.audience).toEqual({ kind: "user", userId: SCOTT, reason: "instigator" });
    // Required cards go to Company when no escalation owner is set.
    expect(find(items, approvalId)?.stale).toEqual({ reason: "aged" });
    expect(find(items, approvalId)?.audience).toEqual({ kind: "company", userId: null, reason: "none" });
    expect(find(items, governed)?.audience).toEqual({ kind: "company", userId: null, reason: "none" });
    // The UI reads `required` so "Withdraw all stale" leaves these with a person (task 2c).
    expect(find(items, approvalId)?.required).toBe(true);
    expect(find(items, governed)?.required).toBe(true);
    expect(find(items, old)?.required).toBe(false);
    expect(find(await list(companyId, SCOTT, "company"), approvalId)).not.toBeNull();
    expect(find(await list(companyId, SCOTT, "mine"), approvalId)).toBeNull();

    // With a default decision owner, the stale approval goes to that person.
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: DOTTA, status: "active", membershipRole: "admin",
    });
    await db.update(companies).set({ defaultDecisionOwnerUserId: DOTTA }).where(eq(companies.id, companyId));
    items = await list(companyId, DOTTA, "mine");
    expect(find(items, approvalId)?.audience).toEqual({ kind: "user", userId: DOTTA, reason: "escalation_owner" });

    // Listing never withdraws, expires or approves anything.
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval?.status).toBe("pending");
    const statuses = await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions)
      .where(inArray(issueThreadInteractions.id, [old, governed]));
    expect(statuses.map((row) => row.status)).toEqual(["pending", "pending"]);
  });

  it.each([DOTTA, null])("collects an addressed stale required request for its escalation queue (%s)", async (owner) => {
    const { companyId, workerId } = await seedCompany();
    if (owner) await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: owner, status: "active", membershipRole: "admin" });
    await db.update(companies).set({ defaultDecisionOwnerUserId: owner }).where(eq(companies.id, companyId));
    const issueId = await insertIssue({ companyId, createdByUserId: SCOTT });
    const sourceId = await insertInteraction({ companyId, issueId, workerId, addresseeUserId: SCOTT, ageDays: 31,
      kind: "request_confirmation", payload: { version: 1, prompt: "Review", toolAction: TOOL_ACTION } });
    const incoming = await list(companyId, DOTTA, owner ? "mine" : "company");
    expect(find(incoming, sourceId)).toMatchObject({ required: true, audience: owner ? { kind: "user", userId: owner } : { kind: "company" } });
    expect(find(await list(companyId, SCOTT, "mine"), sourceId)).toBeNull();
  });

  it("labels cards on closed tasks stale", async () => {
    const { companyId, workerId } = await seedCompany();
    const doneTask = await insertIssue({ companyId, status: "done", createdByUserId: SCOTT });
    const cancelledTask = await insertIssue({ companyId, status: "cancelled", createdByUserId: SCOTT });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId, type: "request_board_approval", status: "pending",
      requestedByUserId: SCOTT, payload: { title: "Approve the launch" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId: doneTask, approvalId });
    // Older code left this card pending when the task was cancelled.
    const leftover = await insertInteraction({ companyId, issueId: cancelledTask, workerId });

    const items = await list(companyId, SCOTT);
    expect(find(items, approvalId)?.stale).toEqual({ reason: "issue_closed" });
    expect(find(items, leftover)?.stale).toEqual({ reason: "issue_closed" });
  });

  it("moves an Unassigned card with no owner for 7 days to Company", async () => {
    const { companyId, workerId } = await seedCompany();
    const agentTask = await insertIssue({ companyId, createdByAgentId: workerId, assigneeAgentId: workerId });
    const recent = await insertInteraction({ companyId, issueId: agentTask, workerId, ageDays: 3 });
    const unowned = await insertInteraction({ companyId, issueId: agentTask, workerId, kind: "suggest_tasks",
      ageDays: 8, payload: { version: 1, tasks: [{ clientKey: "a", title: "Triage" }] } });

    const all = await list(companyId, SCOTT, "all");
    expect(find(all, recent)?.audience).toEqual(POOL);
    expect(find(all, recent)?.stale).toBeNull();
    expect(find(all, unowned)?.audience).toEqual({ kind: "company", userId: null, reason: "none" });
    expect(find(all, unowned)?.stale).toEqual({ reason: "unowned" });
    expect(find(await list(companyId, SCOTT, "unassigned"), unowned)).toBeNull();
    expect(find(await list(companyId, SCOTT, "company"), unowned)).not.toBeNull();
  });

  it("brings a hidden card back only on an important change", async () => {
    const { companyId, workerId } = await seedCompany();
    const otherAgent = randomUUID();
    await db.insert(agents).values({
      id: otherAgent, companyId, name: "Other", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const task = await insertIssue({ companyId, createdByUserId: SCOTT, assigneeAgentId: workerId });
    const dismissed = await insertInteraction({ companyId, issueId: task, workerId, ageDays: 2 });
    const snoozed = await insertInteraction({ companyId, issueId: task, workerId, kind: "suggest_tasks", ageDays: 2,
      payload: { version: 1, tasks: [{ clientKey: "a", title: "One" }] } });
    const legacy = await insertInteraction({ companyId, issueId: task, workerId, kind: "request_checkbox_confirmation",
      ageDays: 2, payload: { version: 1, prompt: "Pick", options: [] } });
    const agentTask = await insertIssue({ companyId, createdByAgentId: workerId, assigneeAgentId: workerId });
    const pooled = await insertInteraction({ companyId, issueId: agentTask, workerId, ageDays: 1 });

    const dismissals = inboxDismissalService(db);
    const before = await list(companyId, SCOTT);
    const hide = (id: string) => find(before, id)!;
    await dismissals.dismiss(companyId, SCOTT, hide(dismissed).dismissalKey, new Date(), hide(dismissed).changeFingerprint);
    await dismissals.snooze(companyId, SCOTT, hide(snoozed).dismissalKey, new Date(Date.now() + 7 * DAY), new Date(),
      hide(snoozed).changeFingerprint);
    await dismissals.dismiss(companyId, SCOTT, hide(pooled).dismissalKey, new Date(), hide(pooled).changeFingerprint);
    // A row saved before fingerprints existed keeps the activity-time rule.
    await dismissals.dismiss(companyId, SCOTT, hide(legacy).dismissalKey, new Date());

    const visible = async () => (await list(companyId, SCOTT)).map((item) => item.subject.id);
    const hidden = await visible();
    for (const id of [dismissed, snoozed, pooled, legacy]) expect(hidden).not.toContain(id);

    // Log-only activity and an assignee change do not bring the cards back.
    const later = new Date(Date.now() + 60_000);
    await db.update(issueThreadInteractions).set({ updatedAt: later })
      .where(inArray(issueThreadInteractions.id, [dismissed, snoozed, pooled, legacy]));
    await db.update(issues).set({ assigneeAgentId: otherAgent, updatedAt: later }).where(eq(issues.id, task));
    let ids = await visible();
    expect(ids).not.toContain(dismissed);
    expect(ids).not.toContain(snoozed);
    expect(ids).not.toContain(pooled);
    // The legacy row still uses the old rule, so the newer activity shows it.
    expect(ids).toContain(legacy);

    // A changed proposal brings the card back, even mid-snooze.
    await db.update(issueThreadInteractions)
      .set({ payload: { version: 1, prompt: "Approve the revised plan?" } })
      .where(eq(issueThreadInteractions.id, dismissed));
    await db.update(issueThreadInteractions)
      .set({ payload: { version: 1, tasks: [{ clientKey: "a", title: "One" }, { clientKey: "b", title: "Two" }] } })
      .where(eq(issueThreadInteractions.id, snoozed));
    // The pooled card comes to Scott: that is also a reason to return.
    await db.update(issueThreadInteractions).set({ addresseeUserId: SCOTT })
      .where(eq(issueThreadInteractions.id, pooled));
    ids = await visible();
    expect(ids).toContain(dismissed);
    expect(ids).toContain(snoozed);
    expect(ids).toContain(pooled);
  });

  it("expires pending cards on closed tasks once, and a second sweep changes nothing", async () => {
    const { companyId, workerId } = await seedCompany();
    const cancelledTask = await insertIssue({ companyId, status: "cancelled", createdByUserId: SCOTT });
    const doneTask = await insertIssue({ companyId, status: "done", createdByUserId: SCOTT });
    const answeredTask = await insertIssue({ companyId, status: "done", createdByUserId: SCOTT });
    const openTask = await insertIssue({ companyId, createdByUserId: SCOTT, assigneeAgentId: workerId });

    const onCancelled = [
      await insertInteraction({ companyId, issueId: cancelledTask, workerId }),
      await insertInteraction({ companyId, issueId: cancelledTask, workerId, kind: "ask_user_questions",
        payload: { version: 1, questions: [{ id: "q", prompt: "Why?", selectionMode: "single", options: [{ id: "a", label: "A" }] }] } }),
    ];
    const onDone = await insertInteraction({ companyId, issueId: doneTask, workerId });
    // A done task keeps an ordinary historical question answerable.
    const historical = await insertInteraction({ companyId, issueId: answeredTask, workerId, kind: "ask_user_questions",
      ageDays: 1, payload: { version: 1, questions: [{ id: "q", prompt: "Which?", selectionMode: "single", options: [{ id: "a", label: "A" }] }] } });
    await db.insert(issueComments).values({ companyId, issueId: answeredTask, authorUserId: SCOTT, body: "Answered here." });
    const onOpen = await insertInteraction({ companyId, issueId: openTask, workerId });

    const first = await expirePendingInteractionsOnClosedIssues(db);
    expect(first).toEqual({ issues: 2, expired: 3, failed: 0 });

    const statusOf = async () => new Map((await db
      .select({ id: issueThreadInteractions.id, status: issueThreadInteractions.status, result: issueThreadInteractions.result })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.companyId, companyId)))
      .map((row) => [row.id, row]));
    const afterFirst = await statusOf();
    for (const id of [...onCancelled, onDone]) {
      expect(afterFirst.get(id)?.status).toBe("expired");
      expect(afterFirst.get(id)?.result).toMatchObject({ outcome: "issue_closed" });
    }
    expect(afterFirst.get(historical)?.status).toBe("pending");
    expect(afterFirst.get(onOpen)?.status).toBe("pending");

    const sweepEntries = () => db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "issue.thread_interaction_expired"),
      eq(activityLog.actorId, "attention.closed_issue_sweep"),
    ));
    const entries = await sweepEntries();
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.actorType === "system")).toBe(true);

    const second = await expirePendingInteractionsOnClosedIssues(db);
    expect(second).toEqual({ issues: 0, expired: 0, failed: 0 });
    expect(await statusOf()).toEqual(afterFirst);
    expect(await sweepEntries()).toHaveLength(3);
  });

  it("keeps sweeping and logs what closed when one card on an issue cannot expire", async () => {
    const { companyId, workerId } = await seedCompany();
    const cancelledTask = await insertIssue({ companyId, status: "cancelled", createdByUserId: SCOTT });
    const confirmation = await insertInteraction({ companyId, issueId: cancelledTask, workerId, ageDays: 2 });
    // A legacy payload that no longer passes validation.
    const broken = await insertInteraction({ companyId, issueId: cancelledTask, workerId, kind: "ask_user_questions",
      ageDays: 1, payload: { version: 1, questions: [{ id: "q", prompt: "Why?", selectionMode: "single", options: [] }] } });
    const otherTask = await insertIssue({ companyId, status: "cancelled", createdByUserId: SCOTT });
    const other = await insertInteraction({ companyId, issueId: otherTask, workerId });

    const result = await expirePendingInteractionsOnClosedIssues(db);
    expect(result.failed).toBe(1);
    const rows = new Map((await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.companyId, companyId))).map((row) => [row.id, row.status]));
    expect(rows.get(other)).toBe("expired");
    expect(rows.get(broken)).toBe("pending");
    const logged = (await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.actorId, "attention.closed_issue_sweep"),
    ))).map((entry) => (entry.details as { interactionId?: string } | null)?.interactionId);
    // Every card that did close is in the activity log, including the one
    // that closed before its sibling failed.
    for (const id of [other, ...(rows.get(confirmation) === "expired" ? [confirmation] : [])]) {
      expect(logged).toContain(id);
    }
    expect(result.expired).toBe(logged.length);
  });
});

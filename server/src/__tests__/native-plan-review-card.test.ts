import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  goals,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { ensureNativePlanReviewCard, planReviewCardIdempotencyKey } from "../services/native-runtime/native-plan-review-card.js";
import { synchronizeCompletedProviderPlan } from "../services/native-runtime/native-session-executor.js";
import { documentService } from "../services/documents.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Lets a test hand the card function the document as it was read before a
// newer revision landed: the window a delayed settle runs in.
const staleRead = vi.hoisted(() => ({ next: null as unknown }));
vi.mock("../services/documents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/documents.js")>();
  return {
    ...actual,
    documentService: (db: Parameters<typeof actual.documentService>[0]) => {
      const service = actual.documentService(db);
      return {
        ...service,
        getIssueDocumentByKey: async (...args: Parameters<typeof service.getIssueDocumentByKey>) => {
          if (staleRead.next) {
            const snapshot = staleRead.next;
            staleRead.next = null;
            return snapshot as Awaited<ReturnType<typeof service.getIssueDocumentByKey>>;
          }
          return service.getIssueDocumentByKey(...args);
        },
      };
    },
  };
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_PLAN_REVIEW_CARD_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PLAN = "# Create crash-proof.txt\n\n1. Write the file.\n2. Verify it.";

// Harnesses without a provider plan event (Antigravity and other ACPX agents)
// write the Plan document with a tool. A Plan-mode run that settles without
// opening the review card — for example a run recovered after its process was
// killed — must not leave the task waiting on a review nobody can give.
describeEmbeddedPostgres("Plan-mode review card on settle", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-review-card-");
    db = createDb(external ?? tempDb!.connectionString, { maxConnections: 6 });
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  let prefix = 0;
  async function seed(workMode: "standard" | "planning" = "planning", options: { conversation?: boolean } = {}) {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `PRC${++prefix}`, requireBoardApprovalForNewAgents: false });
    await db.insert(goals).values({ id: goalId, companyId, title: "Ship", level: "task", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Gemma", role: "engineer", status: "active",
      adapterType: "antigravity_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, goalId, title: "Create crash-proof.txt", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, workMode,
      ...(options.conversation ? { conversationAgentId: agentId, conversationUserId: "local-board", conversationState: "active" } : {}),
    });
    const newRun = async () => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
      return runId;
    };
    const binding = (runId: string) => ({ companyId, issueId, agentId, runId });
    const writePlan = async (runId: string, body = PLAN) => documentService(db).upsertIssueDocument({
      issueId, key: "plan", title: "Plan", format: "markdown", body,
      baseRevisionId: (await documentService(db).getIssueDocumentByKey(issueId, "plan"))?.latestRevisionId ?? undefined,
      createdByAgentId: agentId, createdByRunId: runId,
    } as never);
    const cards = () => db.select().from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.issueId, issueId), eq(issueThreadInteractions.kind, "request_confirmation")));
    return { companyId, issueId, agentId, newRun, binding, writePlan, cards };
  }

  it("opens exactly one review card for a recovered run's new plan revision", async () => {
    const t = await seed();
    await t.newRun(); // the killed run
    const recovered = await t.newRun();
    await t.writePlan(recovered);

    const outcome = await ensureNativePlanReviewCard(db, t.binding(recovered));

    expect(outcome.kind).toBe("created");
    const cards = await t.cards();
    expect(cards).toHaveLength(1);
    const plan = await documentService(db).getIssueDocumentByKey(t.issueId, "plan");
    expect(cards[0]).toMatchObject({ status: "pending", sourceRunId: recovered, createdByAgentId: t.agentId });
    expect(cards[0]!.payload).toMatchObject({
      acceptLabel: "Approve plan", rejectLabel: "Request changes",
      target: { type: "issue_document", key: "plan", revisionId: plan!.latestRevisionId, revisionNumber: 1 },
    });
    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, t.issueId));
    expect(activity).toEqual([expect.objectContaining({ action: "issue.thread_interaction_created", actorType: "system" })]);
  });

  // The agent's plan card opened as instructed: bound to the saved plan revision.
  async function agentPlanCard(t: Awaited<ReturnType<typeof seed>>, runId: string, key: string) {
    const plan = await documentService(db).getIssueDocumentByKey(t.issueId, "plan");
    return issueThreadInteractionService(db).create({ id: t.issueId, companyId: t.companyId }, {
      kind: "request_confirmation", idempotencyKey: key, sourceRunId: runId, continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Approve the plan?", acceptLabel: "Approve plan", rejectLabel: "Request changes",
        target: { type: "issue_document", issueId: t.issueId, documentId: plan!.id, key: "plan",
          revisionId: plan!.latestRevisionId, revisionNumber: plan!.latestRevisionNumber } },
    } as never, { agentId: t.agentId, runId });
  }
  const plainCard = (t: Awaited<ReturnType<typeof seed>>, runId: string, key: string, prompt: string) =>
    issueThreadInteractionService(db).create({ id: t.issueId, companyId: t.companyId }, {
      kind: "request_confirmation", idempotencyKey: key, sourceRunId: runId, continuationPolicy: "wake_assignee_on_accept",
      payload: { version: 1, prompt, acceptLabel: "Confirm", rejectLabel: "Request changes" },
    } as never, { agentId: t.agentId, runId });

  it("does nothing when the agent already opened its plan card for the revision", async () => {
    const t = await seed();
    const runId = await t.newRun();
    await t.writePlan(runId);
    await agentPlanCard(t, runId, "confirm-plan-v1");

    await expect(ensureNativePlanReviewCard(db, t.binding(runId))).resolves.toMatchObject({ kind: "pending" });
    expect(await t.cards()).toHaveLength(1);
  });

  it("keeps one card across repeated and concurrent settles of the same and later runs", async () => {
    const t = await seed();
    const runId = await t.newRun();
    await t.writePlan(runId);
    const reconcileRun = await t.newRun();

    const outcomes = await Promise.all([
      ensureNativePlanReviewCard(db, t.binding(runId)),
      ensureNativePlanReviewCard(db, t.binding(runId)),
      ensureNativePlanReviewCard(db, t.binding(reconcileRun)),
    ]);
    await ensureNativePlanReviewCard(db, t.binding(runId));
    await ensureNativePlanReviewCard(db, t.binding(reconcileRun));

    expect(outcomes.filter(outcome => outcome.kind === "created")).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, t.issueId))).toHaveLength(1);
    const cards = await t.cards();
    expect(cards.filter(card => card.status === "pending")).toHaveLength(1);
    expect(cards).toHaveLength(1);
  });

  it("opens a new card for the revision written after Request changes and leaves the old one unanswerable", async () => {
    const t = await seed();
    const first = await t.newRun();
    await t.writePlan(first);
    const created = await ensureNativePlanReviewCard(db, t.binding(first));
    if (created.kind !== "created") throw new Error("expected a card");
    const interactions = issueThreadInteractionService(db);
    const [oldCard] = await t.cards();
    await interactions.rejectInteraction(
      { id: t.issueId, companyId: t.companyId }, oldCard!.id,
      { reason: "Name the file crash-proof-2.txt" } as never, { userId: "local-board" } as never,
    );

    // Request changes answered this revision: nothing new until the agent revises.
    await expect(ensureNativePlanReviewCard(db, t.binding(first))).resolves.toMatchObject({ kind: "reviewed" });

    const second = await t.newRun();
    await t.writePlan(second, `${PLAN}\n3. Use crash-proof-2.txt.`);
    await expect(ensureNativePlanReviewCard(db, t.binding(second))).resolves.toMatchObject({ kind: "created" });

    const cards = await t.cards();
    expect(cards).toHaveLength(2);
    const pending = cards.filter(card => card.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.payload).toMatchObject({ target: { revisionNumber: 2 } });
    expect(cards.find(card => card.id === oldCard!.id)?.status).toBe("rejected");
  });

  it("replaces a still-pending card for an older revision", async () => {
    const t = await seed();
    const first = await t.newRun();
    await t.writePlan(first);
    await ensureNativePlanReviewCard(db, t.binding(first));
    const [oldCard] = await t.cards();
    const second = await t.newRun();
    await t.writePlan(second, `${PLAN}\n3. Revised.`);

    await expect(ensureNativePlanReviewCard(db, t.binding(second))).resolves.toMatchObject({ kind: "created" });

    const cards = await t.cards();
    expect(cards.find(card => card.id === oldCard!.id)?.status).toBe("expired");
    expect(cards.filter(card => card.status === "pending")).toHaveLength(1);
    await expect(interactionsAccept(t, oldCard!.id)).rejects.toThrow();
  });

  it("never withdraws a newer revision's card from a delayed settle of an older one", async () => {
    const t = await seed();
    const first = await t.newRun();
    await t.writePlan(first);
    const revisionOne = await documentService(db).getIssueDocumentByKey(t.issueId, "plan");
    const second = await t.newRun();
    await t.writePlan(second, `${PLAN}\n3. Revised.`);
    await expect(ensureNativePlanReviewCard(db, t.binding(second))).resolves.toMatchObject({ kind: "created" });

    // The first run's settle read revision 1 before revision 2 landed.
    staleRead.next = revisionOne;
    await expect(ensureNativePlanReviewCard(db, t.binding(first))).resolves.toMatchObject({ kind: "not_applicable" });

    const cards = await t.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: "pending" });
    expect(cards[0]!.payload).toMatchObject({ target: { revisionNumber: 2 } });
  });

  it("withdraws the agent's plan card for v1 when a recovered run writes v2, leaving one answerable card", async () => {
    const t = await seed();
    const crashed = await t.newRun();
    await t.writePlan(crashed);
    const v1 = await agentPlanCard(t, crashed, "own-v1");
    const recovered = await t.newRun();
    await t.writePlan(recovered, `${PLAN}\n3. Revised after recovery.`);

    await expect(ensureNativePlanReviewCard(db, t.binding(recovered))).resolves.toMatchObject({ kind: "created" });

    const pending = (await t.cards()).filter(card => card.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.payload).toMatchObject({ target: { revisionNumber: 2 } });
    await expect(interactionsAccept(t, v1.id)).rejects.toThrow();
  });

  it("keeps an unrelated confirmation opened after the plan ordinary: answering it never approves the plan", async () => {
    const t = await seed();
    const runId = await t.newRun();
    await t.writePlan(runId);
    const unrelated = await plainCard(t, runId, "rename-repo", "May I rename the repository?");
    expect((unrelated.payload as { target?: unknown }).target).toBeUndefined();

    await expect(ensureNativePlanReviewCard(db, t.binding(runId))).resolves.toMatchObject({ kind: "created" });
    await interactionsAccept(t, unrelated.id);

    const [issue] = await db.select().from(issues).where(eq(issues.id, t.issueId));
    expect(issue!.workMode).toBe("planning");
    const planCards = (await t.cards()).filter(card => (card.payload as { target?: { key?: string } }).target?.key === "plan");
    expect(planCards).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it("leaves a card opened before plan binding existed answerable, and still opens the current plan's card", async () => {
    const t = await seed();
    const first = await t.newRun();
    await t.writePlan(first);
    // A row an older release saved: the agent's plan card with no target.
    const [legacy] = await db.insert(issueThreadInteractions).values({
      companyId: t.companyId, issueId: t.issueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee_on_accept", sourceRunId: first, createdByAgentId: t.agentId,
      payload: { version: 1, prompt: "Proceed with plan v1?", acceptLabel: "Confirm", rejectLabel: "Request changes" },
    }).returning();
    const second = await t.newRun();
    await new Promise(resolve => setTimeout(resolve, 5));
    await t.writePlan(second, `${PLAN}\n3. Revised.`);

    await expect(ensureNativePlanReviewCard(db, t.binding(second))).resolves.toMatchObject({ kind: "created" });

    const cards = await t.cards();
    // Not withdrawn by guess; its answer reaches the agent as an ordinary confirmation.
    expect(cards.find(card => card.id === legacy!.id)?.status).toBe("pending");
    expect(cards.filter(card => card.status === "pending" &&
      (card.payload as { target?: { revisionNumber?: number } }).target?.revisionNumber === 2)).toHaveLength(1);
    // Accepting the old card does not approve the newer revision.
    await interactionsAccept(t, legacy!.id);
    const [issue] = await db.select().from(issues).where(eq(issues.id, t.issueId));
    expect(issue!.workMode).toBe("planning");
    expect((await t.cards()).filter(card => card.status === "pending")).toHaveLength(1);
  });

  it.each(["server", "agent"])("keeps run A's pending %s plan card as the gate when run B settles a Plan-mode conversation", async (opener) => {
    const t = await seed("planning", { conversation: true });
    const first = await t.newRun();
    await t.writePlan(first);
    if (opener === "server") await expect(ensureNativePlanReviewCard(db, t.binding(first))).resolves.toMatchObject({ kind: "created" });
    else await agentPlanCard(t, first, "conversation-plan");
    const second = await t.newRun();

    await expect(ensureNativePlanReviewCard(db, t.binding(second))).resolves.toMatchObject({ kind: "pending" });
    expect((await t.cards()).filter(card => card.status === "pending")).toHaveLength(1);
  });

  async function interactionsAccept(t: Awaited<ReturnType<typeof seed>>, id: string) {
    return issueThreadInteractionService(db).acceptInteraction(
      { id: t.issueId, companyId: t.companyId, projectId: null, goalId: null }, id, {} as never, { userId: "local-board" } as never,
    );
  }

  it("returns the original card for an identical retry after a plan revision landed", async () => {
    const t = await seed();
    const runId = await t.newRun();
    const first = await plainCard(t, runId, "retry-key", "May I proceed?");
    // The response was lost; meanwhile the agent saved its plan.
    await t.writePlan(runId);

    const retried = await plainCard(t, runId, "retry-key", "May I proceed?");
    expect(retried.id).toBe(first.id);
  });

  it("reports a Plan-mode run with no plan, and leaves Standard tasks untouched", async () => {
    const planning = await seed();
    const runId = await planning.newRun();
    await expect(ensureNativePlanReviewCard(db, planning.binding(runId))).resolves.toEqual({ kind: "no_plan" });
    expect(await planning.cards()).toHaveLength(0);

    const standard = await seed("standard");
    const standardRun = await standard.newRun();
    await standard.writePlan(standardRun);
    await expect(ensureNativePlanReviewCard(db, standard.binding(standardRun))).resolves.toEqual({ kind: "not_applicable" });
    expect(await standard.cards()).toHaveLength(0);
  });

  it("leaves the card Codex and Claude open from their plan event as the only card", async () => {
    const t = await seed();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: t.companyId, agentId: t.agentId, status: "running", contextSnapshot: { issueId: t.issueId } });
    const synced = await synchronizeCompletedProviderPlan({
      db,
      execution: {
        binding: t.binding(runId), provider: { kind: "codex" }, task: { workMode: "planning" }, executionMode: "plan",
        planningContext: { documentId: null, baseRevisionId: null, baseRevisionNumber: 0, markdown: "", sha256: "none", reviewContext: {} },
      } as never,
      event: { sourceEventId: "event-1", turnId: "turn-1", eventType: "plan.proposed",
        payload: { schema: "paperclip.plan.proposed.v1", proposalId: "plan-1", status: "completed", markdown: PLAN, source: "codex" } },
    });
    expect(synced).toMatchObject({ status: "synchronized" });

    await expect(ensureNativePlanReviewCard(db, t.binding(runId))).resolves.toMatchObject({ kind: "pending", interactionId: synced!.confirmationId });
    expect(await t.cards()).toHaveLength(1);
  });

  it("does not put a person's own plan edit up for review", async () => {
    const t = await seed();
    const runId = await t.newRun();
    await documentService(db).upsertIssueDocument({
      issueId: t.issueId, key: "plan", title: "Plan", format: "markdown", body: "# My plan", createdByUserId: "local-board",
    });
    await expect(ensureNativePlanReviewCard(db, t.binding(runId))).resolves.toEqual({ kind: "not_applicable" });
    expect(await t.cards()).toHaveLength(0);
  });
  // Each way a Plan-mode run can leave the task, and the one current action
  // the user gets: a review card for the revision, or (no plan / already
  // answered) the arbiter's "save your plan" continuation.
  type Scenario = { name: string; setup: (t: Awaited<ReturnType<typeof seed>>, runId: string) => Promise<void>;
    kind: "created" | "pending" | "reviewed" | "no_plan" };
  const question = async (t: Awaited<ReturnType<typeof seed>>, runId: string) => {
    const [row] = await db.insert(issueThreadInteractions).values({
      companyId: t.companyId, issueId: t.issueId, kind: "ask_user_questions", status: "pending",
      continuationPolicy: "wake_assignee", sourceRunId: runId, createdByAgentId: t.agentId,
      payload: { version: 1, questions: [{ id: "q1", prompt: "Which name?", selectionMode: "single",
        options: [{ id: "a", label: "A" }] }] },
    }).returning();
    return row!;
  };
  const scenarios: Scenario[] = [
    { name: "no plan saved", setup: async () => {}, kind: "no_plan" },
    { name: "plan saved, agent opened no card (first run or recovered run)", setup: async (t, runId) => { await t.writePlan(runId); }, kind: "created" },
    { name: "plan saved, agent opened its plan card bound to the revision", setup: async (t, runId) => {
      await t.writePlan(runId); await agentPlanCard(t, runId, `own-${runId}`);
    }, kind: "pending" },
    { name: "plan saved, agent opened an unbound confirmation (ordinary, not a plan review)", setup: async (t, runId) => {
      await t.writePlan(runId); await plainCard(t, runId, `plain-${runId}`, "Proceed?");
    }, kind: "created" },
    { name: "plan saved, agent asked a current question", setup: async (t, runId) => {
      await t.writePlan(runId); await question(t, runId);
    }, kind: "pending" },
    { name: "plan saved, an older question a later comment made historical", setup: async (t, runId) => {
      await question(t, runId);
      await db.insert(issueComments).values({ companyId: t.companyId, issueId: t.issueId, authorType: "user",
        authorUserId: "local-board", body: "Use A.", createdAt: new Date(Date.now() + 1_000) });
      await t.writePlan(runId);
    }, kind: "created" },
    { name: "plan saved, an older question the user dismissed", setup: async (t, runId) => {
      const row = await question(t, runId);
      await db.update(issueThreadInteractions).set({ dismissedAt: new Date(), dismissedByUserId: "local-board" })
        .where(eq(issueThreadInteractions.id, row.id));
      await t.writePlan(runId);
    }, kind: "created" },
    ...(["toolAction", "secretProposal", "connectionAuthorization", "qualityReview"] as const).flatMap(key =>
      (["pending", "accepted", "rejected"] as const).map((status): Scenario => ({
        name: `plan saved, an unrelated ${key} card (${status}) opened after it`,
        setup: async (t, runId) => {
          await t.writePlan(runId);
          await db.insert(issueThreadInteractions).values({
            companyId: t.companyId, issueId: t.issueId, kind: "request_confirmation", status,
            continuationPolicy: "wake_assignee", sourceRunId: runId, createdByAgentId: t.agentId,
            payload: { version: 1, prompt: "Allow this?", [key]: { id: "governed" } },
          });
        },
        kind: "created",
      }))),
    { name: "plan saved, a confirmation someone else opened after it", setup: async (t, runId) => {
      await t.writePlan(runId);
      await db.insert(issueThreadInteractions).values({
        companyId: t.companyId, issueId: t.issueId, kind: "request_confirmation", status: "rejected",
        continuationPolicy: "none", createdByUserId: "local-board",
        payload: { version: 1, prompt: "Unrelated?" },
      });
    }, kind: "created" },
    { name: "revision already answered with Request changes, no new revision", setup: async (t, runId) => {
      await t.writePlan(runId);
      await ensureNativePlanReviewCard(db, t.binding(runId));
      const [card] = await t.cards();
      await issueThreadInteractionService(db).rejectInteraction({ id: t.issueId, companyId: t.companyId }, card!.id,
        { reason: "Rename it" } as never, { userId: "local-board" } as never);
    }, kind: "reviewed" },
    { name: "new revision after Request changes", setup: async (t, runId) => {
      await t.writePlan(runId);
      await ensureNativePlanReviewCard(db, t.binding(runId));
      const [card] = await t.cards();
      await issueThreadInteractionService(db).rejectInteraction({ id: t.issueId, companyId: t.companyId }, card!.id,
        { reason: "Rename it" } as never, { userId: "local-board" } as never);
      await t.writePlan(runId, `${PLAN}\n3. Renamed.`);
    }, kind: "created" },
  ];

  it.each(scenarios)("$name", async ({ setup, kind }) => {
    const t = await seed();
    const runId = await t.newRun();
    await setup(t, runId);

    const outcome = await ensureNativePlanReviewCard(db, t.binding(runId));
    expect(outcome.kind).toBe(kind);
    // A repeat settle changes nothing, and at most one review card is pending.
    await expect(ensureNativePlanReviewCard(db, t.binding(runId))).resolves.toMatchObject({
      kind: kind === "created" ? "pending" : kind });
    const planReviews = (await t.cards()).filter(card => card.status === "pending" &&
      (card.payload as { target?: { key?: string } }).target?.key === "plan");
    expect(planReviews.length).toBeLessThanOrEqual(1);
    if (kind === "created") expect(planReviews).toHaveLength(1);
  });
  // Every state the current revision's own plan card can reach, and what the
  // user is left with: a current card, or (they decided) the agent's bounded
  // "revise your plan" continuation. Never a silent wait, never a second card
  // for a plan the user already accepted.
  type CardState = { status: string; by?: "user" | "agent" | "system"; dismissed?: boolean; laterComment?: boolean;
    outcome: "pending" | "reviewed" | "created" };
  const cardStates: CardState[] = [
    { status: "pending", outcome: "pending" },
    { status: "pending", dismissed: true, outcome: "pending" },
    { status: "pending", laterComment: true, outcome: "pending" },
    { status: "accepted", by: "user", outcome: "reviewed" },
    { status: "rejected", by: "user", outcome: "reviewed" },
    { status: "cancelled", by: "user", outcome: "reviewed" },
    { status: "cancelled", by: "agent", outcome: "created" },
    { status: "expired", by: "system", outcome: "created" },
    { status: "expired", by: "agent", outcome: "created" },
    { status: "failed", by: "system", outcome: "created" },
  ];
  it.each(cardStates)("current revision's card $status (by $by, dismissed $dismissed, later comment $laterComment) -> $outcome",
    async ({ status, by, dismissed, laterComment, outcome }) => {
      const t = await seed();
      const runId = await t.newRun();
      await t.writePlan(runId);
      const plan = await documentService(db).getIssueDocumentByKey(t.issueId, "plan");
      const resolved = status !== "pending";
      const [card] = await db.insert(issueThreadInteractions).values(<typeof issueThreadInteractions.$inferInsert>{
        companyId: t.companyId, issueId: t.issueId, kind: "request_confirmation", status: status as never,
        continuationPolicy: "wake_assignee", sourceRunId: runId, createdByAgentId: t.agentId,
        idempotencyKey: planReviewCardIdempotencyKey(plan!.latestRevisionId!),
        payload: { version: 1, prompt: "Approve plan revision 1?", acceptLabel: "Approve plan", rejectLabel: "Request changes",
          target: { type: "issue_document", issueId: t.issueId, documentId: plan!.id, key: "plan",
            revisionId: plan!.latestRevisionId, revisionNumber: 1 } },
        ...(resolved ? { resolvedAt: new Date(),
          resolvedByUserId: by === "user" ? "local-board" : null,
          resolvedByAgentId: by === "agent" ? t.agentId : null } : {}),
        ...(dismissed ? { dismissedAt: new Date(), dismissedByUserId: "local-board" } : {}),
      }).returning();
      if (laterComment) await db.insert(issueComments).values({ companyId: t.companyId, issueId: t.issueId, authorType: "user",
        authorUserId: "local-board", body: "Looking now.", createdAt: new Date(Date.now() + 1_000) });

      const first = await ensureNativePlanReviewCard(db, t.binding(runId));
      expect(first.kind).toBe(outcome);
      const again = await ensureNativePlanReviewCard(db, t.binding(await t.newRun()));
      expect(again.kind).toBe(outcome === "created" ? "pending" : outcome);
      const pending = (await t.cards()).filter(row => row.status === "pending");
      if (outcome === "reviewed") expect(pending).toHaveLength(0);
      else expect(pending).toHaveLength(1);
      if (outcome === "created") expect(pending[0]!.id).not.toBe(card!.id);
    });
  it("opens exactly one card for the current revision when settles race across a revision change", async () => {
    for (let round = 0; round < 15; round += 1) {
      const t = await seed();
      const first = await t.newRun();
      await t.writePlan(first);
      await ensureNativePlanReviewCard(db, t.binding(first));
      const second = await t.newRun();
      await t.writePlan(second, `${PLAN}\n3. Round ${round}.`);
      const runs = await Promise.all([t.newRun(), t.newRun(), t.newRun()]);

      await Promise.all([second, ...runs].map(runId => ensureNativePlanReviewCard(db, t.binding(runId))));

      const plan = await documentService(db).getIssueDocumentByKey(t.issueId, "plan");
      const pending = (await t.cards()).filter(card => card.status === "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.payload).toMatchObject({ target: { revisionId: plan!.latestRevisionId } });
    }
  });
});

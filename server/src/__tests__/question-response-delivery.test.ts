import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  goals,
  heartbeatRuns,
  issueQuestionResponseDeliveries,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  buildQuestionResponseDeliveryEnvelope,
  formatQuestionResponseSteeringMessage,
  questionResponseDeliveryService,
} from "../services/question-response-delivery.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const DIRECT_ADAPTER_TYPES = [
  "acpx_local",
  "claude_local",
  "codex_local",
  "cursor_cloud",
  "cursor",
  "gemini_local",
  "grok_local",
  "hermes_gateway",
  "hermes_local",
  "kimi_local",
  "openclaw_gateway",
  "opencode_local",
  "pi_local",
  "process",
  "http",
  "external_test_adapter",
] as const;

describeEmbeddedPostgres("question response delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-question-delivery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueQuestionResponseDeliveries);
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(args: {
    adapterType?: string;
    runtimeMode?: "legacy" | "native";
    sourceStatus?: string;
    successorStatus?: "queued" | "running";
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const successorRunId = args.successorStatus ? randomUUID() : null;
    await db.insert(companies).values({
      id: companyId,
      name: "Question delivery",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runner",
      role: "engineer",
      status: "active",
      adapterType: args.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(goals).values({ id: goalId, companyId, title: "Test", level: "task", status: "active" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Deliver answers",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: args.sourceStatus ?? "succeeded",
      runtimeMode: args.runtimeMode ?? "native",
      driverKind: "codex",
      contextSnapshot: { issueId },
      ...(args.sourceStatus === "running" ? { startedAt: new Date() } : { finishedAt: new Date() }),
    });
    if (successorRunId && args.successorStatus) {
      await db.insert(heartbeatRuns).values({
        id: successorRunId,
        companyId,
        agentId,
        invocationSource: "manual",
        status: args.successorStatus,
        runtimeMode: args.runtimeMode ?? "native",
        driverKind: "codex",
        contextSnapshot: { issueId },
        ...(args.successorStatus === "running" ? { startedAt: new Date() } : {}),
      });
    }

    const interactionSvc = issueThreadInteractionService(db);
    const interaction = await interactionSvc.create(
      { id: issueId, companyId },
      {
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        sourceRunId,
        payload: {
          version: 1,
          title: "Server choices",
          questions: [
            { id: "purpose", prompt: "What is it for?", selectionMode: "single", required: true, options: [{ id: "custom", label: "Write an answer", freeText: true }] },
            { id: "runtime", prompt: "Which runtime?", selectionMode: "single", required: true, options: [{ id: "node", label: "Node.js" }, { id: "bun", label: "Bun" }] },
            { id: "features", prompt: "Which features?", selectionMode: "multi", options: [{ id: "health", label: "Health check" }, { id: "logs", label: "Request logs" }] },
          ],
          questionSet: {
            schema: "paperclip.question_set.v1",
            title: "Server choices",
            questions: [
              { id: "purpose", header: "Purpose", prompt: "What is it for?", required: true, answerMode: "text" },
              { id: "runtime", header: "Runtime", prompt: "Which runtime?", required: true, answerMode: "single_select", options: [{ id: "node", label: "Node.js" }, { id: "bun", label: "Bun" }] },
              { id: "features", header: "Features", prompt: "Which features?", required: false, answerMode: "multi_select", options: [{ id: "health", label: "Health check" }, { id: "logs", label: "Request logs" }], customAnswer: { enabled: true, label: "Other" } },
            ],
          },
        },
      },
      { agentId, runId: sourceRunId },
    );
    const answered = await interactionSvc.answerQuestions(
      { id: issueId, companyId, status: "in_progress" },
      interaction.id,
      { answers: [
        { questionId: "purpose", optionIds: [], otherText: "Internal API" },
        { questionId: "runtime", optionIds: ["node"] },
        { questionId: "features", optionIds: ["health", "logs"], otherText: "Metrics" },
      ] },
      { userId: "board-user" },
    );
    return { companyId, agentId, issueId, sourceRunId, successorRunId, interaction: answered };
  }

  it("persists the receipt atomically and steers exactly once into a running successor", async () => {
    const seeded = await seed({ successorStatus: "running" });
    const newerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: newerRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "manual",
      status: "running",
      runtimeMode: "native",
      driverKind: "codex",
      contextSnapshot: { issueId: seeded.issueId },
      startedAt: new Date(),
    });
    await db.update(issues).set({ executionRunId: seeded.successorRunId })
      .where(eq(issues.id, seeded.issueId));
    const persistedBeforeDelivery = await db.select().from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.interactionId, seeded.interaction.id))
      .then((rows) => rows[0]);
    expect(persistedBeforeDelivery).toMatchObject({
      status: "pending",
      correlationId: `question-response:${seeded.interaction.id}`,
      sourceRunId: seeded.sourceRunId,
    });

    const steer = vi.fn().mockResolvedValue({ turnId: "turn-successor" });
    const wakeup = vi.fn();
    const service = questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer,
    });
    const first = await service.deliver(seeded.interaction.id);
    const second = await service.deliver(seeded.interaction.id);

    expect(first).toMatchObject({
      status: "delivered",
      mode: "steered",
      targetRunId: seeded.successorRunId,
      targetTurnId: "turn-successor",
      duplicate: false,
    });
    expect(second).toMatchObject({ mode: "steered", duplicate: true });
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({
      runId: seeded.successorRunId,
      correlationId: `question-response:${seeded.interaction.id}`,
      message: expect.stringContaining("- Runtime — Which runtime?: Node.js"),
    }));
    expect(wakeup).not.toHaveBeenCalled();

    const [delivery] = await db.select().from(issueQuestionResponseDeliveries);
    expect(delivery).toMatchObject({
      status: "delivered",
      deliveryMode: "steered",
      targetRunId: seeded.successorRunId,
      targetTurnId: "turn-successor",
      attemptCount: 1,
    });
    const deliveryEvents = await db.select().from(activityLog)
      .where(eq(activityLog.action, "issue.question_response_delivered"));
    expect(deliveryEvents).toHaveLength(1);
    expect(JSON.stringify(deliveryEvents[0]?.details)).not.toContain("Internal API");
    expect(JSON.stringify(deliveryEvents[0]?.details)).not.toContain("Node.js");
  });

  it("coalesces into a queued successor without creating another wake", async () => {
    const seeded = await seed({ successorStatus: "queued" });
    const successor = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.successorRunId!))
      .then((rows) => rows[0]!);
    const wakeup = vi.fn().mockResolvedValue(successor);
    const steer = vi.fn();
    const outcome = await questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer,
    }).deliver(seeded.interaction.id);

    expect(outcome).toMatchObject({ status: "delivered", mode: "coalesced", targetRunId: successor.id });
    expect(steer).not.toHaveBeenCalled();
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: `question-response:${seeded.interaction.id}`,
      contextSnapshot: {
        interactionId: seeded.interaction.id,
        interactionStatus: "answered",
      },
    });
  });

  it("never steers into the source run and keeps a skipped wake retryable", async () => {
    const seeded = await seed({ sourceStatus: "running" });
    const wakeup = vi.fn().mockResolvedValue(null);
    const steer = vi.fn();
    const outcome = await questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer,
    }).deliver(seeded.interaction.id);

    expect(outcome).toBeNull();
    expect(steer).not.toHaveBeenCalled();
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(wakeup.mock.calls[0])).not.toContain("Internal API");
    expect(JSON.stringify(wakeup.mock.calls[0])).not.toContain("Node.js");
    const [delivery] = await db.select().from(issueQuestionResponseDeliveries);
    expect(delivery).toMatchObject({
      status: "pending",
      attemptCount: 1,
      lastErrorCode: "question_response_wake_skipped",
    });
  });

  it("delivers after wake suppression outlasts the bounded error retry limit", async () => {
    const seeded = await seed({ sourceStatus: "running" });
    const fallbackRunId = randomUUID();
    let wakeAttempts = 0;
    const wakeup = vi.fn().mockImplementation(async () => {
      wakeAttempts += 1;
      if (wakeAttempts <= 5) return null;
      return db.insert(heartbeatRuns).values({
        id: fallbackRunId,
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        invocationSource: "automation",
        status: "queued",
        runtimeMode: "legacy",
        driverKind: "codex",
        contextSnapshot: { issueId: seeded.issueId },
      }).returning().then((rows) => rows[0]!);
    });
    const service = questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer: vi.fn(),
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.deliver(seeded.interaction.id)).resolves.toBeNull();
    }
    const delivered = await service.deliver(seeded.interaction.id);

    expect(delivered).toMatchObject({
      status: "fallback_queued",
      mode: "wake_fallback",
      targetRunId: fallbackRunId,
    });
    const [delivery] = await db.select().from(issueQuestionResponseDeliveries);
    expect(delivery).toMatchObject({
      status: "fallback_queued",
      attemptCount: 6,
      errorCount: 0,
      targetRunId: fallbackRunId,
    });
  });

  it("preserves the actual-error retry budget after prolonged wake suppression", async () => {
    const seeded = await seed({ sourceStatus: "running" });
    const fallbackRunId = randomUUID();
    let wakeAttempts = 0;
    const wakeup = vi.fn().mockImplementation(async () => {
      wakeAttempts += 1;
      if (wakeAttempts <= 5) return null;
      if (wakeAttempts === 6) throw new Error("scheduler temporarily unavailable");
      return db.insert(heartbeatRuns).values({
        id: fallbackRunId,
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        invocationSource: "automation",
        status: "queued",
        runtimeMode: "legacy",
        driverKind: "codex",
        contextSnapshot: { issueId: seeded.issueId },
      }).returning().then((rows) => rows[0]!);
    });
    const service = questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer: vi.fn(),
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.deliver(seeded.interaction.id)).resolves.toBeNull();
    }
    await expect(service.deliver(seeded.interaction.id)).resolves.toBeNull();
    const [afterError] = await db.select().from(issueQuestionResponseDeliveries);
    expect(afterError).toMatchObject({
      status: "pending",
      attemptCount: 6,
      errorCount: 1,
      lastErrorCode: "scheduler temporarily unavailable",
    });

    await expect(service.deliver(seeded.interaction.id)).resolves.toMatchObject({
      status: "fallback_queued",
      targetRunId: fallbackRunId,
    });
    const [delivered] = await db.select().from(issueQuestionResponseDeliveries);
    expect(delivered).toMatchObject({
      status: "fallback_queued",
      attemptCount: 7,
      errorCount: 1,
      targetRunId: fallbackRunId,
    });
  });

  it("enforces one durable wake per question-response idempotency key", async () => {
    const seeded = await seed({ sourceStatus: "running" });
    const idempotencyKey = `question-response:${seeded.interaction.id}`;
    const request = {
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      idempotencyKey,
    } as const;

    await db.insert(agentWakeupRequests).values({ ...request, status: "queued" });
    await expect(db.insert(agentWakeupRequests).values({
      ...request,
      status: "coalesced",
    })).rejects.toMatchObject({ cause: { code: "23505" } });

    // Suppression receipts are intentionally outside the fence so the outbox
    // can retry after scheduling is enabled again.
    await expect(db.insert(agentWakeupRequests).values({
      ...request,
      status: "skipped",
      finishedAt: new Date(),
    })).resolves.toBeDefined();
  });

  it("reuses the winning wake when a concurrent insert hits the idempotency fence", async () => {
    const seeded = await seed({ sourceStatus: "running" });
    const fallbackRunId = randomUUID();
    const wakeup = vi.fn().mockImplementation(async (
      _agentId: string,
      options: { idempotencyKey?: string | null },
    ) => {
      const request = {
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        idempotencyKey: options.idempotencyKey,
      } as const;
      const [winner] = await db.insert(agentWakeupRequests).values({
        ...request,
        status: "queued",
      }).returning();
      await db.insert(heartbeatRuns).values({
        id: fallbackRunId,
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        invocationSource: "automation",
        status: "queued",
        runtimeMode: "legacy",
        driverKind: "codex",
        wakeupRequestId: winner!.id,
        contextSnapshot: { issueId: seeded.issueId },
      });
      await db.update(agentWakeupRequests).set({ runId: fallbackRunId })
        .where(eq(agentWakeupRequests.id, winner!.id));

      // Model the losing claimant reaching the same transactional insert after
      // the winner commits. The service must recover the winner's receipt.
      await db.insert(agentWakeupRequests).values({
        ...request,
        status: "coalesced",
      });
      throw new Error("unreachable");
    });

    const outcome = await questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer: vi.fn(),
    }).deliver(seeded.interaction.id);

    expect(outcome).toMatchObject({
      status: "fallback_queued",
      mode: "wake_fallback",
      targetRunId: fallbackRunId,
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
    const [delivery] = await db.select().from(issueQuestionResponseDeliveries);
    expect(delivery).toMatchObject({
      status: "fallback_queued",
      attemptCount: 1,
      errorCount: 0,
      targetRunId: fallbackRunId,
    });
  });

  it("reuses a durable wake receipt instead of issuing a duplicate continuation", async () => {
    const seeded = await seed({ sourceStatus: "running" });
    const [wakeRequest] = await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      status: "queued",
      idempotencyKey: `question-response:${seeded.interaction.id}`,
    }).returning();
    const [wakeRun] = await db.insert(heartbeatRuns).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "automation",
      status: "queued",
      runtimeMode: "legacy",
      wakeupRequestId: wakeRequest!.id,
      contextSnapshot: { issueId: seeded.issueId },
    }).returning();
    await db.update(agentWakeupRequests).set({ runId: wakeRun!.id })
      .where(eq(agentWakeupRequests.id, wakeRequest!.id));
    const wakeup = vi.fn();

    const outcome = await questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer: vi.fn(),
    }).deliver(seeded.interaction.id);

    expect(outcome).toMatchObject({
      status: "delivered",
      mode: "coalesced",
      targetRunId: wakeRun!.id,
    });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("recovers a completed wake when receipt finalization was interrupted", async () => {
    const seeded = await seed({ sourceStatus: "running" });
    const [wakeRequest] = await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      status: "completed",
      idempotencyKey: `question-response:${seeded.interaction.id}`,
      finishedAt: new Date(),
    }).returning();
    const [wakeRun] = await db.insert(heartbeatRuns).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "automation",
      status: "succeeded",
      runtimeMode: "legacy",
      wakeupRequestId: wakeRequest!.id,
      contextSnapshot: { issueId: seeded.issueId },
      finishedAt: new Date(),
    }).returning();
    await db.update(agentWakeupRequests).set({ runId: wakeRun!.id })
      .where(eq(agentWakeupRequests.id, wakeRequest!.id));
    const wakeup = vi.fn();

    const outcome = await questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer: vi.fn(),
    }).deliver(seeded.interaction.id);

    expect(outcome).toMatchObject({
      status: "fallback_queued",
      mode: "wake_fallback",
      targetRunId: wakeRun!.id,
    });
    expect(wakeup).not.toHaveBeenCalled();
    const [delivery] = await db.select().from(issueQuestionResponseDeliveries);
    expect(delivery).toMatchObject({
      status: "fallback_queued",
      errorCount: 0,
      targetRunId: wakeRun!.id,
    });
  });

  it("keeps a long wake claim leased while the side effect is active", async () => {
    const seeded = await seed({ sourceStatus: "running" });
    // Each call gets its own resolver. A second, unexpected call fails at
    // once instead of sharing one resolver with the first call and hanging.
    const wakeResolvers: Array<(value: null) => void> = [];
    const wakeup = vi.fn(() => {
      if (wakeResolvers.length > 0) {
        throw new Error(
          "wakeup was invoked a second time for the same claim; a re-entrant delivery must fail at once, not hang",
        );
      }
      return new Promise<null>((resolve) => {
        wakeResolvers.push(resolve);
      });
    });

    // The renewal timer and the sweep both read time from this injected
    // clock. The test moves the clock by hand, so the assertions below do
    // not depend on the speed of a database round trip or a timer callback.
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const service = questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer: vi.fn(),
      now: () => clock,
      claimStaleMs: 40,
      claimRefreshMs: 5,
    });

    const deliveryPromise = service.deliver(seeded.interaction.id);
    await vi.waitFor(() => expect(wakeup).toHaveBeenCalledTimes(1));
    const [claimedRow] = await db.select().from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.interactionId, seeded.interaction.id));
    const claimedAt = claimedRow!.lastAttemptAt!.getTime();

    // Move the clock past claimStaleMs, then wait for a real renewal tick to
    // pick it up. This proves the renewal ran. It does not only assert that
    // a fixed real-time sleep was long enough.
    clock = new Date(clock.getTime() + 1000);
    await vi.waitFor(async () => {
      const [row] = await db.select().from(issueQuestionResponseDeliveries)
        .where(eq(issueQuestionResponseDeliveries.interactionId, seeded.interaction.id));
      expect(row?.lastAttemptAt?.getTime()).toBeGreaterThan(claimedAt);
    });

    await expect(service.sweepPending()).resolves.toMatchObject({ scanned: 0 });
    wakeResolvers[0]!(null);
    await expect(deliveryPromise).resolves.toBeNull();

    expect(wakeup).toHaveBeenCalledTimes(1);
    const [delivery] = await db.select().from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.interactionId, seeded.interaction.id));
    expect(delivery).toMatchObject({ status: "pending", attemptCount: 1 });
  });

  it("fences a stale worker after a newer claim generation takes ownership", async () => {
    const seeded = await seed({ sourceStatus: "running" });
    let releaseFirstWake!: (value: { id: string; driverKind: string }) => void;
    const firstWakeup = vi.fn(() => new Promise<{ id: string; driverKind: string }>((resolve) => {
      releaseFirstWake = resolve;
    }));
    const firstService = questionResponseDeliveryService(db, {
      heartbeat: { wakeup: firstWakeup } as never,
      steer: vi.fn(),
      claimStaleMs: 40,
      claimRefreshMs: 5,
    });

    const firstDelivery = firstService.deliver(seeded.interaction.id);
    await vi.waitFor(() => expect(firstWakeup).toHaveBeenCalledTimes(1));

    // Simulate recovery after the first worker stopped renewing. The next
    // claim increments attemptCount, which is the fencing generation.
    await db.update(issueQuestionResponseDeliveries).set({
      status: "pending",
      lastAttemptAt: new Date(0),
    }).where(eq(issueQuestionResponseDeliveries.interactionId, seeded.interaction.id));

    const secondRunId = randomUUID();
    const secondWakeup = vi.fn().mockImplementation(async () => db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "automation",
      status: "queued",
      runtimeMode: "legacy",
      driverKind: "codex",
      contextSnapshot: { issueId: seeded.issueId },
    }).returning().then((rows) => rows[0]!));
    const secondOutcome = await questionResponseDeliveryService(db, {
      heartbeat: { wakeup: secondWakeup } as never,
      steer: vi.fn(),
    }).deliver(seeded.interaction.id);

    expect(secondOutcome).toMatchObject({
      status: "fallback_queued",
      targetRunId: secondRunId,
      duplicate: false,
    });
    releaseFirstWake({ id: randomUUID(), driverKind: "codex" });
    await expect(firstDelivery).resolves.toMatchObject({
      status: "fallback_queued",
      targetRunId: secondRunId,
      duplicate: true,
    });

    const [delivery] = await db.select().from(issueQuestionResponseDeliveries);
    expect(delivery).toMatchObject({
      status: "fallback_queued",
      targetRunId: secondRunId,
      attemptCount: 2,
    });
    const deliveryEvents = await db.select().from(activityLog)
      .where(eq(activityLog.action, "issue.question_response_delivered"));
    expect(deliveryEvents).toHaveLength(1);
  });

  it.each(DIRECT_ADAPTER_TYPES)(
    "keeps %s on the existing wake path without invoking native steering",
    async (adapterType) => {
      const seeded = await seed({
        adapterType,
        runtimeMode: "legacy",
        successorStatus: "running",
      });
      const fallbackRunId = randomUUID();
      const wakeup = vi.fn().mockImplementation(async () => db.insert(heartbeatRuns).values({
        id: fallbackRunId,
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        invocationSource: "automation",
        status: "queued",
        runtimeMode: "legacy",
        contextSnapshot: { issueId: seeded.issueId },
      }).returning().then((rows) => rows[0]!));
      const steer = vi.fn();

      const outcome = await questionResponseDeliveryService(db, {
        heartbeat: { wakeup } as never,
        steer,
      }).deliver(seeded.interaction.id);

      expect(outcome).toMatchObject({
        status: "fallback_queued",
        mode: "wake_fallback",
        targetRunId: fallbackRunId,
      });
      expect(steer).not.toHaveBeenCalled();
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
        idempotencyKey: `question-response:${seeded.interaction.id}`,
        contextSnapshot: {
          issueId: seeded.issueId,
          interactionId: seeded.interaction.id,
          interactionStatus: "answered",
        },
      });
    },
  );

  it("falls back once when successor steering is unsupported", async () => {
    const seeded = await seed({ successorStatus: "running" });
    const fallbackRunId = randomUUID();
    const steer = vi.fn().mockRejectedValue(
      Object.assign(new Error("unsupported"), {
        code: "steering_unsupported",
      }),
    );
    const wakeup = vi.fn().mockImplementation(async () => db.insert(heartbeatRuns).values({
      id: fallbackRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "automation",
      status: "queued",
      driverKind: "codex",
      contextSnapshot: { issueId: seeded.issueId },
    }).returning().then((rows) => rows[0]!));
    const service = questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer,
    });
    const first = await service.deliver(seeded.interaction.id);
    const second = await service.deliver(seeded.interaction.id);

    expect(first).toMatchObject({ status: "fallback_queued", mode: "wake_fallback", targetRunId: fallbackRunId });
    expect(second?.duplicate).toBe(true);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("formats text, select labels, multi-select, and custom answers in order", async () => {
    const seeded = await seed();
    const envelope = buildQuestionResponseDeliveryEnvelope(seeded.interaction);
    expect(envelope.response).toEqual({
      schema: "paperclip.question_response.v1",
      answers: {
        purpose: { text: "Internal API" },
        runtime: { selectedOptionIds: ["node"] },
        features: { selectedOptionIds: ["health", "logs"], customText: "Metrics" },
      },
    });
    expect(formatQuestionResponseSteeringMessage(envelope)).toBe([
      "Answered questions",
      "",
      "- Purpose — What is it for?: Internal API",
      "- Runtime — Which runtime?: Node.js",
      "- Features — Which features?: Health check, Request logs, Metrics",
    ].join("\n"));
  });
});

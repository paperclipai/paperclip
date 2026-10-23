import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  goals,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
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
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.js";
import {
  buildQuestionResponseDeliveryEnvelope,
  formatQuestionResponseSteeringMessage,
  questionResponseDeliveryService,
} from "../services/question-response-delivery.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

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
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-question-delivery-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueQuestionResponseDeliveries);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
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

  async function seed(
    args: {
      adapterType?: string;
      runtimeMode?: "legacy" | "native";
      sourceStatus?: string;
      successorStatus?: "queued" | "running";
      sourceCommentBody?: string;
      attachSourceCommentToInteraction?: boolean;
    } = {},
  ) {
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
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Test",
      level: "task",
      status: "active",
    });
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
      ...(args.sourceStatus === "running"
        ? { startedAt: new Date() }
        : { finishedAt: new Date() }),
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
        ...(args.successorStatus === "running"
          ? { startedAt: new Date() }
          : {}),
      });
    }

    const sourceCommentId = args.sourceCommentBody ? randomUUID() : null;
    if (sourceCommentId) {
      await db.insert(issueComments).values({
        id: sourceCommentId,
        companyId,
        issueId,
        authorUserId: "external-user",
        body: args.sourceCommentBody!,
      });
    }

    const interactionSvc = issueThreadInteractionService(db);
    const interaction = await interactionSvc.create(
      { id: issueId, companyId },
      {
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        sourceCommentId:
          args.attachSourceCommentToInteraction === false
            ? null
            : sourceCommentId,
        sourceRunId,
        payload: {
          version: 1,
          title: "Server choices",
          questions: [
            {
              id: "purpose",
              prompt: "What is it for?",
              selectionMode: "single",
              required: true,
              options: [
                { id: "custom", label: "Write an answer", freeText: true },
              ],
            },
            {
              id: "runtime",
              prompt: "Which runtime?",
              selectionMode: "single",
              required: true,
              options: [
                { id: "node", label: "Node.js" },
                { id: "bun", label: "Bun" },
              ],
            },
            {
              id: "features",
              prompt: "Which features?",
              selectionMode: "multi",
              allowOther: true,
              options: [
                { id: "health", label: "Health check" },
                { id: "logs", label: "Request logs" },
              ],
            },
          ],
          questionSet: {
            schema: "paperclip.question_set.v1",
            title: "Server choices",
            questions: [
              {
                id: "purpose",
                header: "Purpose",
                prompt: "What is it for?",
                required: true,
                answerMode: "text",
              },
              {
                id: "runtime",
                header: "Runtime",
                prompt: "Which runtime?",
                required: true,
                answerMode: "single_select",
                options: [
                  { id: "node", label: "Node.js" },
                  { id: "bun", label: "Bun" },
                ],
              },
              {
                id: "features",
                header: "Features",
                prompt: "Which features?",
                required: false,
                answerMode: "multi_select",
                options: [
                  { id: "health", label: "Health check" },
                  { id: "logs", label: "Request logs" },
                ],
                customAnswer: { enabled: true, label: "Other" },
              },
            ],
          },
        },
      },
      { agentId, runId: sourceRunId },
    );
    const answered = await interactionSvc.answerQuestions(
      { id: issueId, companyId, status: "in_progress" },
      interaction.id,
      {
        answers: [
          { questionId: "purpose", optionIds: [], otherText: "Internal API" },
          { questionId: "runtime", optionIds: ["node"] },
          {
            questionId: "features",
            optionIds: ["health", "logs"],
            otherText: "Metrics",
          },
        ],
      },
      { userId: "board-user" },
    );
    return {
      companyId,
      agentId,
      issueId,
      sourceRunId,
      sourceCommentId,
      successorRunId,
      interaction: answered,
    };
  }

  it("queues an answer to a running successor instead of automatically steering", async () => {
    const seeded = await seed({ successorStatus: "running" });
    const steer = vi.fn().mockResolvedValue({ turnId: "unexpected" });
    const wakeup = vi.fn().mockImplementation(async () => {
      await db.insert(agentWakeupRequests).values({ companyId: seeded.companyId, agentId: seeded.agentId,
        source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
        idempotencyKey: `question-response:${seeded.interaction.id}`,
        payload: { issueId: seeded.issueId, mutation: "interaction", interactionId: seeded.interaction.id,
          interactionStatus: "answered" } });
      return null;
    });
    const service = questionResponseDeliveryService(db, { heartbeat: { wakeup } as never, steer });
    const first = await service.deliver(seeded.interaction.id);
    const second = await service.deliver(seeded.interaction.id);
    expect(steer).not.toHaveBeenCalled();
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(seeded.agentId, expect.objectContaining({
      payload: expect.objectContaining({ interactionId: seeded.interaction.id, interactionStatus: "answered" }),
    }));
    expect(first).toMatchObject({ status: "fallback_queued", mode: "wake_fallback" });
    expect(second).toMatchObject({ mode: "wake_fallback", duplicate: true });
  });

  it.each(["native", "legacy"] as const)(
    "never mixes an external-chat question response into another live chat run in %s mode",
    async (runtimeMode) => {
      const seeded = await seed({
        runtimeMode,
        sourceStatus: "running",
        successorStatus: "running",
        sourceCommentBody:
          "External request whose complete trailing instructions must survive the response continuation.",
        attachSourceCommentToInteraction: false,
      });
      if (!seeded.sourceCommentId) {
        throw new Error("Expected a source comment for the external-chat run");
      }
      expect(seeded.interaction.sourceCommentId).toBeNull();
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: {
            issueId: seeded.issueId,
            source: "chat:slack",
            commentId: seeded.sourceCommentId,
            wakeCommentId: seeded.sourceCommentId,
            wakeCommentIds: [seeded.sourceCommentId],
          },
        })
        .where(eq(heartbeatRuns.id, seeded.sourceRunId));
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: {
            issueId: seeded.issueId,
            source: "chat:telegram",
            wakeCommentId: randomUUID(),
          },
        })
        .where(eq(heartbeatRuns.id, seeded.successorRunId!));
      await db
        .update(issues)
        .set({ executionRunId: seeded.successorRunId })
        .where(eq(issues.id, seeded.issueId));

      const [dedicatedRun] = await db
        .insert(heartbeatRuns)
        .values({
          id: randomUUID(),
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          invocationSource: "automation",
          status: "queued",
          runtimeMode: "native",
          driverKind: "codex",
          contextSnapshot: {
            issueId: seeded.issueId,
            interactionId: seeded.interaction.id,
            sourceRunId: seeded.sourceRunId,
            source: "issue.interaction.respond",
          },
        })
        .returning();
      if (!dedicatedRun) throw new Error("Expected dedicated continuation run");
      const wakeup = vi.fn().mockResolvedValue(dedicatedRun);
      const cancelRun = vi.fn().mockResolvedValue({
        id: seeded.sourceRunId,
        status: "cancelled",
      });
      const steer = vi.fn();
      const resolveNativeQuestion = vi
        .fn()
        .mockResolvedValue("queued" as const);
      const outcome = await questionResponseDeliveryService(db, {
        heartbeat: { wakeup, cancelRun } as never,
        steer,
        resolveNativeQuestion,
      }).deliver(seeded.interaction.id);

      expect(resolveNativeQuestion).not.toHaveBeenCalled();
      expect(steer).not.toHaveBeenCalled();
      expect(cancelRun).toHaveBeenCalledWith(
        seeded.sourceRunId,
        "Superseded by a dedicated external-chat answer continuation",
        expect.objectContaining({
          errorCode: "external_chat_continuation",
          resultJson: expect.objectContaining({
            interactionId: seeded.interaction.id,
            externalChatContinuation: true,
          }),
          terminationGraceMs: 2_000,
        }),
      );
      expect(cancelRun.mock.invocationCallOrder[0]).toBeLessThan(
        wakeup.mock.invocationCallOrder[0]!,
      );
      expect(wakeup).toHaveBeenCalledWith(
        seeded.agentId,
        expect.objectContaining({
          allowRunCoalescing: false,
          idempotencyKey: `question-response:${seeded.interaction.id}`,
          payload: expect.objectContaining({
            externalChatContinuation: true,
            sourceCommentId: seeded.sourceCommentId,
            wakeCommentId: seeded.sourceCommentId,
            wakeCommentIds: [seeded.sourceCommentId],
          }),
          contextSnapshot: expect.objectContaining({
            externalChatContinuation: true,
            sourceCommentId: seeded.sourceCommentId,
            wakeCommentId: seeded.sourceCommentId,
            wakeCommentIds: [seeded.sourceCommentId],
          }),
        }),
      );
      expect(outcome).toMatchObject({
        status: "fallback_queued",
        mode: "wake_fallback",
        targetRunId: dedicatedRun.id,
      });
      expect(dedicatedRun.id).not.toBe(seeded.sourceRunId);
      const [delivery] = await db
        .select()
        .from(issueQuestionResponseDeliveries);
      expect(delivery).toMatchObject({
        lastErrorCode: "steering_external_chat_context_incompatible",
        targetRunId: dedicatedRun.id,
      });
    },
  );

  it("does not promote a source-run wake comment from another issue", async () => {
    const seeded = await seed();
    const goalId = await db
      .select({ goalId: issues.goalId })
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]?.goalId);
    if (!goalId) throw new Error("Expected source issue goal");
    const otherIssueId = randomUUID();
    const otherCommentId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: seeded.companyId,
      goalId,
      title: "Unrelated issue",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueComments).values({
      id: otherCommentId,
      companyId: seeded.companyId,
      issueId: otherIssueId,
      authorUserId: "external-user",
      body: "This other issue must remain outside the continuation.",
    });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId: seeded.issueId,
          source: "chat:slack",
          wakeCommentId: otherCommentId,
          wakeCommentIds: [otherCommentId],
        },
      })
      .where(eq(heartbeatRuns.id, seeded.sourceRunId));

    const fallbackRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: fallbackRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "automation",
      status: "queued",
      runtimeMode: "native",
      driverKind: "codex",
      contextSnapshot: {
        issueId: seeded.issueId,
        interactionId: seeded.interaction.id,
        source: "issue.interaction.respond",
      },
    });
    const wakeup = vi.fn().mockResolvedValue({
      id: fallbackRunId,
      driverKind: "codex",
    });
    const resolveNativeQuestion = vi.fn().mockResolvedValue("queued" as const);
    const outcome = await questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      resolveNativeQuestion,
    }).deliver(seeded.interaction.id);

    expect(resolveNativeQuestion).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      mode: "wake_fallback",
      targetRunId: fallbackRunId,
    });
    const wakeOptions = wakeup.mock.calls[0]?.[1];
    expect(wakeOptions?.payload).toMatchObject({ sourceCommentId: null });
    expect(wakeOptions?.payload).not.toHaveProperty("wakeCommentId");
    expect(wakeOptions?.payload).not.toHaveProperty("wakeCommentIds");
    expect(wakeOptions?.contextSnapshot).toMatchObject({
      sourceCommentId: null,
    });
    expect(wakeOptions?.contextSnapshot).not.toHaveProperty("wakeCommentId");
    expect(wakeOptions?.contextSnapshot).not.toHaveProperty("wakeCommentIds");
  });

  it("resolves an in-flight native input request before creating a continuation", async () => {
    const seeded = await seed({
      adapterType: "paperclip_runner",
      runtimeMode: "native",
      sourceStatus: "running",
    });
    const wakeup = vi.fn();
    const resolveNativeQuestion = vi.fn().mockResolvedValue("queued" as const);

    const outcome = await questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      resolveNativeQuestion,
    }).deliver(seeded.interaction.id);

    expect(outcome).toMatchObject({
      status: "delivered",
      mode: "steered",
      targetRunId: seeded.sourceRunId,
    });
    expect(resolveNativeQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        id: seeded.interaction.id,
        status: "answered",
      }),
    );
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("keeps native input delivery pending while its PRP session is unavailable", async () => {
    const seeded = await seed({
      adapterType: "paperclip_runner",
      runtimeMode: "native",
      sourceStatus: "running",
    });
    const wakeup = vi.fn();

    const outcome = await questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      resolveNativeQuestion: vi.fn().mockResolvedValue("pending" as const),
    }).deliver(seeded.interaction.id);

    expect(outcome).toBeNull();
    expect(wakeup).not.toHaveBeenCalled();
    const [delivery] = await db.select().from(issueQuestionResponseDeliveries);
    expect(delivery).toMatchObject({
      status: "pending",
      attemptCount: 1,
      errorCount: 0,
      lastErrorCode: "native_question_session_unavailable",
    });
  });

  it("coalesces into a queued successor without creating another wake", async () => {
    const seeded = await seed({ successorStatus: "queued" });
    const successor = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.successorRunId!))
      .then((rows) => rows[0]!);
    const wakeup = vi.fn().mockResolvedValue(successor);
    const steer = vi.fn();
    const outcome = await questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer,
    }).deliver(seeded.interaction.id);

    expect(outcome).toMatchObject({
      status: "delivered",
      mode: "coalesced",
      targetRunId: successor.id,
    });
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
      return db
        .insert(heartbeatRuns)
        .values({
          id: fallbackRunId,
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          invocationSource: "automation",
          status: "queued",
          runtimeMode: "legacy",
          driverKind: "codex",
          contextSnapshot: { issueId: seeded.issueId },
        })
        .returning()
        .then((rows) => rows[0]!);
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
      if (wakeAttempts === 6)
        throw new Error("scheduler temporarily unavailable");
      return db
        .insert(heartbeatRuns)
        .values({
          id: fallbackRunId,
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          invocationSource: "automation",
          status: "queued",
          runtimeMode: "legacy",
          driverKind: "codex",
          contextSnapshot: { issueId: seeded.issueId },
        })
        .returning()
        .then((rows) => rows[0]!);
    });
    const service = questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer: vi.fn(),
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.deliver(seeded.interaction.id)).resolves.toBeNull();
    }
    await expect(service.deliver(seeded.interaction.id)).resolves.toBeNull();
    const [afterError] = await db
      .select()
      .from(issueQuestionResponseDeliveries);
    expect(afterError).toMatchObject({
      status: "pending",
      attemptCount: 6,
      errorCount: 1,
      lastErrorCode: "scheduler temporarily unavailable",
    });

    await expect(service.deliver(seeded.interaction.id)).resolves.toMatchObject(
      {
        status: "fallback_queued",
        targetRunId: fallbackRunId,
      },
    );
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

    await db
      .insert(agentWakeupRequests)
      .values({ ...request, status: "queued" });
    await expect(
      db.insert(agentWakeupRequests).values({
        ...request,
        status: "coalesced",
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    // Suppression receipts are intentionally outside the fence so the outbox
    // can retry after scheduling is enabled again.
    await expect(
      db.insert(agentWakeupRequests).values({
        ...request,
        status: "skipped",
        finishedAt: new Date(),
      }),
    ).resolves.toBeDefined();
  });

  it("reuses the winning wake when a concurrent insert hits the idempotency fence", async () => {
    const seeded = await seed({ sourceStatus: "running" });
    const fallbackRunId = randomUUID();
    const wakeup = vi
      .fn()
      .mockImplementation(
        async (
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
          const [winner] = await db
            .insert(agentWakeupRequests)
            .values({
              ...request,
              status: "queued",
            })
            .returning();
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
          await db
            .update(agentWakeupRequests)
            .set({ runId: fallbackRunId })
            .where(eq(agentWakeupRequests.id, winner!.id));

          // Model the losing claimant reaching the same transactional insert after
          // the winner commits. The service must recover the winner's receipt.
          await db.insert(agentWakeupRequests).values({
            ...request,
            status: "coalesced",
          });
          throw new Error("unreachable");
        },
      );

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

  it("settles against a canonical wake from the previous assignee without retrying forever", async () => {
    const seeded = await seed({ sourceStatus: "running" });
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId: seeded.companyId,
      name: "Replacement runner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db
      .update(issues)
      .set({ assigneeAgentId: replacementAgentId })
      .where(eq(issues.id, seeded.issueId));
    await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      status: "queued",
      idempotencyKey: `question-response:${seeded.interaction.id}`,
    });
    const wakeup = vi.fn();

    const outcome = await questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer: vi.fn(),
    }).deliver(seeded.interaction.id);

    expect(wakeup).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: "fallback_queued",
      mode: "wake_fallback",
      targetRunId: null,
    });
    const [delivery] = await db.select().from(issueQuestionResponseDeliveries);
    expect(delivery).toMatchObject({
      status: "fallback_queued",
      attemptCount: 1,
      errorCount: 0,
    });
  });

  it("reuses a durable wake receipt instead of issuing a duplicate continuation", async () => {
    const seeded = await seed({ sourceStatus: "running" });
    const [wakeRequest] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        status: "queued",
        idempotencyKey: `question-response:${seeded.interaction.id}`,
      })
      .returning();
    const [wakeRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        invocationSource: "automation",
        status: "queued",
        runtimeMode: "legacy",
        wakeupRequestId: wakeRequest!.id,
        contextSnapshot: { issueId: seeded.issueId },
      })
      .returning();
    await db
      .update(agentWakeupRequests)
      .set({ runId: wakeRun!.id })
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
    const [wakeRequest] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        status: "completed",
        idempotencyKey: `question-response:${seeded.interaction.id}`,
        finishedAt: new Date(),
      })
      .returning();
    const [wakeRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        invocationSource: "automation",
        status: "succeeded",
        runtimeMode: "legacy",
        wakeupRequestId: wakeRequest!.id,
        contextSnapshot: { issueId: seeded.issueId },
        finishedAt: new Date(),
      })
      .returning();
    await db
      .update(agentWakeupRequests)
      .set({ runId: wakeRun!.id })
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
    const [claimedRow] = await db
      .select()
      .from(issueQuestionResponseDeliveries)
      .where(
        eq(
          issueQuestionResponseDeliveries.interactionId,
          seeded.interaction.id,
        ),
      );
    const claimedAt = claimedRow!.lastAttemptAt!.getTime();

    // Move the clock past claimStaleMs, then wait for a real renewal tick to
    // pick it up. This proves the renewal ran. It does not only assert that
    // a fixed real-time sleep was long enough.
    clock = new Date(clock.getTime() + 1000);
    await vi.waitFor(async () => {
      const [row] = await db
        .select()
        .from(issueQuestionResponseDeliveries)
        .where(
          eq(
            issueQuestionResponseDeliveries.interactionId,
            seeded.interaction.id,
          ),
        );
      expect(row?.lastAttemptAt?.getTime()).toBeGreaterThan(claimedAt);
    });

    await expect(service.sweepPending()).resolves.toMatchObject({ scanned: 0 });
    wakeResolvers[0]!(null);
    await expect(deliveryPromise).resolves.toBeNull();

    expect(wakeup).toHaveBeenCalledTimes(1);
    const [delivery] = await db
      .select()
      .from(issueQuestionResponseDeliveries)
      .where(
        eq(
          issueQuestionResponseDeliveries.interactionId,
          seeded.interaction.id,
        ),
      );
    expect(delivery).toMatchObject({ status: "pending", attemptCount: 1 });
  });

  it("fences a stale worker after a newer claim generation takes ownership", async () => {
    const seeded = await seed({ sourceStatus: "running" });
    let releaseFirstWake!: (value: { id: string; driverKind: string }) => void;
    const firstWakeup = vi.fn(
      () =>
        new Promise<{ id: string; driverKind: string }>((resolve) => {
          releaseFirstWake = resolve;
        }),
    );
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
    await db
      .update(issueQuestionResponseDeliveries)
      .set({
        status: "pending",
        lastAttemptAt: new Date(0),
      })
      .where(
        eq(
          issueQuestionResponseDeliveries.interactionId,
          seeded.interaction.id,
        ),
      );

    const secondRunId = randomUUID();
    const secondWakeup = vi.fn().mockImplementation(async () =>
      db
        .insert(heartbeatRuns)
        .values({
          id: secondRunId,
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          invocationSource: "automation",
          status: "queued",
          runtimeMode: "legacy",
          driverKind: "codex",
          contextSnapshot: { issueId: seeded.issueId },
        })
        .returning()
        .then((rows) => rows[0]!),
    );
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
    const deliveryEvents = await db
      .select()
      .from(activityLog)
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
      const wakeup = vi.fn().mockImplementation(async () =>
        db
          .insert(heartbeatRuns)
          .values({
            id: fallbackRunId,
            companyId: seeded.companyId,
            agentId: seeded.agentId,
            invocationSource: "automation",
            status: "queued",
            runtimeMode: "legacy",
            contextSnapshot: { issueId: seeded.issueId },
          })
          .returning()
          .then((rows) => rows[0]!),
      );
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

  describe("an answer on an issue no agent holds", () => {
    const HUMAN = "board-user";

    /**
     * The state an agent leaves after asking and reporting `in_review` on an issue whose
     * policy has a review stage for its human: `in_review`, the human assigned, no agent,
     * the asking agent the stage's return assignee. Built with the execution policy's own
     * transition so the shape is the real one.
     */
    async function parkWithReviewStage(seeded: { issueId: string; agentId: string }) {
      const policy = normalizeIssueExecutionPolicy({
        stages: [{ type: "review", participants: [{ type: "user", userId: HUMAN }] }],
      });
      const transition = applyIssueExecutionPolicyTransition({
        issue: { status: "in_progress", assigneeAgentId: seeded.agentId, assigneeUserId: null },
        policy,
        previousPolicy: null,
        requestedStatus: "in_review",
        requestedAssigneePatch: {},
        actor: { agentId: seeded.agentId, userId: null },
      });
      expect(transition.patch).toMatchObject({ assigneeUserId: HUMAN, assigneeAgentId: null });
      await db
        .update(issues)
        .set({
          status: "in_review",
          executionPolicy: policy as never,
          executionState: transition.patch.executionState as never,
          assigneeAgentId: null,
          assigneeUserId: HUMAN,
        })
        .where(eq(issues.id, seeded.issueId));
    }

    function queuedRunWakeup(seeded: { companyId: string; agentId: string; issueId: string }) {
      return vi.fn().mockImplementation(async () =>
        db
          .insert(heartbeatRuns)
          .values({
            companyId: seeded.companyId,
            agentId: seeded.agentId,
            invocationSource: "automation",
            status: "queued",
            driverKind: "codex",
            contextSnapshot: { issueId: seeded.issueId },
          })
          .returning()
          .then((rows) => rows[0]!),
      );
    }

    async function readIssue(issueId: string) {
      return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    }

    it("wakes the stage's return assignee when the issue waits on the human who answered", async () => {
      const seeded = await seed();
      await parkWithReviewStage(seeded);
      // No asker on record: the return assignee is the fallback target.
      await db
        .update(issueThreadInteractions)
        .set({ createdByAgentId: null })
        .where(eq(issueThreadInteractions.id, seeded.interaction.id));
      const wakeup = queuedRunWakeup(seeded);

      const outcome = await questionResponseDeliveryService(db, {
        heartbeat: { wakeup } as never,
      }).deliver(seeded.interaction.id);

      expect(outcome).toMatchObject({ status: "fallback_queued", mode: "wake_fallback" });
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(wakeup.mock.calls[0]?.[0]).toBe(seeded.agentId);
      expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
        reason: "issue_commented",
        contextSnapshot: { wakeReason: "issue_commented", interactionId: seeded.interaction.id },
      });
      const issue = await readIssue(seeded.issueId);
      expect(issue).toMatchObject({
        status: "in_progress",
        assigneeAgentId: seeded.agentId,
        assigneeUserId: null,
      });
      // The stage is returned the way the reviewer's own "request changes" returns it,
      // with the answerer's decision on record, not wiped.
      expect(issue.executionState).toMatchObject({ status: "changes_requested" });
      const [decision] = await db.select().from(issueExecutionDecisions);
      expect(decision).toMatchObject({
        issueId: seeded.issueId,
        outcome: "changes_requested",
        actorUserId: HUMAN,
      });
      expect((issue.executionState as Record<string, unknown>).lastDecisionId).toBe(decision!.id);
    });

    it("wakes the agent that asked when the issue was handed to a human with no stage", async () => {
      const seeded = await seed();
      await db
        .update(issues)
        .set({ status: "in_review", assigneeAgentId: null, assigneeUserId: HUMAN })
        .where(eq(issues.id, seeded.issueId));
      const wakeup = queuedRunWakeup(seeded);

      const outcome = await questionResponseDeliveryService(db, {
        heartbeat: { wakeup } as never,
      }).deliver(seeded.interaction.id);

      expect(outcome).toMatchObject({ status: "fallback_queued", mode: "wake_fallback" });
      expect(wakeup.mock.calls[0]?.[0]).toBe(seeded.agentId);
      expect(await readIssue(seeded.issueId)).toMatchObject({
        status: "in_progress",
        assigneeAgentId: seeded.agentId,
        assigneeUserId: null,
      });
    });

    it("still records the failure when no agent can be resolved", async () => {
      const seeded = await seed();
      await db
        .update(issues)
        .set({ status: "in_review", assigneeAgentId: null, assigneeUserId: HUMAN })
        .where(eq(issues.id, seeded.issueId));
      await db
        .update(issueThreadInteractions)
        .set({ createdByAgentId: null })
        .where(eq(issueThreadInteractions.id, seeded.interaction.id));
      const wakeup = vi.fn();

      const outcome = await questionResponseDeliveryService(db, {
        heartbeat: { wakeup } as never,
      }).deliver(seeded.interaction.id);

      expect(outcome).toMatchObject({ status: "failed" });
      expect(wakeup).not.toHaveBeenCalled();
      const [delivery] = await db.select().from(issueQuestionResponseDeliveries);
      expect(delivery?.lastErrorCode).toBe("question_response_target_unavailable");
      const failures = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.question_response_delivery_failed"));
      expect(failures).toHaveLength(1);
      expect(await readIssue(seeded.issueId)).toMatchObject({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: HUMAN,
      });
    });

    it("leaves a review stage that returns to an agent other than the one that asked", async () => {
      const seeded = await seed();
      await parkWithReviewStage(seeded);
      const otherAgentId = randomUUID();
      await db.insert(agents).values({
        id: otherAgentId,
        companyId: seeded.companyId,
        name: "Other runner",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db
        .update(issueThreadInteractions)
        .set({ createdByAgentId: otherAgentId })
        .where(eq(issueThreadInteractions.id, seeded.interaction.id));
      const before = await readIssue(seeded.issueId);
      const wakeup = vi.fn();

      const outcome = await questionResponseDeliveryService(db, {
        heartbeat: { wakeup } as never,
      }).deliver(seeded.interaction.id);

      // The stage waits on its reviewer; the saved answer waits with it.
      expect(outcome).toBeNull();
      expect(wakeup).not.toHaveBeenCalled();
      const [delivery] = await db.select().from(issueQuestionResponseDeliveries);
      expect(delivery).toMatchObject({
        status: "pending",
        errorCount: 0,
        lastErrorCode: "question_response_review_pending",
      });
      const after = await readIssue(seeded.issueId);
      expect(after).toMatchObject({ status: "in_review", assigneeAgentId: null, assigneeUserId: HUMAN });
      expect(after.executionState).toEqual(before.executionState);
      expect(await db.select().from(issueExecutionDecisions)).toHaveLength(0);
    });

    it("keeps the answer for retry while someone else holds the review stage, then delivers it", async () => {
      const seeded = await seed();
      await parkWithReviewStage(seeded);
      await db
        .update(issueThreadInteractions)
        .set({ resolvedByUserId: "someone-else" })
        .where(eq(issueThreadInteractions.id, seeded.interaction.id));
      const held = vi.fn();

      const first = await questionResponseDeliveryService(db, {
        heartbeat: { wakeup: held } as never,
      }).deliver(seeded.interaction.id);

      expect(first).toBeNull();
      expect(held).not.toHaveBeenCalled();
      const [waiting] = await db.select().from(issueQuestionResponseDeliveries);
      expect(waiting).toMatchObject({
        status: "pending",
        errorCount: 0,
        lastErrorCode: "question_response_review_pending",
      });
      expect(await readIssue(seeded.issueId)).toMatchObject({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: HUMAN,
      });

      // The reviewer requests changes: the stage returns the issue to the agent.
      const parked = await readIssue(seeded.issueId);
      const policy = normalizeIssueExecutionPolicy(parked.executionPolicy);
      const returned = applyIssueExecutionPolicyTransition({
        issue: parked,
        policy,
        previousPolicy: policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: null, userId: HUMAN },
        commentBody: "Please change this.",
      });
      await db
        .update(issues)
        .set({
          status: "in_progress",
          assigneeAgentId: returned.patch.assigneeAgentId as string,
          assigneeUserId: null,
          executionState: returned.patch.executionState as never,
        })
        .where(eq(issues.id, seeded.issueId));
      const wakeup = queuedRunWakeup(seeded);

      const second = await questionResponseDeliveryService(db, {
        heartbeat: { wakeup } as never,
      }).deliver(seeded.interaction.id);

      expect(second).toMatchObject({ status: "fallback_queued", mode: "wake_fallback" });
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(wakeup.mock.calls[0]?.[0]).toBe(seeded.agentId);
    });

    it("keeps the answer for retry when a human other than the answerer holds an unstaged issue", async () => {
      const seeded = await seed();
      await db
        .update(issues)
        .set({ status: "in_progress", assigneeAgentId: null, assigneeUserId: HUMAN })
        .where(eq(issues.id, seeded.issueId));
      await db
        .update(issueThreadInteractions)
        .set({ resolvedByUserId: "someone-else" })
        .where(eq(issueThreadInteractions.id, seeded.interaction.id));
      const wakeup = vi.fn();

      const outcome = await questionResponseDeliveryService(db, {
        heartbeat: { wakeup } as never,
      }).deliver(seeded.interaction.id);

      expect(outcome).toBeNull();
      expect(wakeup).not.toHaveBeenCalled();
      const [delivery] = await db.select().from(issueQuestionResponseDeliveries);
      expect(delivery).toMatchObject({
        status: "pending",
        errorCount: 0,
        lastErrorCode: "question_response_assignee_pending",
      });
      expect(await readIssue(seeded.issueId)).toMatchObject({
        status: "in_progress",
        assigneeAgentId: null,
        assigneeUserId: HUMAN,
      });
    });

    it("hands the issue back before a live native question session takes the answer", async () => {
      const seeded = await seed();
      await parkWithReviewStage(seeded);
      const resolveNativeQuestion = vi.fn().mockResolvedValue("queued" as const);
      const wakeup = vi.fn();

      const outcome = await questionResponseDeliveryService(db, {
        heartbeat: { wakeup } as never,
        resolveNativeQuestion,
      }).deliver(seeded.interaction.id);

      expect(outcome).toMatchObject({ status: "delivered", mode: "steered" });
      expect(resolveNativeQuestion).toHaveBeenCalledTimes(1);
      expect(wakeup).not.toHaveBeenCalled();
      const issue = await readIssue(seeded.issueId);
      expect(issue).toMatchObject({
        status: "in_progress",
        assigneeAgentId: seeded.agentId,
        assigneeUserId: null,
      });
      expect(issue.executionState).toMatchObject({ status: "changes_requested" });
      expect(await db.select().from(issueExecutionDecisions)).toHaveLength(1);
    });

    it("wakes the agent it handed the issue to when native delivery keeps failing", async () => {
      const seeded = await seed();
      await parkWithReviewStage(seeded);
      const resolveNativeQuestion = vi
        .fn()
        .mockRejectedValue(new Error("native_question_bridge_down"));
      const wakeup = queuedRunWakeup(seeded);
      const service = questionResponseDeliveryService(db, {
        heartbeat: { wakeup } as never,
        resolveNativeQuestion,
      });

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await expect(service.deliver(seeded.interaction.id)).resolves.toBeNull();
      }
      const last = await service.deliver(seeded.interaction.id);

      // The issue already went back to the agent, so the answer must follow it there
      // instead of failing with the human's issue in the agent's hands.
      expect(resolveNativeQuestion).toHaveBeenCalledTimes(5);
      expect(last).toMatchObject({ status: "fallback_queued", mode: "wake_fallback" });
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(wakeup.mock.calls[0]?.[0]).toBe(seeded.agentId);
      expect(await readIssue(seeded.issueId)).toMatchObject({
        status: "in_progress",
        assigneeAgentId: seeded.agentId,
        assigneeUserId: null,
      });
    });

    it("gives a newer answer its turn when an older held answer fills the sweep", async () => {
      const held = await seed();
      await db
        .update(issues)
        .set({ status: "in_progress", assigneeAgentId: null, assigneeUserId: HUMAN })
        .where(eq(issues.id, held.issueId));
      await db
        .update(issueThreadInteractions)
        .set({ resolvedByUserId: "someone-else" })
        .where(eq(issueThreadInteractions.id, held.interaction.id));
      const ready = await seed();
      const wakeup = queuedRunWakeup(ready);
      const service = questionResponseDeliveryService(db, {
        heartbeat: { wakeup } as never,
      });

      // A sweep of one: the older held answer takes the first slot, then must yield it.
      await service.sweepPending(1);
      await service.sweepPending(1);

      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(wakeup.mock.calls[0]?.[0]).toBe(ready.agentId);
      const deliveries = await db.select().from(issueQuestionResponseDeliveries);
      expect(
        deliveries.find((row) => row.interactionId === ready.interaction.id),
      ).toMatchObject({ status: "fallback_queued" });
      expect(
        deliveries.find((row) => row.interactionId === held.interaction.id),
      ).toMatchObject({ status: "pending", lastErrorCode: "question_response_assignee_pending" });
    });
  });

  it("queues once without probing successor steering", async () => {
    const seeded = await seed({ successorStatus: "running" });
    const fallbackRunId = randomUUID();
    const steer = vi.fn().mockRejectedValue(
      Object.assign(new Error("unsupported"), {
        code: "steering_unsupported",
      }),
    );
    const wakeup = vi.fn().mockImplementation(async () =>
      db
        .insert(heartbeatRuns)
        .values({
          id: fallbackRunId,
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          invocationSource: "automation",
          status: "queued",
          driverKind: "codex",
          contextSnapshot: { issueId: seeded.issueId },
        })
        .returning()
        .then((rows) => rows[0]!),
    );
    const service = questionResponseDeliveryService(db, {
      heartbeat: { wakeup } as never,
      steer,
    });
    const first = await service.deliver(seeded.interaction.id);
    const second = await service.deliver(seeded.interaction.id);

    expect(first).toMatchObject({
      status: "fallback_queued",
      mode: "wake_fallback",
      targetRunId: fallbackRunId,
    });
    expect(second?.duplicate).toBe(true);
    expect(steer).not.toHaveBeenCalled();
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
        features: {
          selectedOptionIds: ["health", "logs"],
          customText: "Metrics",
        },
      },
    });
    expect(formatQuestionResponseSteeringMessage(envelope)).toBe(
      [
        "Answered questions",
        "",
        "- Purpose — What is it for?: Internal API",
        "- Runtime — Which runtime?: Node.js",
        "- Features — Which features?: Health check, Request logs, Metrics",
      ].join("\n"),
    );
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueQuestionResponseDeliveries,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type { PrpEvent } from "@paperclipai/paperclip-runner";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import {
  deliverNativeQuestionResponse,
  flushNativeQuestionResponses,
  nativeQuestionBridgeInternals,
  nativeQuestionRunIdsToCancelForIssue,
  nativeQuestionRunToCancel,
  projectNativeRuntimeRequest,
  registerNativeQuestionCommandTarget,
  validateNativeQuestionResponseInput,
} from "./native-question-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping native question bridge tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("native question bridge", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let issueId: string;
  let agentId: string;
  let runId: string;
  let sessionId: string;
  let runnerInstanceId: string;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-question-");
    db = createDb(temporary.connectionString);
  }, 20_000);

  afterEach(async () => {
    nativeQuestionBridgeInternals.resetForTests();
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "issue_thread_interactions",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "issues",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => temporary?.cleanup());

  async function seed() {
    companyId = randomUUID();
    issueId = randomUUID();
    agentId = randomUUID();
    runId = randomUUID();
    sessionId = randomUUID();
    runnerInstanceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Native questions",
      issuePrefix: `NQ${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native Codex",
      adapterType: "paperclip_runner",
      status: "running",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Answer a native question",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeResolvedAt: new Date(),
      nativeIssueId: issueId,
      nativeSessionId: sessionId,
      runnerInstanceId,
      driverKind: "codex",
      contextSnapshot: { issueId },
    });
  }

  function runtimeRequestEvent(): PrpEvent {
    return {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "runtime-question-1",
      sourceSeq: 1,
      sourceInstanceId: runnerInstanceId,
      sourceKind: "runner",
      runId,
      normalizedSessionId: sessionId,
      turnId: "turn-1",
      itemId: "item-1",
      eventType: "runtime_request.created",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-25T18:00:00.000Z",
      payload: {
        request: {
          schema: "paperclip.runtime_request.v2",
          requestKind: "runtime",
          requestId: "request-1",
          type: "input",
          status: "pending",
          prompt: "Choose a deployment color",
          input: {
            schema: "paperclip.question_set.v1",
            title: "Deployment",
            questions: [{
              id: "color",
              prompt: "Which color?",
              required: true,
              answerMode: "single_select",
              options: [
                { id: "blue", label: "Blue" },
                { id: "green", label: "Green" },
              ],
            }],
          },
        },
      },
    };
  }

  function binding() {
    return {
      companyId,
      issueId,
      runId,
      agentId,
      normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerInstanceId,
      completionContractId: randomUUID(),
      completionContractSha256: `sha256:${"a".repeat(64)}`,
      completionContractRevision: "1",
      completionContractCriterionIds: [],
    };
  }

  it("materializes, validates, and durably resumes a provider-neutral question response", async () => {
    await seed();
    const interaction = await projectNativeRuntimeRequest({
      db,
      binding: binding(),
      event: runtimeRequestEvent(),
    });

    expect(interaction).toMatchObject({
      kind: "ask_user_questions",
      status: "pending",
      sourceRunId: runId,
      continuationPolicy: "none",
      effectiveResolverPolicy: "human_only",
      payload: {
        runtimeRequestId: "request-1",
        supersedeOnUserComment: false,
        questionSet: { schema: "paperclip.question_set.v1" },
        questions: [{
          id: "color",
          selectionMode: "single",
          allowOther: false,
          options: [{ id: "blue", label: "Blue" }, { id: "green", label: "Green" }],
        }],
      },
    });
    expect(await db.select().from(activityLog)).toHaveLength(1);

    const answer = { answers: [{ questionId: "color", optionIds: ["blue"] }] };
    validateNativeQuestionResponseInput(interaction!, answer);
    expect(() => validateNativeQuestionResponseInput(interaction!, {
      answers: [{ questionId: "color", optionIds: ["red"] }],
    })).toThrow(/unknown option red/);

    const answered = await issueThreadInteractionService(db).answerQuestions(
      { id: issueId, companyId, status: "in_progress" },
      interaction!.id,
      answer,
      { userId: "operator-1" },
    );
    const queueCommand = vi.fn(() => ({ commandId: "question", controllerSeq: 1 }));
    const release = registerNativeQuestionCommandTarget({
      binding: { companyId, issueId, runId, agentId },
      queueCommand,
    });

    await flushNativeQuestionResponses(db, runId);
    expect(queueCommand).toHaveBeenCalledWith(
      "request.resolve",
      {
        requestId: "request-1",
        response: {
          schema: "paperclip.question_response.v1",
          answers: { color: { selectedOptionIds: ["blue"] } },
        },
      },
      `question_${interaction!.id}`,
    );
    expect(queueCommand).toHaveBeenCalledTimes(1);
    const [delivery] = await db.select().from(issueQuestionResponseDeliveries);
    expect(delivery).toMatchObject({
      interactionId: interaction!.id,
      status: "delivered",
      deliveryMode: "steered",
      targetRunId: runId,
    });
    expect(answered.kind).toBe("ask_user_questions");
    if (answered.kind !== "ask_user_questions") throw new Error("expected question interaction");
    await expect(nativeQuestionRunToCancel(db, answered)).resolves.toBe(runId);
    release();
  });

  it("binds projection to the persisted native run and ignores legacy delivery", async () => {
    await seed();
    const mismatched = runtimeRequestEvent();
    mismatched.runId = randomUUID();
    await expect(projectNativeRuntimeRequest({ db, binding: binding(), event: mismatched }))
      .rejects.toThrow("native_runtime_request_binding_mismatch");

    const interaction = await projectNativeRuntimeRequest({
      db,
      binding: binding(),
      event: runtimeRequestEvent(),
    });
    const answered = await issueThreadInteractionService(db).answerQuestions(
      { id: issueId, companyId, status: "in_progress" },
      interaction!.id,
      { answers: [{ questionId: "color", optionIds: ["green"] }] },
      { userId: "operator-1" },
    );
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, runId));
    expect(answered.kind).toBe("ask_user_questions");
    if (answered.kind !== "ask_user_questions") throw new Error("expected question interaction");
    await expect(deliverNativeQuestionResponse(db, answered)).resolves.toBe("not_native");
    await expect(nativeQuestionRunToCancel(db, answered)).resolves.toBeNull();
  });

  it("does not duplicate the task card when the runner replays a request", async () => {
    await seed();
    const first = await projectNativeRuntimeRequest({ db, binding: binding(), event: runtimeRequestEvent() });
    const second = await projectNativeRuntimeRequest({ db, binding: binding(), event: runtimeRequestEvent() });
    expect(second?.id).toBe(first?.id);
    expect(await db.select().from(issueThreadInteractions)).toHaveLength(1);
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });

  it("identifies the active native run after its unanswered card expires", async () => {
    await seed();
    const interaction = await projectNativeRuntimeRequest({
      db,
      binding: binding(),
      event: runtimeRequestEvent(),
    });
    await db.update(issueThreadInteractions)
      .set({ status: "expired", resolvedAt: new Date() })
      .where(eq(issueThreadInteractions.id, interaction!.id));

    await expect(nativeQuestionRunIdsToCancelForIssue(db, { id: issueId, companyId }))
      .resolves.toEqual([runId]);
  });

  it("removes the UI-only marker from a canonical custom response", async () => {
    await seed();
    const event = runtimeRequestEvent();
    const request = event.payload.request as Record<string, unknown>;
    const input = request.input as Record<string, unknown>;
    input.questions = [{
      id: "color",
      prompt: "Which color?",
      required: true,
      answerMode: "single_select",
      options: [{ id: "blue", label: "Blue" }],
      customAnswer: { enabled: true, label: "Another color" },
    }];
    const interaction = await projectNativeRuntimeRequest({ db, binding: binding(), event });
    const answer = {
      answers: [{
        questionId: "color",
        optionIds: ["paperclip_custom_answer"],
        otherText: "purple",
      }],
    };
    validateNativeQuestionResponseInput(interaction!, answer);
    const answered = await issueThreadInteractionService(db).answerQuestions(
      { id: issueId, companyId, status: "in_progress" },
      interaction!.id,
      answer,
      { userId: "operator-1" },
    );
    expect(answered.kind).toBe("ask_user_questions");
    if (answered.kind !== "ask_user_questions") throw new Error("expected question interaction");

    const queueCommand = vi.fn(() => ({ commandId: "question", controllerSeq: 1 }));
    registerNativeQuestionCommandTarget({
      binding: { companyId, issueId, runId, agentId },
      queueCommand,
    });
    await expect(deliverNativeQuestionResponse(db, answered)).resolves.toBe("queued");
    expect(queueCommand).toHaveBeenCalledWith(
      "request.resolve",
      {
        requestId: "request-1",
        response: {
          schema: "paperclip.question_response.v1",
          answers: { color: { selectedOptionIds: [], customText: "purple" } },
        },
      },
      `question_${interaction!.id}`,
    );
  });
});

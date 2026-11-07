import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  materializeLegacyQuestionResponseWakeProjection,
  materializeNativeInteractionResponses,
  NativeInteractionBridgeError,
} from "../services/native-runtime/native-interaction-bridge.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

describe("native interaction bridge with closed interactions", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-closed-interaction-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Closed interaction", issuePrefix: "NCI" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Closed interaction agent",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue after a withdrawn request",
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });
  }, 30_000);

  afterAll(async () => temporary?.cleanup());

  it("projects withdrawn and cancelled interactions as closed without granting approval", async () => {
    const withdrawnConfirmationId = randomUUID();
    const withdrawnSuggestionId = randomUUID();
    const cancelledQuestionsId = randomUUID();
    const pendingConfirmationId = randomUUID();
    await db.insert(issueThreadInteractions).values([
      {
        id: withdrawnConfirmationId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: "Restore the credential?" },
      },
      {
        id: withdrawnSuggestionId,
        companyId,
        issueId,
        kind: "suggest_tasks",
        status: "pending",
        continuationPolicy: "wake_assignee",
        payload: { version: 1, tasks: [{ clientKey: "follow-up", title: "Follow up" }] },
      },
      {
        id: cancelledQuestionsId,
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          questions: [{
            id: "choice",
            prompt: "Which path?",
            selectionMode: "single",
            options: [{ id: "safe", label: "Safe" }],
          }],
        },
      },
      {
        id: pendingConfirmationId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        payload: { version: 1, prompt: "Still waiting?" },
      },
    ]);
    // Close them through the same service paths as the withdraw and cancel
    // routes, which then wake the assignee with the closed interaction id.
    const interactionSvc = issueThreadInteractionService(db);
    const issue = { id: issueId, companyId, status: "in_progress" };
    const boardActor = { userId: "board-user" };
    const withdrawnConfirmation = await interactionSvc.withdrawInteraction(
      issue, withdrawnConfirmationId, { reason: "No longer needed" }, boardActor);
    const withdrawnSuggestion = await interactionSvc.withdrawInteraction(
      issue, withdrawnSuggestionId, { reason: "No longer needed" }, boardActor);
    const cancelledQuestions = await interactionSvc.cancelQuestions(
      issue, cancelledQuestionsId, { reason: "Asked in another task" }, boardActor);
    expect([withdrawnConfirmation.status, withdrawnSuggestion.status, cancelledQuestions.status])
      .toEqual(["cancelled", "cancelled", "cancelled"]);

    const responses = await materializeNativeInteractionResponses({
      db,
      companyId,
      issueId,
      runId,
      agentId,
      interactionIds: [withdrawnConfirmationId, withdrawnSuggestionId, cancelledQuestionsId],
    });
    expect(responses).toHaveLength(3);
    expect(responses).toEqual(expect.arrayContaining([
      {
        interactionId: withdrawnConfirmationId,
        kind: "request_confirmation",
        response: {
          status: "cancelled",
          result: { version: 1, outcome: "withdrawn", reason: "No longer needed" },
        },
      },
      {
        interactionId: withdrawnSuggestionId,
        kind: "suggest_tasks",
        response: {
          status: "cancelled",
          result: { version: 1, outcome: "withdrawn", reason: "No longer needed" },
        },
      },
      {
        interactionId: cancelledQuestionsId,
        kind: "ask_user_questions",
        response: {
          status: "cancelled",
          result: expect.objectContaining({ cancelled: true, answers: [] }),
        },
      },
    ]));
    // A cancelled question carries no answers for the legacy wake prompt.
    await expect(materializeLegacyQuestionResponseWakeProjection({
      db,
      companyId,
      issueId,
      runId,
      agentId,
      interactionId: cancelledQuestionsId,
    })).resolves.toBeNull();
    // A still-open request remains unresolved; withdrawal does not relax that.
    const error = await materializeNativeInteractionResponses({
      db,
      companyId,
      issueId,
      runId,
      agentId,
      interactionIds: [pendingConfirmationId],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(NativeInteractionBridgeError);
    expect(error).toMatchObject({ code: "native_interaction_unresolved" });
  });
});

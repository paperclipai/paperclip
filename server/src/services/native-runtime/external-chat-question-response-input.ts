import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { NativeInteractionResponseEnvelope } from "../../vendor/paperclip-runner/index.js";
import {
  authorizeChatConversationForBoundRun,
  isExternalChatWaitAuthorizationContention,
  type ChatReuseBinding,
} from "./chat-attachment-reuse.js";
import { resolveExternalChatQuestionResponse } from "./external-chat-question-response.js";
import { materializeNativeInteractionResponses } from "./native-interaction-bridge.js";
import { isNativeRunnerOwnershipHeld } from "./native-runner-ownership.js";

/**
 * Capture a linearizable, current-authorized answer chain for one invocation.
 * No provider I/O occurs here; all locks are released before returning input.
 */
export async function materializeExternalChatQuestionResponseInput(input: {
  db: Db;
  binding: ChatReuseBinding;
  contextSnapshot: Record<string, unknown>;
}): Promise<NativeInteractionResponseEnvelope[]> {
  const { binding } = input;
  const attempt = () =>
    input.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const [issue] = await tx
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.id, binding.issueId),
            eq(issues.companyId, binding.companyId),
          ),
        )
        .for("update", { noWait: true });
      const [run] = await tx
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, binding.runId),
            eq(heartbeatRuns.companyId, binding.companyId),
            eq(heartbeatRuns.agentId, binding.agentId),
          ),
        )
        .for("update", { noWait: true });
      const [agent] = await tx
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.id, binding.agentId),
            eq(agents.companyId, binding.companyId),
          ),
        )
        .for("update", { noWait: true });
      if (
        !issue ||
        !run ||
        !agent ||
        !["in_progress", "in_review"].includes(issue.status) ||
        issue.assigneeAgentId !== binding.agentId ||
        issue.executionRunId !== binding.runId ||
        run.status !== "running" ||
        isNativeRunnerOwnershipHeld(run) ||
        (run.nativeIssueId !== null && run.nativeIssueId !== binding.issueId) ||
        ["paused", "terminated", "pending_approval", "error"].includes(
          agent.status,
        )
      ) {
        throw new Error("reviewed_chat_execution_binding_not_authorized");
      }
      const answer = await resolveExternalChatQuestionResponse(
        tx,
        binding,
        input.contextSnapshot,
        "nonblocking",
      );
      if (!answer)
        throw new Error("reviewed_chat_execution_binding_not_authorized");
      await authorizeChatConversationForBoundRun(
        tx,
        binding,
        input.contextSnapshot,
        "nonblocking",
      );
      const responses = await materializeNativeInteractionResponses({
        db: tx,
        companyId: binding.companyId,
        issueId: binding.issueId,
        runId: binding.runId,
        agentId: binding.agentId,
        interactionIds: answer.interactionIds,
      });
      if (
        responses.length !== answer.interactionIds.length ||
        responses.some(
          (response) =>
            response.kind !== "ask_user_questions" ||
            response.response.status !== "answered" ||
            !answer.interactionIds.includes(response.interactionId),
        )
      ) {
        throw new Error("external_chat_question_response_chain_incomplete");
      }
      return responses.sort(
        (left, right) =>
          answer.interactionIds.indexOf(left.interactionId) -
          answer.interactionIds.indexOf(right.interactionId),
      );
    });
  for (let index = 0; index < 51; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isExternalChatWaitAuthorizationContention(error)) throw error;
    }
    // Release every policy/data lock before retrying the entire snapshot.
    if (index < 50) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("external_chat_question_response_input_not_ready");
}

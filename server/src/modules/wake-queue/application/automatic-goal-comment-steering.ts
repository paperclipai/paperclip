import type { Issue, RunnerGoalProjection } from "@paperclipai/shared";

type AutomaticGoalCommentSteeringPorts = {
  readGoal(
    companyId: string,
    issueId: string,
    assigneeAgentId: string,
  ): Promise<{ goal: Pick<NonNullable<RunnerGoalProjection["goal"]>, "status"> | null; workingNow: boolean } | null>;
  queueCommand(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    type: "turn.steer";
    payload: { text: string };
    commandId: string;
  }): { runId: string; completion: Promise<unknown> } | null;
  reportCommandFailure(details: { err: unknown; issueId: string; commentId: string; runId: string }): void;
};

/** True only when the live runner acknowledges delivery of this saved comment. */
export function createAutomaticGoalCommentSteering(ports: AutomaticGoalCommentSteeringPorts) {
  return async function steerAutomaticGoalComment(
    issue: Pick<Issue, "id" | "companyId" | "assigneeAgentId" | "externalConversationState">,
    actor: { actorType: "agent" | "user"; actorId: string },
    comment: { id: string; body: string },
  ): Promise<boolean> {
    const agentId = issue.assigneeAgentId;
    // External conversation messages need the attributed boundary wake and return-thread receipt.
    if (!agentId || issue.externalConversationState || (actor.actorType === "agent" && actor.actorId === agentId)) {
      return false;
    }

    const goal = await ports.readGoal(issue.companyId, issue.id, agentId);
    if (goal?.goal?.status !== "active" || !goal.workingNow) return false;

    const command = ports.queueCommand({
      companyId: issue.companyId,
      issueId: issue.id,
      agentId,
      type: "turn.steer",
      payload: { text: comment.body },
      commandId: `goal_comment_${comment.id}`,
    });
    if (!command) return false;

    try {
      await command.completion;
      return true;
    } catch (err) {
      ports.reportCommandFailure({ err, issueId: issue.id, commentId: comment.id, runId: command.runId });
      return false;
    }
  };
}

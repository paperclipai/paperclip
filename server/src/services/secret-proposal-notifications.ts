import { logger } from "../middleware/logger.js";
import type { issueService } from "./issues.js";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "./issue-assignment-wakeup.js";

type ProposalResolutionNotification = {
  originIssueId: string | null;
  kind: string;
  proposedName: string | null;
  configPath: string | null;
};

type ProposalGroupMember = {
  configPath: string | null;
  status: string;
};

export async function notifySecretProposalResolution(input: {
  proposal: ProposalResolutionNotification;
  status: "approved" | "rejected";
  userId: string;
  reason?: string | null;
  // Every binding of a grouped ask, so one decision reports all of its outcomes.
  // Without them the comment names the anchor alone, and the agent that asked
  // about seven keys reads that its other six are still undecided.
  groupMembers?: ProposalGroupMember[];
  issues: Pick<ReturnType<typeof issueService>, "getById" | "addComment">;
  heartbeat: IssueAssignmentWakeupDeps;
}) {
  if (!input.proposal.originIssueId) return;
  try {
    const issue = await input.issues.getById(input.proposal.originIssueId);
    if (!issue) return;
    const grouped = (input.groupMembers?.length ?? 0) > 1;
    const subject = input.proposal.kind === "secret"
      ? `secret proposal \`${input.proposal.proposedName ?? "unnamed"}\``
      : grouped
        ? `binding proposal group of ${input.groupMembers!.length}`
        : `binding proposal \`${input.proposal.configPath ?? "unknown"}\``;
    const configPath = grouped
      ? `\n- Bindings:\n${input.groupMembers!
        .map((member) => `  - \`${member.configPath ?? "unknown"}\`: ${member.status}`)
        .join("\n")}\n- Verify: \`GET /api/agents/me/secrets\``
      : input.proposal.kind === "binding"
        ? `\n- New config path: \`${input.proposal.configPath ?? "unknown"}\`\n- Verify: \`GET /api/agents/me/secrets\``
        : "";
    const reason = input.reason ? `\n\nReason: ${input.reason}` : "";
    try {
      await input.issues.addComment(
        issue.id,
        `Secret proposal resolution\n\n- Proposal: ${subject}\n- Status: **${input.status}**${configPath}${reason}`,
        { userId: input.userId },
      );
    } catch (err) {
      logger.warn(
        { err, issueId: issue.id, proposalStatus: input.status },
        "failed to post secret proposal resolution comment",
      );
    }
    await queueIssueAssignmentWakeup({
      heartbeat: input.heartbeat,
      issue,
      reason: "secret_proposal_resolved",
      mutation: `secret_proposal_${input.status}`,
      contextSource: "secret.proposal.resolution",
      requestedByActorType: "user",
      requestedByActorId: input.userId,
    });
  } catch (err) {
    logger.warn(
      { err, issueId: input.proposal.originIssueId, proposalStatus: input.status },
      "failed to notify origin issue about secret proposal resolution",
    );
  }
}

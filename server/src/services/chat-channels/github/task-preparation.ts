import { agents, chatDeliveries, chatGitHubReviews } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { LOW_TRUST_REVIEW_PRESET, type GitHubReviewEventContext, type GitHubIssueEventContext, type GitHubReviewPolicy } from "@paperclipai/shared";
import type { DbOrTransaction, EndpointRow } from "../runtime-types.js";
import { githubManualMessagePrompt } from "../../chat-github-review-policy.js";

type AutomaticRequest = { context: GitHubReviewEventContext; revision: number; policy: GitHubReviewPolicy };
type IssueRequest = { context: GitHubIssueEventContext; revision: number; policy: GitHubReviewPolicy };
type ManualRequest = { policy: GitHubReviewPolicy; revision: number; event: "mention" | "comment" };

export function githubInboundTaskTitle(message: string, automatic: AutomaticRequest | undefined, issue: IssueRequest | undefined): string {
  return automatic ? `PR #${automatic.context.pullNumber}: ${automatic.context.title}`
    : issue ? `GitHub issue #${issue.context.issueNumber}: ${issue.context.title}` : message;
}

export function githubInboundCommentText(input: {
  manual: ManualRequest | undefined;
  repository: string;
  thread: string;
  sender: { id: string; login: string | null };
  message: string;
}): string {
  return input.manual ? githubManualMessagePrompt({
    event: input.manual.event, policy: input.manual.policy, repository: input.repository,
    thread: input.thread, sender: input.sender, message: input.message,
  }) : input.message.trim();
}

export async function githubAssignedAgentRequiresLowTrust(taskTx: DbOrTransaction, taskEndpoint: EndpointRow): Promise<boolean> {
  const [assignedAgentTrust] = await taskTx.select({ permissions: agents.permissions }).from(agents)
    .where(and(eq(agents.companyId, taskEndpoint.companyId), eq(agents.id, taskEndpoint.assignedAgentId)));
  return assignedAgentTrust?.permissions?.trustPreset === LOW_TRUST_REVIEW_PRESET;
}

export async function retainGitHubDeliveryAuthority(
  taskTx: DbOrTransaction, taskEndpoint: EndpointRow, deliveryId: string,
  linkedUserId: string | null, taskUserId: string | null,
): Promise<void> {
          const guest = !linkedUserId;
          await taskTx.update(chatDeliveries).set({ normalizedEvent: sql`${chatDeliveries.normalizedEvent} || ${JSON.stringify({ githubAuthority: { guest, botExternalId: taskEndpoint.botExternalId, responsibleUserId: taskUserId, sponsorUserId: guest ? taskEndpoint.sponsorUserId : null } })}::jsonb` }).where(eq(chatDeliveries.id, deliveryId));
}

export async function retainGitHubReviewReceipt(taskTx: DbOrTransaction, endpoint: EndpointRow, issueId: string, deliveryId: string, githubAutomatic: AutomaticRequest): Promise<void> {
          await taskTx.insert(chatGitHubReviews).values({
            companyId: endpoint.companyId, endpointId: endpoint.id, issueId: issueId,
            repositoryId: githubAutomatic.context.repositoryId, repository: githubAutomatic.context.repository,
            pullNumber: githubAutomatic.context.pullNumber, headSha: githubAutomatic.context.headSha,
            deliveryId: deliveryId, configurationRevision: githubAutomatic.revision,
            policySnapshot: githubAutomatic.policy, event: githubAutomatic.context, state: "queued",
          }).onConflictDoNothing();
}

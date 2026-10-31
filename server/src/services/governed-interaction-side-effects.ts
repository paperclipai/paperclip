import type { Db } from "@paperclipai/db";
import { HttpError, conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { AuthorizationActor } from "./authorization.js";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import type { issueService } from "./issues.js";
import type { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { notifySecretProposalResolution } from "./secret-proposal-notifications.js";
import { assertCanResolveProposal } from "./secret-proposal-authorization.js";
import { createSecretProposalsService } from "./secret-proposals.js";

type SecretProposalInteraction = {
  id: string;
  kind: string;
  status: string;
  continuationPolicy: string;
  sourceCommentId?: string | null;
  sourceRunId?: string | null;
  payload?: unknown;
  result?: unknown;
};

type SecretProposalExecutionDisposition =
  | "not_applicable"
  | "already_terminal"
  | "executed"
  | "failed";

export type ApproveInteractionSecretProposal = (input: {
  companyId: string;
  issueId: string;
  interactionId: string;
  proposalId: string;
  cascade: true;
  actor: { agentId?: string | null; userId?: string | null };
}) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readSecretProposalInteractionContext(interaction: SecretProposalInteraction) {
  if (interaction.kind !== "request_confirmation") return null;
  const payload = asRecord(interaction.payload);
  const proposal = asRecord(payload.secretProposal);
  const proposalId = readNonEmptyString(proposal.proposalId);
  const configPath = readNonEmptyString(proposal.configPath);
  if (!proposalId || !configPath) return null;
  return {
    proposalId,
    configPath,
    sourceSecretLabel: readNonEmptyString(proposal.sourceSecretLabel),
  };
}

export function readSecretProposalContinuationContext(interaction: SecretProposalInteraction) {
  const proposal = readSecretProposalInteractionContext(interaction);
  if (!proposal) return null;
  const result = asRecord(interaction.result);
  const execution = asRecord(result.secretProposal);
  const executionStatus = readNonEmptyString(execution.status);
  const errorCode = readNonEmptyString(execution.errorCode);

  if (interaction.status === "rejected") {
    return {
      proposalId: proposal.proposalId,
      configPath: proposal.configPath,
      decision: "rejected",
      executionStatus: "rejected",
      instructions: "the secret binding proposal was rejected; do not assume the alias exists.",
    };
  }
  if (interaction.status !== "accepted" || (executionStatus !== "executed" && executionStatus !== "failed")) {
    return null;
  }
  if (executionStatus === "executed") {
    return {
      proposalId: proposal.proposalId,
      configPath: proposal.configPath,
      decision: "accepted",
      executionStatus,
      ...(proposal.sourceSecretLabel ? { sourceSecretLabel: proposal.sourceSecretLabel } : {}),
      instructions: `the binding was created at ${proposal.configPath}; verify it with GET /api/agents/me/secrets before using it.`,
    };
  }
  return {
    proposalId: proposal.proposalId,
    configPath: proposal.configPath,
    decision: "accepted",
    executionStatus,
    ...(errorCode ? { errorCode } : {}),
    instructions: "the binding was not created; inspect the failure comment and submit a fresh proposal after fixing the cause.",
  };
}

function executionErrorCode(error: unknown) {
  if (error instanceof HttpError) {
    const details = asRecord(error.details);
    return readNonEmptyString(details.code) ?? `http_${error.status}`;
  }
  return "secret_proposal_execution_failed";
}

function isAuthorizationDenial(error: unknown) {
  if (!(error instanceof HttpError) || error.status !== 403) return false;
  const reason = readNonEmptyString(asRecord(error.details).reason);
  return reason?.startsWith("deny_") ?? false;
}

/**
 * Executes the governed effect behind an accepted secret-binding card.
 *
 * The interaction resolution and the governed effect intentionally remain
 * separate authorization boundaries. This executor is the single server-owned
 * effect path for HTTP and plugin/gateway resolvers. It is replay-safe:
 * terminal receipts are no-ops, while an approved binding that lost its receipt
 * is reconciled to `executed` without creating another secret or binding.
 */
export async function executeAcceptedSecretProposalInteraction(input: {
  db: Db;
  issue: { id: string; companyId: string };
  interaction: SecretProposalInteraction;
  authorizationActor: AuthorizationActor;
  resolvedByUserId: string;
  actor: { agentId?: string | null; userId?: string | null };
  interactions: Pick<ReturnType<typeof issueThreadInteractionService>, "recordSecretProposalExecutionResult">;
  issues: Pick<ReturnType<typeof issueService>, "getById" | "addComment">;
  heartbeat: IssueAssignmentWakeupDeps;
  approveSecretProposal?: ApproveInteractionSecretProposal;
}): Promise<{
  interaction: SecretProposalInteraction;
  disposition: SecretProposalExecutionDisposition;
}> {
  const context = readSecretProposalInteractionContext(input.interaction);
  if (!context || input.interaction.status !== "accepted") {
    return { interaction: input.interaction, disposition: "not_applicable" };
  }

  const receipt = asRecord(asRecord(input.interaction.result).secretProposal);
  if (receipt.status === "executed" || receipt.status === "failed") {
    return { interaction: input.interaction, disposition: "already_terminal" };
  }

  const proposals = createSecretProposalsService(input.db);
  let approvedProposalForNotification: {
    originIssueId: string | null;
    kind: string;
    proposedName: string | null;
    configPath: string | null;
  } | null = null;
  try {
    if (input.approveSecretProposal) {
      await input.approveSecretProposal({
        companyId: input.issue.companyId,
        issueId: input.issue.id,
        interactionId: input.interaction.id,
        proposalId: context.proposalId,
        cascade: true,
        actor: input.actor,
      });
    } else {
      const proposal = await proposals.getById(input.issue.companyId, context.proposalId);
      if (
        !proposal
        || proposal.kind !== "binding"
        || proposal.originIssueId !== input.issue.id
        || proposal.interactionId !== input.interaction.id
      ) {
        throw notFound("Secret proposal not found");
      }

      const alreadyApplied = proposal.status === "approved"
        && proposal.appliedBindingConfigPath === context.configPath;
      if (!alreadyApplied) {
        if (proposal.status !== "pending") {
          throw conflict("Secret binding proposal is not pending or applied");
        }
        await proposals.approve(input.issue.companyId, proposal.id, {
          resolvedByUserId: input.resolvedByUserId,
          cascade: true,
          assertCanResolve: (lockedProposal, txDb) => assertCanResolveProposal({
            db: txDb,
            actor: input.authorizationActor,
            companyId: input.issue.companyId,
            proposal: lockedProposal,
          }),
        });
        approvedProposalForNotification = proposal;
      }
    }

    const interaction = await input.interactions.recordSecretProposalExecutionResult(
      input.issue,
      input.interaction.id,
      context.proposalId,
      { status: "executed" },
    );
    if (approvedProposalForNotification) {
      await notifySecretProposalResolution({
        proposal: approvedProposalForNotification,
        status: "approved",
        userId: input.resolvedByUserId,
        issues: input.issues,
        heartbeat: input.heartbeat,
      });
    }
    return { interaction, disposition: "executed" };
  } catch (error) {
    // An unauthorized resolver must not be able to poison a card that an
    // authorized human already accepted. Approval authorization runs before
    // the transaction mutates the proposal, so preserve the missing receipt
    // and let a properly granted human reconcile it later.
    if (isAuthorizationDenial(error)) throw error;

    const errorCode = executionErrorCode(error);
    const interaction = await input.interactions.recordSecretProposalExecutionResult(
      input.issue,
      input.interaction.id,
      context.proposalId,
      { status: "failed", errorCode },
    );
    const recordedReceipt = asRecord(asRecord(interaction.result).secretProposal);
    if (recordedReceipt.status !== "executed") {
      // Only the binding proposal becomes terminal here. Its source-secret
      // proposal intentionally remains pending so a corrected binding proposal
      // can reuse it without asking for the secret value again.
      try {
        await input.issues.addComment(
          input.issue.id,
          `Secret binding execution failed\n\n- Config path: \`${context.configPath}\`\n- Error code: \`${errorCode}\`\n- Binding created: **no**`,
          { userId: input.resolvedByUserId },
        );
      } catch (commentError) {
        logger.warn(
          { err: commentError, issueId: input.issue.id, interactionId: input.interaction.id, errorCode },
          "failed to post secret proposal execution failure comment",
        );
      }
    }
    return {
      interaction,
      disposition: recordedReceipt.status === "executed" ? "executed" : "failed",
    };
  }
}

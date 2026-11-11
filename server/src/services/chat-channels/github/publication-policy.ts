import { createReceiptReactions } from "../receipt-reactions.js";

import type { EndpointRow, DbOrTransaction, RuntimeContext } from "../runtime-types.js";
import { createChatFailedRunRetry } from "../failed-run-retry.js";
import { createChatPublicationReplacement } from "../publication-replacement.js";

import { notifyChatPublicationWork } from "../../chat-work-notifications.js";

import { type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import { chatGitHubConfigurations } from "@paperclipai/db";

import { githubResponseCommentService } from "../../chat-github-response-comments.js";

import {
  createHash,
} from "node:crypto";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatPublications,
  heartbeatRuns,
  nativeRunFinalizations,
  issueComments,
} from "@paperclipai/db";
import type {
  SafeChatPublicationPayload,
} from "@paperclipai/shared";

import {
  NativeChatReviewPresentationContentionError,
} from "../../native-runtime/native-chat-review-presentation.js";
import { isExternalChatWaitAuthorizationContention } from "../../native-runtime/chat-attachment-reuse.js";

import { safeChatTaskUrl } from "../../chat-task-url.js";

import {
  githubRunReplyState,
} from "../../chat-run-publications.js";

import type { EndpointRecord } from "../runtime-types.js";

type GitHubPublicationPolicyOptions = {
  isExplicitOperatorPublication: (publication: typeof chatPublications.$inferSelect) => boolean;
  getTaskBaseUrl: () => string | null | undefined;
  failedChatRetrySource: ReturnType<typeof createChatFailedRunRetry>["failedChatRetrySource"];
  isExternalActionAuthorizationChange: (error: unknown) => boolean;
  FailedChatRetryPublicationReadError: ReturnType<typeof createChatFailedRunRetry>["FailedChatRetryPublicationReadError"];
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  runIdFromMilestonePublication: ReturnType<typeof createChatPublicationReplacement>["runIdFromMilestonePublication"];
  fetchImpl: typeof fetch;
  stageTerminalReceiptReactionRemovals: (tx: Db, input: { endpoint: EndpointRow; publication: typeof chatPublications.$inferSelect; payload: SafeChatPublicationPayload; runtimeContext: RuntimeContext; closedProgressRunId?: string }) => Promise<string[]>;
  runtimeContextForRecord: (record: EndpointRecord) => RuntimeContext;
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  processReceiptReaction: ReturnType<typeof createReceiptReactions>["processReceiptReaction"];
};

export function createGitHubPublicationPolicy(db: Db, options: GitHubPublicationPolicyOptions) {
  const { isExplicitOperatorPublication, getTaskBaseUrl, failedChatRetrySource, isExternalActionAuthorizationChange, FailedChatRetryPublicationReadError, endpointRecord, runIdFromMilestonePublication, fetchImpl, stageTerminalReceiptReactionRemovals, runtimeContextForRecord, scheduleMessageProcessing, processReceiptReaction } = options;


  /** Add navigation only from the exact accepted native input batch. The
   * omission text/model response is not authority, nor is an older task file. */
  async function githubCurrentOmissionPreparedText(
    tx: DbOrTransaction,
    publication: typeof chatPublications.$inferSelect,
    endpoint: EndpointRow,
  ): Promise<string | null | false> {
    if (endpoint.provider !== "github") return null;
    const preparationKey = `github-omission-navigation:${publication.id}`;
    const [prepared] = await tx
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, publication.companyId),
          eq(chatActions.endpointId, publication.endpointId),
          eq(chatActions.conversationId, publication.conversationId),
          eq(chatActions.providerActionId, preparationKey),
        ),
      )
      .limit(1);
    // A prepared final cannot become a different kind of publication while
    // retaining the decorated body. Check its receipt before these exclusions.
    if (
      !publication.commentId ||
      publication.payload.progressState !== undefined ||
      publication.payload.interactionId ||
      publication.payload.card ||
      publication.payload.attachmentIds?.length ||
      publication.payload.transportPart ||
      publication.idempotencyKey.startsWith("control:") ||
      isExplicitOperatorPublication(publication)
    )
      return prepared ? false : null;
    const taskUrl = prepared
      ? typeof prepared.payload.taskUrl === "string"
        ? safeChatTaskUrl(prepared.payload.taskUrl, publication.issueId)
        : null
      : safeChatTaskUrl(getTaskBaseUrl(), publication.issueId);
    if (
      prepared &&
      (prepared.kind !== "github_omission_navigation" ||
        prepared.status !== "processed" ||
        prepared.payload.version !== 1 ||
        prepared.payload.publicationId !== publication.id ||
        taskUrl !== prepared.payload.taskUrl ||
        prepared.payload.preparedTextSha256 !==
          createHash("sha256").update(publication.payload.text).digest("hex"))
    )
      return false;
    if (!taskUrl) return prepared ? false : null;
    const [origin] = await tx
      .select({ run: heartbeatRuns, resultId: nativeRunFinalizations.resultId })
      .from(issueComments)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issueComments.createdByRunId),
          eq(heartbeatRuns.companyId, publication.companyId),
          eq(heartbeatRuns.nativeIssueId, publication.issueId),
          eq(heartbeatRuns.agentId, endpoint.assignedAgentId),
          eq(heartbeatRuns.runtimeMode, "native"),
          eq(heartbeatRuns.status, "succeeded"),
          isNotNull(heartbeatRuns.finishedAt),
        ),
      )
      .innerJoin(
        nativeRunFinalizations,
        and(
          eq(nativeRunFinalizations.companyId, publication.companyId),
          eq(nativeRunFinalizations.issueId, publication.issueId),
          eq(nativeRunFinalizations.runId, heartbeatRuns.id),
          eq(nativeRunFinalizations.phase, "committed"),
        ),
      )
      .where(
        and(
          eq(issueComments.id, publication.commentId),
          eq(issueComments.companyId, publication.companyId),
          eq(issueComments.issueId, publication.issueId),
          eq(issueComments.authorAgentId, endpoint.assignedAgentId),
          isNull(issueComments.deletedAt),
        ),
      )
      .limit(1);
    const presentation = origin?.run.resultJson?.presentationDecision as
      Record<string, unknown> | undefined;
    if (!origin?.resultId || presentation?.commentId !== publication.commentId)
      return prepared ? false : null;
    if (
      prepared &&
      (prepared.payload.runId !== origin.run.id ||
        prepared.payload.resultId !== origin.resultId)
    )
      return false;
    try {
      // This existing publication proof includes the accepted response_wake
      // result, immutable owner/coalesced receipts, every current source,
      // runtime/generation, source edits/deletes and current principal access.
      const source = await failedChatRetrySource(tx, {
        companyId: publication.companyId,
        issueId: publication.issueId,
        agentId: origin.run.agentId,
        failedRunId: origin.run.id,
        publication: true,
        committedResponse: { resultId: origin.resultId },
      });
      if (
        source.endpointId !== endpoint.id ||
        source.conversationId !== publication.conversationId
      )
        return prepared ? false : null;
      const omitted = source.sources.some((entry) => {
        const count = (
          entry.omissionReasons as Record<string, unknown> | undefined
        )?.download_unavailable;
        return (
          typeof count === "number" && Number.isSafeInteger(count) && count > 0
        );
      });
      if (!omitted) return prepared ? false : null;
      if (prepared) return publication.payload.text;
      const text = publication.payload.text.includes(taskUrl)
        ? publication.payload.text
        : `${publication.payload.text}\n\n[Open this Paperclip task](${taskUrl})`;
      await tx.insert(chatActions).values({
        companyId: publication.companyId,
        endpointId: publication.endpointId,
        conversationId: publication.conversationId,
        kind: "github_omission_navigation",
        providerActionId: preparationKey,
        status: "processed",
        payload: {
          version: 1,
          publicationId: publication.id,
          runId: origin.run.id,
          resultId: origin.resultId,
          taskUrl,
          preparedTextSha256: createHash("sha256").update(text).digest("hex"),
        },
      });
      return text;
    } catch (error) {
      if (
        isExternalChatWaitAuthorizationContention(error) ||
        error instanceof NativeChatReviewPresentationContentionError
      )
        throw new NativeChatReviewPresentationContentionError();
      if (
        isExternalActionAuthorizationChange(error) ||
        (error &&
          typeof error === "object" &&
          "details" in error &&
          error.details &&
          typeof error.details === "object" &&
          "code" in error.details &&
          error.details.code === "chat_failed_run_retry_not_authorized")
      )
        return prepared ? false : null;
      throw new FailedChatRetryPublicationReadError();
    }
  }

  async function settleGitHubAutomaticPublication(
    publication: typeof chatPublications.$inferSelect,
    guard?: CredentialMutationLeaseGuard,
  ): Promise<boolean> {
    if (isExplicitOperatorPublication(publication) || publication.payload.interactionId) return false;
    const record = await endpointRecord(publication.endpointId);
    if (!record || record.endpoint.provider !== "github" || record.endpoint.companyId !== publication.companyId) return false;
    // Legacy connections cannot use the replacement task-scoped tools yet.
    const [configuration] = await db.select({ endpointId: chatGitHubConfigurations.endpointId })
      .from(chatGitHubConfigurations).where(and(
        eq(chatGitHubConfigurations.companyId, publication.companyId),
        eq(chatGitHubConfigurations.endpointId, publication.endpointId),
      )).limit(1);
    if (!configuration) return false;
    let runId = runIdFromMilestonePublication(publication);
    if (!publication.payload.progressState) {
      // Also settle automatic agent comments retained from an older instance
      // version, and per-destination finals from a mixed-provider origin.
      if (!publication.commentId || !publication.idempotencyKey.startsWith("comment:")) return false;
      const [comment] = await db.select({ runId: issueComments.createdByRunId }).from(issueComments)
        .where(and(eq(issueComments.id, publication.commentId), eq(issueComments.companyId, publication.companyId),
          eq(issueComments.issueId, publication.issueId), eq(issueComments.authorType, "agent")));
      if (!comment) return false;
      runId = comment.runId;
    }
    if (["failed", "completed"].includes(publication.payload.progressState ?? "") && runId) {
      const reply = await githubRunReplyState(db, {
        companyId: publication.companyId, endpointId: publication.endpointId, issueId: publication.issueId, runId,
      });
      // A pending or ambiguous write may already have arrived. Suppress the
      // fallback without changing the governed outbox that owns that effect.
      if (reply === "unsettled") {
        // Quarantine only the automatic fallback. The governed tool outbox
        // retains the uncertain write; ordinary board messages and question
        // cards must not wait behind this notice in the conversation FIFO.
        await db.transaction(async tx => {
          await guard?.assertOwned(tx);
          await notifyChatPublicationWork(tx);
          await tx.update(chatPublications).set({ state: "cancelled", nextAttemptAt: null,
            redactedError: "Automatic fallback suppressed while the GitHub tool reply remains unresolved", updatedAt: new Date() })
            .where(and(eq(chatPublications.id, publication.id), guard
              ? and(eq(chatPublications.state, "streaming"), eq(chatPublications.attempts, publication.attempts + 1))
              : inArray(chatPublications.state, ["pending", "retry"])));
        });
        return true;
      }
      if (reply === "none" && (publication.payload.progressState === "failed" ||
          await githubResponseCommentService(db, fetchImpl).hasWorkingResponseForRun({
            companyId: publication.companyId, endpointId: publication.endpointId, issueId: publication.issueId, runId,
          }))) return false;
    } else if (publication.payload.progressState === "failed") return false;
    const actionIds = await db.transaction(async tx => {
      await guard?.assertOwned(tx);
      await notifyChatPublicationWork(tx);
      const [cancelled] = await tx.update(chatPublications).set({ state: "cancelled", nextAttemptAt: null,
        redactedError: "GitHub replies are sent through task-scoped tools", updatedAt: new Date() })
        .where(and(eq(chatPublications.id, publication.id), eq(chatPublications.companyId, publication.companyId),
          guard ? and(eq(chatPublications.state, "streaming"), eq(chatPublications.attempts, publication.attempts + 1))
            : inArray(chatPublications.state, ["pending", "retry"])))
        .returning({ id: chatPublications.id });
      if (!cancelled || !runId) return [];
      const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, publication.companyId),
        eq(heartbeatRuns.agentId, record.endpoint.assignedAgentId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${publication.issueId}`,
        inArray(heartbeatRuns.status, ["succeeded", "failed", "interrupted", "timed_out", "cancelled"])));
      if (!run) return [];
      return stageTerminalReceiptReactionRemovals(tx as unknown as Db, {
        endpoint: record.endpoint, publication, payload: publication.payload,
        runtimeContext: runtimeContextForRecord(record), closedProgressRunId: run.id,
      });
    });
    for (const id of actionIds) scheduleMessageProcessing(() => processReceiptReaction(id));
    return true;
  }
  return { githubCurrentOmissionPreparedText, settleGitHubAutomaticPublication };
}

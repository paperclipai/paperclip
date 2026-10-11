import { fastResponseRequests } from "@paperclipai/db";

import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "@paperclipai/db";

import {
  agentWakeupRequests,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type {
  SafeChatPublicationPayload,
} from "@paperclipai/shared";
import {
  isUuidLike,
} from "@paperclipai/shared";

import {
  NativeChatReviewPresentationContentionError,
} from "../native-runtime/native-chat-review-presentation.js";
import { isExternalChatWaitAuthorizationContention } from "../native-runtime/chat-attachment-reuse.js";

import {
  inboundWakePublicationKey,
  parseInboundWakePublicationKey,
} from "../chat-inbound-wakeup-publications.js";

type EndpointRow = typeof chatEndpoints.$inferSelect;
type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type ChatPublicationReplacementOptions = {
  endpointRecord: (endpointId: string) => Promise<{ endpoint: EndpointRow } | null>;
  authorizeRetainedChatSourcePublication: (database: DbOrTransaction, publication: typeof chatPublications.$inferSelect) => Promise<boolean>;
};

export function createChatPublicationReplacement(db: Db, options: ChatPublicationReplacementOptions) {
  const { endpointRecord, authorizeRetainedChatSourcePublication } = options;


  function runIdFromMilestonePublication(
    publication: typeof chatPublications.$inferSelect,
  ): string | null {
    if (!publication.payload.progressState) return null;
    const match =
      /^run:([^:]+):(?:queued|working|waiting_for_input|completed|failed):/.exec(
        publication.idempotencyKey,
      );
    const runId = match?.[1] ?? null;
    // This identifier is also compared against a UUID column below. Old or
    // manually repaired rows must not be allowed to turn the global
    // publication sweep into a PostgreSQL cast error.
    return isUuidLike(runId) ? runId : null;
  }

  async function runOwnershipMilestoneSupersessionReason(
    publication: typeof chatPublications.$inferSelect,
  ): Promise<string | null> {
    const progress = publication.payload.progressState;
    if (progress && ["queued", "working"].includes(progress)) {
      const endpoint = await endpointRecord(publication.endpointId);
      if (endpoint?.endpoint.provider === "imessage-photon") return "iMessage uses typing instead of progress bubbles";
    }
    if (
      !progress ||
      !["queued", "working", "waiting_for_input"].includes(progress)
    ) {
      return null;
    }
    const runId = runIdFromMilestonePublication(publication);
    if (!runId) return null;
    const run = await db.transaction(async (tx) => {
      // Use native finalization's issue -> run lock order. If terminalization
      // won, the current status suppresses this obsolete provider update. If
      // this short authorization snapshot wins, the progress was still true
      // at its durable send boundary and the later final remains authoritative.
      const currentIssue = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.id, publication.issueId),
            eq(issues.companyId, publication.companyId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!currentIssue) return null;
      return tx
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, runId),
            eq(heartbeatRuns.companyId, publication.companyId),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${publication.issueId}`,
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
    });
    const baseProgressKey = `run:${runId}:${progress}:${publication.endpointId}`;
    const nativeProgressPrefix = `run:${runId}:working:${publication.endpointId}:native:`;
    const isTerminalizableProgress =
      (progress === "queued" || progress === "working") &&
      (publication.idempotencyKey === baseProgressKey ||
        publication.idempotencyKey.startsWith(nativeProgressPrefix));
    if (
      isTerminalizableProgress &&
      run &&
      ["succeeded", "interrupted", "failed", "cancelled", "timed_out"].includes(
        run.status,
      )
    ) {
      return "Run reached a terminal state before progress delivery";
    }
    // Match only the closed ownership-attention projection. Historical progress
    // without an extant run retains its existing delivery semantics.
    const ownershipBlocked =
      run?.status === "running" &&
      [
        "native_execution_ownership_unverified",
        "native_adopted_runner_authentication_timeout",
      ].includes(run.errorCode ?? "");
    if (progress === "waiting_for_input") {
      return ownershipBlocked
        ? null
        : "Run ownership attention no longer applies to the bound task";
    }
    return ownershipBlocked
      ? "Run progress was superseded by ownership recovery attention"
      : null;
  }

  async function providerProgressLaneConsumed(
    publication: typeof chatPublications.$inferSelect,
    providerMessageId: string,
  ): Promise<boolean> {
    // Published progress rows retain their old provider ID after an edit.
    // Consult that exact message's current outbound link, not the conversation
    // tail: an authored answer or failure has consumed the lane, while an
    // interleaved task-status update may still be replaced normally.
    const [consumed] = await db
      .select({ id: chatPublications.id })
      .from(chatMessageLinks)
      .innerJoin(
        chatPublications,
        and(
          eq(chatPublications.id, chatMessageLinks.publicationId),
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          eq(chatPublications.issueId, publication.issueId),
          eq(chatPublications.providerMessageId, providerMessageId),
          eq(chatPublications.state, "published"),
        ),
      )
      .where(
        and(
          eq(chatMessageLinks.companyId, publication.companyId),
          eq(chatMessageLinks.endpointId, publication.endpointId),
          eq(chatMessageLinks.conversationId, publication.conversationId),
          eq(chatMessageLinks.direction, "outbound"),
          eq(chatMessageLinks.providerMessageId, providerMessageId),
          or(
            and(
              isNotNull(chatPublications.commentId),
              sql`${chatPublications.payload}->>'progressState' is null`,
            ),
            sql`${chatPublications.payload}->>'progressState' = 'failed'`,
          ),
        ),
      )
      .limit(1);
    return Boolean(consumed);
  }

  async function committedResponseMayReplaceFailure(
    publication: typeof chatPublications.$inferSelect,
    runId: string,
    providerMessageId: string,
  ): Promise<boolean> {
    if (
      !publication.commentId ||
      publication.payload.progressState !== undefined
    )
      return false;
    return db
      .transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, runId),
              eq(heartbeatRuns.companyId, publication.companyId),
              eq(heartbeatRuns.nativeIssueId, publication.issueId),
              eq(heartbeatRuns.runtimeMode, "native"),
              eq(heartbeatRuns.status, "succeeded"),
              isNotNull(heartbeatRuns.finishedAt),
            ),
          )
          .for("share", { noWait: true });
        const presentation = run?.resultJson?.presentationDecision as
          Record<string, unknown> | undefined;
        if (
          !run?.resultJson?.nativeCommittedChatResponse ||
          presentation?.commentId !== publication.commentId
        )
          return false;
        const [comment] = await tx
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.id, publication.commentId!),
              eq(issueComments.companyId, publication.companyId),
              eq(issueComments.issueId, publication.issueId),
              eq(issueComments.createdByRunId, runId),
              eq(issueComments.authorAgentId, run.agentId),
              isNull(issueComments.deletedAt),
            ),
          )
          .for("share", { noWait: true });
        if (!comment) return false;
        const [priorAnswer] = await tx
          .select({ id: chatPublications.id })
          .from(chatPublications)
          .innerJoin(
            issueComments,
            and(
              eq(issueComments.id, chatPublications.commentId),
              eq(issueComments.companyId, publication.companyId),
              eq(issueComments.createdByRunId, runId),
            ),
          )
          .where(
            and(
              eq(chatPublications.companyId, publication.companyId),
              eq(chatPublications.endpointId, publication.endpointId),
              eq(chatPublications.conversationId, publication.conversationId),
              eq(chatPublications.issueId, publication.issueId),
              ne(chatPublications.id, publication.id),
              inArray(chatPublications.state, [
                "published",
                "streaming",
                "delivery_unknown",
              ]),
              sql`${chatPublications.payload}->>'progressState' is null`,
            ),
          )
          .limit(1);
        if (priorAnswer) return false;
        // A historical progress row can retain this ID after a later edit.
        // Only its CURRENT outbound link may grant this narrow exception; an
        // authored answer or another run's failure must remain consumed.
        const [failure] = await tx
          .select({ id: chatPublications.id })
          .from(chatMessageLinks)
          .innerJoin(
            chatPublications,
            and(
              eq(chatPublications.id, chatMessageLinks.publicationId),
              eq(chatPublications.companyId, publication.companyId),
              eq(chatPublications.endpointId, publication.endpointId),
              eq(chatPublications.conversationId, publication.conversationId),
              eq(chatPublications.issueId, publication.issueId),
              eq(chatPublications.providerMessageId, providerMessageId),
              eq(
                chatPublications.idempotencyKey,
                `run:${runId}:failed:${publication.endpointId}`,
              ),
              eq(chatPublications.state, "published"),
              isNull(chatPublications.commentId),
              sql`${chatPublications.payload}->>'progressState' = 'failed'`,
            ),
          )
          .where(
            and(
              eq(chatMessageLinks.companyId, publication.companyId),
              eq(chatMessageLinks.endpointId, publication.endpointId),
              eq(chatMessageLinks.conversationId, publication.conversationId),
              eq(chatMessageLinks.providerMessageId, providerMessageId),
              eq(chatMessageLinks.direction, "outbound"),
            ),
          );
        if (!failure) return false;
        // The marker is read from the authoritative run, never the publication
        // payload. Recheck accepted result/decision plus the complete current
        // source batch, actor, access and epoch before borrowing its failure lane.
        // The transport claim repeats those checks at the I/O boundary.
        return authorizeRetainedChatSourcePublication(tx, publication);
      })
      .catch((error: unknown) => {
        if (isExternalChatWaitAuthorizationContention(error))
          throw new NativeChatReviewPresentationContentionError();
        throw error;
      });
  }

  async function runPublicationToReplace(
    publication: typeof chatPublications.$inferSelect,
    payload: SafeChatPublicationPayload,
  ): Promise<string | null> {
    if (payload.attachmentIds?.length) return null;
    const currentRunId =
      runIdFromMilestonePublication(publication) ??
      (publication.commentId
        ? await db
            .select({ runId: issueComments.createdByRunId })
            .from(issueComments)
            .where(eq(issueComments.id, publication.commentId))
            .then((rows) => rows[0]?.runId ?? null)
        : null);
    if (!currentRunId) return null;
    return db
      .select({
        id: chatPublications.id,
        commentId: chatPublications.commentId,
        providerMessageId: chatPublications.providerMessageId,
        payload: chatPublications.payload,
      })
      .from(chatPublications)
      .leftJoin(issueComments, eq(issueComments.id, chatPublications.commentId))
      .where(
        and(
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          eq(chatPublications.state, "published"),
          isNotNull(chatPublications.providerMessageId),
          or(
            like(chatPublications.idempotencyKey, `run:${currentRunId}:%`),
            eq(issueComments.createdByRunId, currentRunId),
          ),
        ),
      )
      .orderBy(desc(chatPublications.createdAt), desc(chatPublications.id))
      .then(async (rows) => {
        // Progress updates are one replaceable provider-message lane per run.
        // The first durable agent comment may turn that placeholder into the
        // terminal response, but later comments from the same run are distinct
        // user-visible outputs and must be posted separately. Re-editing the
        // placeholder for each comment silently erases the earlier replies.
        if (
          publication.commentId &&
          rows.some(
            (row) =>
              row.commentId !== null && row.payload.progressState === undefined,
          )
        )
          return null;
        const replacement = rows.find(
          (row) =>
            Boolean(row.providerMessageId) &&
            row.payload.progressState !== undefined,
        );
        if (!replacement?.providerMessageId) return null;
        if (
          (await providerProgressLaneConsumed(
            publication,
            replacement.providerMessageId,
          )) &&
          !(await committedResponseMayReplaceFailure(
            publication,
            currentRunId,
            replacement.providerMessageId,
          ))
        )
          return null;
        // Replacement identity belongs to the run, not to the provider-visible
        // tail. A status/control reply may legitimately interleave while the run
        // is active; making the tail the edit candidate would strand this run's
        // working placeholder forever. The query is bounded by endpoint,
        // conversation (the task generation), and run id, so an interleaved
        // control or another run can never donate its provider message here.
        return replacement.providerMessageId;
      });
  }

  async function receiptReactionCompletionRunId(
    tx: Db,
    publication: typeof chatPublications.$inferSelect,
    payload: SafeChatPublicationPayload,
  ): Promise<string | null> {
    if (
      payload.progressState === "completed" ||
      payload.progressState === "failed"
    ) {
      return runIdFromMilestonePublication(publication);
    }
    if (publication.commentId) {
      const runId = await tx
        .select({ runId: issueComments.createdByRunId })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.id, publication.commentId),
            eq(issueComments.companyId, publication.companyId),
          ),
        )
        .then((rows) => rows[0]?.runId ?? null);
      return isUuidLike(runId) ? runId : null;
    }
    if (
      payload.interactionId &&
      publication.idempotencyKey ===
        `interaction:${payload.interactionId}:${publication.endpointId}`
    ) {
      const runId = await tx
        .select({ runId: issueThreadInteractions.sourceRunId })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.id, payload.interactionId),
            eq(issueThreadInteractions.companyId, publication.companyId),
            eq(issueThreadInteractions.issueId, publication.issueId),
          ),
        )
        .then((rows) => rows[0]?.runId ?? null);
      return isUuidLike(runId) ? runId : null;
    }
    return null;
  }

  async function inboundWakePublicationToReplace(
    publication: typeof chatPublications.$inferSelect,
    payload: SafeChatPublicationPayload,
  ): Promise<string | null> {
    if (payload.attachmentIds?.length) return null;
    const notice = parseInboundWakePublicationKey(publication.idempotencyKey);
    let wakeId: string | null =
      notice && notice.state !== "queued" ? notice.wakeId : null;
    let runId = runIdFromMilestonePublication(publication);
    if (
      !notice &&
      !runId &&
      payload.interactionId &&
      publication.idempotencyKey ===
        `interaction:${payload.interactionId}:${publication.endpointId}`
    ) {
      const [interaction] = await db
        .select({ runId: issueThreadInteractions.sourceRunId })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.id, payload.interactionId),
            eq(issueThreadInteractions.companyId, publication.companyId),
            eq(issueThreadInteractions.issueId, publication.issueId),
            inArray(issueThreadInteractions.kind, [
              "ask_user_questions",
              "request_confirmation",
            ]),
          ),
        );
      runId = interaction?.runId ?? null;
    }
    if (!notice && !runId && publication.commentId) {
      const [comment] = await db
        .select({ runId: issueComments.createdByRunId })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.id, publication.commentId),
            eq(issueComments.companyId, publication.companyId),
            eq(issueComments.issueId, publication.issueId),
          ),
        );
      runId = comment?.runId ?? null;
    }
    let runContext: Record<string, unknown> | null = null;
    if (runId) {
      if (publication.commentId) {
        const [priorAnswer] = await db
          .select({ id: chatPublications.id })
          .from(chatPublications)
          .innerJoin(
            issueComments,
            eq(issueComments.id, chatPublications.commentId),
          )
          .where(
            and(
              eq(chatPublications.companyId, publication.companyId),
              eq(chatPublications.endpointId, publication.endpointId),
              eq(chatPublications.conversationId, publication.conversationId),
              eq(chatPublications.state, "published"),
              eq(issueComments.createdByRunId, runId),
              sql`${chatPublications.payload}->>'progressState' is null`,
            ),
          )
          .limit(1);
        if (priorAnswer) return null;
      }
      const [run] = await db
        .select({
          wakeId: heartbeatRuns.wakeupRequestId,
          context: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .innerJoin(
          agentWakeupRequests,
          and(
            eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
            eq(agentWakeupRequests.runId, heartbeatRuns.id),
            eq(agentWakeupRequests.companyId, heartbeatRuns.companyId),
            eq(agentWakeupRequests.agentId, heartbeatRuns.agentId),
            // Failed/cancelled is the admitted run's outcome, not loss of
            // its original admission. Its terminal milestone still owns
            // this exact lane even if no working update was sent first.
            ne(agentWakeupRequests.status, "skipped"),
          ),
        )
        .where(
          and(
            eq(heartbeatRuns.id, runId),
            eq(heartbeatRuns.companyId, publication.companyId),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${publication.issueId}`,
          ),
        );
      wakeId = run?.wakeId ?? null;
      runContext = run?.context ?? null;
    }
    if (!wakeId) return null;
    const [queued] = await db
      .select({
        commentId: chatPublications.commentId,
        providerMessageId: chatPublications.providerMessageId,
      })
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          eq(chatPublications.issueId, publication.issueId),
          eq(chatPublications.state, "published"),
          isNotNull(chatPublications.providerMessageId),
          eq(
            chatPublications.idempotencyKey,
            inboundWakePublicationKey(
              wakeId,
              "queued",
              publication.endpointId,
              publication.conversationId,
            ),
          ),
        ),
      );
    if (!queued?.commentId || !queued.providerMessageId) return null;
    // The run helper may have rejected this same provider ID because its
    // queued/working placeholder is already an answer or terminal failure.
    // Falling back to the older wake row must not erase that newer output.
    if (
      await providerProgressLaneConsumed(publication, queued.providerMessageId)
    )
      return null;
    if (notice && notice.state !== "queued")
      return queued.commentId === publication.commentId
        ? queued.providerMessageId
        : null;
    // A deferred owner can be a Board wake into which the exact external
    // comment coalesced. The run must actually contain that source comment;
    // wake ID alone cannot authorize a different successor's edit lane.
    return runContext &&
      (runContext.wakeCommentId === queued.commentId ||
        runContext.commentId === queued.commentId ||
        (Array.isArray(runContext.wakeCommentIds) &&
          runContext.wakeCommentIds.includes(queued.commentId)))
      ? queued.providerMessageId
      : null;
  }

  async function interactionResolutionPublicationToReplace(
    publication: typeof chatPublications.$inferSelect,
    payload: SafeChatPublicationPayload,
  ): Promise<string | null> {
    if (
      !publication.idempotencyKey.startsWith("interaction-resolution:") ||
      !payload.interactionId
    )
      return null;
    return db
      .select({ providerMessageId: chatPublications.providerMessageId })
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          eq(chatPublications.issueId, publication.issueId),
          eq(
            chatPublications.idempotencyKey,
            `interaction:${payload.interactionId}:${publication.endpointId}`,
          ),
          eq(chatPublications.state, "published"),
          isNotNull(chatPublications.providerMessageId),
        ),
      )
      .then((rows) => rows[0]?.providerMessageId ?? null);
  }

  async function interactionPromptPublicationToReplace(
    publication: typeof chatPublications.$inferSelect,
    payload: SafeChatPublicationPayload,
  ): Promise<string | null> {
    if (
      !payload.interactionId ||
      publication.idempotencyKey !==
        `interaction:${payload.interactionId}:${publication.endpointId}`
    ) {
      return null;
    }
    const interaction = await db
      .select({
        kind: issueThreadInteractions.kind,
        sourceRunId: issueThreadInteractions.sourceRunId,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.id, payload.interactionId),
          eq(issueThreadInteractions.companyId, publication.companyId),
          eq(issueThreadInteractions.issueId, publication.issueId),
          inArray(issueThreadInteractions.kind, [
            "ask_user_questions",
            "request_confirmation",
          ]),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!interaction?.sourceRunId) return null;

    // A provider-visible interaction is this run's response, not an additional
    // message beside its progress indicator. Move the durable interaction
    // publication onto the exact source run's provider-message lane. This
    // retires both the normal working placeholder and the queued placeholder
    // when a very fast run asks before the working update is published.
    for (const progressState of ["working", "queued"] as const) {
      const providerMessageId = await db
        .select({ providerMessageId: chatPublications.providerMessageId })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, publication.companyId),
            eq(chatPublications.endpointId, publication.endpointId),
            eq(chatPublications.conversationId, publication.conversationId),
            eq(chatPublications.issueId, publication.issueId),
            eq(
              chatPublications.idempotencyKey,
              `run:${interaction.sourceRunId}:${progressState}:${publication.endpointId}`,
            ),
            eq(chatPublications.state, "published"),
            isNotNull(chatPublications.providerMessageId),
          ),
        )
        .then((rows) => rows[0]?.providerMessageId ?? null);
      if (providerMessageId) return providerMessageId;
    }
    return null;
  }

  async function progressSupersededByFastResponse(publication: typeof chatPublications.$inferSelect): Promise<boolean> {
    if (!["queued", "working"].includes(publication.payload.progressState ?? "")) return false;
    const runId = runIdFromMilestonePublication(publication);
    const [run] = runId ? await db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, publication.companyId), eq(heartbeatRuns.id, runId))) : [];
    const sourceCommentId = typeof run?.context?.wakeCommentId === "string" ? run.context.wakeCommentId : typeof run?.context?.commentId === "string" ? run.context.commentId : publication.commentId;
    if (!sourceCommentId) return false;
    const [receipt] = await db.select({ id: fastResponseRequests.id }).from(fastResponseRequests).innerJoin(chatPublications,
      and(eq(chatPublications.companyId, publication.companyId), eq(chatPublications.commentId, fastResponseRequests.commentId), eq(chatPublications.state, "published")))
      .where(and(eq(fastResponseRequests.companyId, publication.companyId), eq(fastResponseRequests.sourceCommentId, sourceCommentId), eq(fastResponseRequests.endpointId, publication.endpointId), eq(fastResponseRequests.conversationId, publication.conversationId))).limit(1);
    return Boolean(receipt);
  }

  async function runProgressSupersededByPublishedInteraction(
    publication: typeof chatPublications.$inferSelect,
  ): Promise<boolean> {
    if (
      !["queued", "working"].includes(publication.payload.progressState ?? "")
    ) {
      return false;
    }
    const sourceRunId = runIdFromMilestonePublication(publication);
    if (!sourceRunId) return false;
    const interactionIds = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, publication.companyId),
          eq(issueThreadInteractions.issueId, publication.issueId),
          eq(issueThreadInteractions.sourceRunId, sourceRunId),
          inArray(issueThreadInteractions.kind, [
            "ask_user_questions",
            "request_confirmation",
          ]),
        ),
      )
      .then((rows) => rows.map((row) => row.id));
    if (interactionIds.length === 0) return false;
    return db
      .select({ id: chatPublications.id })
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          eq(chatPublications.issueId, publication.issueId),
          eq(chatPublications.state, "published"),
          inArray(
            chatPublications.idempotencyKey,
            interactionIds.map(
              (interactionId) =>
                `interaction:${interactionId}:${publication.endpointId}`,
            ),
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0);
  }

  async function taskStatusPublicationToReplace(
    publication: typeof chatPublications.$inferSelect,
    payload: SafeChatPublicationPayload,
  ): Promise<string | null> {
    if (
      !publication.idempotencyKey.startsWith("control:status:") ||
      payload.attachmentIds?.length
    )
      return null;
    const rows = await db
      .select({
        commentId: chatPublications.commentId,
        commentRunId: issueComments.createdByRunId,
        idempotencyKey: chatPublications.idempotencyKey,
        payload: chatPublications.payload,
        providerMessageId: chatPublications.providerMessageId,
      })
      .from(chatPublications)
      .leftJoin(issueComments, eq(issueComments.id, chatPublications.commentId))
      .where(
        and(
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          eq(chatPublications.state, "published"),
          isNotNull(chatPublications.providerMessageId),
        ),
      )
      .orderBy(desc(chatPublications.createdAt), desc(chatPublications.id));
    const rowRunId = (row: (typeof rows)[number]) => {
      const milestoneMatch =
        /^run:([^:]+):(?:queued|working|waiting_for_input|completed|failed):/.exec(
          row.idempotencyKey,
        );
      return milestoneMatch?.[1] ?? row.commentRunId ?? null;
    };
    for (const candidate of rows) {
      if (
        !candidate.providerMessageId ||
        !["queued", "working"].includes(candidate.payload.progressState ?? "")
      ) {
        continue;
      }
      const runId = rowRunId(candidate);
      if (!runId) continue;
      const laneClosed = rows.some((row) => {
        if (rowRunId(row) !== runId) return false;
        return (
          ["waiting_for_input", "completed", "failed"].includes(
            row.payload.progressState ?? "",
          ) ||
          (row.commentId !== null && row.payload.progressState === undefined)
        );
      });
      if (!laneClosed) return candidate.providerMessageId;
    }
    return null;
  }

  async function closeProgressToReplace(
    publication: typeof chatPublications.$inferSelect,
    endpoint: EndpointRow,
  ): Promise<{ providerMessageId: string; runId: string } | null> {
    if (
      !["telegram", "slack", "discord", "microsoft-teams"].includes(
        endpoint.provider,
      ) ||
      !publication.idempotencyKey.startsWith("control:close:")
    )
      return null;
    const current = alias(chatPublications, "close_current_progress");
    const plainText = (table: typeof chatPublications | typeof current) =>
      and(
        sql`jsonb_typeof(${table.payload}->'text') = 'string'`,
        sql`${table.payload}->'card' is null`,
        sql`${table.payload}->'interactionId' is null`,
        sql`${table.payload}->'transportPart' is null`,
        sql`(${table.payload}->'attachmentIds' is null or ${table.payload}->'attachmentIds' = '[]'::jsonb)`,
      );
    const ownedMilestone = (table: typeof chatPublications | typeof current) =>
      or(
        sql`${table.idempotencyKey} = 'run:' || ${heartbeatRuns.id}::text || ':queued:' || ${endpoint.id}`,
        sql`${table.idempotencyKey} = 'run:' || ${heartbeatRuns.id}::text || ':working:' || ${endpoint.id}`,
        sql`${table.idempotencyKey} like 'run:' || ${heartbeatRuns.id}::text || ':working:' || ${endpoint.id} || ':native:%'`,
      );
    // A historical progress row alone is not edit authority: its exact current
    // outbound link must still belong to that run's progress (or an interleaved
    // status control). Read under the same credential lease as final delivery.
    const lanes = await db
      .selectDistinct({
        providerMessageId: chatMessageLinks.providerMessageId,
        runId: heartbeatRuns.id,
      })
      .from(chatPublications)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.companyId, publication.companyId),
          eq(heartbeatRuns.agentId, endpoint.assignedAgentId),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${publication.issueId}`,
          sql`split_part(${chatPublications.idempotencyKey}, ':', 2) = ${heartbeatRuns.id}::text`,
        ),
      )
      .innerJoin(
        chatMessageLinks,
        and(
          eq(chatMessageLinks.companyId, publication.companyId),
          eq(chatMessageLinks.endpointId, publication.endpointId),
          eq(chatMessageLinks.conversationId, publication.conversationId),
          eq(chatMessageLinks.direction, "outbound"),
          eq(
            chatMessageLinks.providerMessageId,
            chatPublications.providerMessageId,
          ),
        ),
      )
      .innerJoin(
        current,
        and(
          eq(current.id, chatMessageLinks.publicationId),
          eq(current.companyId, publication.companyId),
          eq(current.endpointId, publication.endpointId),
          eq(current.conversationId, publication.conversationId),
          eq(current.issueId, publication.issueId),
          eq(current.state, "published"),
          eq(current.providerMessageId, chatMessageLinks.providerMessageId),
          isNull(current.commentId),
          plainText(current),
          or(
            and(
              sql`${current.payload}->>'progressState' in ('queued', 'working')`,
              ownedMilestone(current),
            ),
            like(current.idempotencyKey, "control:status:%"),
          ),
        ),
      )
      .where(
        and(
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          eq(chatPublications.issueId, publication.issueId),
          eq(chatPublications.state, "published"),
          isNull(chatPublications.commentId),
          plainText(chatPublications),
          sql`${chatPublications.payload}->>'progressState' in ('queued', 'working')`,
          ownedMilestone(chatPublications),
        ),
      )
      .limit(2);
    // One close receipt owns one edit. Multiple independent lanes require a
    // separate durable multi-effect protocol, never an arbitrary latest guess.
    if (lanes.length !== 1) return null;
    const lane = lanes[0]!;
    const [possiblyConsumed] = await db
      .select({ id: chatPublications.id })
      .from(chatPublications)
      .leftJoin(
        issueComments,
        and(
          eq(issueComments.id, chatPublications.commentId),
          eq(issueComments.companyId, publication.companyId),
          eq(issueComments.issueId, publication.issueId),
        ),
      )
      .where(
        and(
          eq(chatPublications.companyId, publication.companyId),
          eq(chatPublications.endpointId, publication.endpointId),
          eq(chatPublications.conversationId, publication.conversationId),
          eq(chatPublications.issueId, publication.issueId),
          or(
            inArray(chatPublications.state, [
              "pending",
              "retry",
              "streaming",
              "delivery_unknown",
              "published",
            ]),
            // Stopping retries (including an operator's unknown-delivery
            // cancellation) does not prove an attempted edit never arrived.
            and(
              inArray(chatPublications.state, ["cancelled", "failed"]),
              gt(chatPublications.attempts, 0),
            ),
          ),
          or(
            eq(issueComments.createdByRunId, lane.runId),
            // Question/confirmation prompts consume this same run's progress
            // ID through interactionPromptPublicationToReplace, but have no
            // commentId. A stale working link is not proof that their edit
            // never reached the provider (including an unconfirmed receipt).
            sql`exists (
              select 1 from issue_thread_interactions consuming_interaction
              where consuming_interaction.company_id = ${publication.companyId}::uuid
                and consuming_interaction.issue_id = ${publication.issueId}::uuid
                and consuming_interaction.source_run_id = ${lane.runId}::uuid
                and consuming_interaction.kind in ('ask_user_questions', 'request_confirmation')
                and ${chatPublications.payload}->>'interactionId' = consuming_interaction.id::text
                and ${chatPublications.idempotencyKey} = 'interaction:' || consuming_interaction.id::text || ':' || ${publication.endpointId}
            )`,
            eq(
              chatPublications.idempotencyKey,
              `run:${lane.runId}:completed:${endpoint.id}`,
            ),
            eq(
              chatPublications.idempotencyKey,
              `run:${lane.runId}:failed:${endpoint.id}`,
            ),
          ),
        ),
      )
      .limit(1);
    // A final may have reached the provider before its database receipt. Even an
    // unchanged working link cannot disprove that ambiguous provider effect.
    return possiblyConsumed ? null : lane;
  }

  return { runIdFromMilestonePublication, runOwnershipMilestoneSupersessionReason, runPublicationToReplace, receiptReactionCompletionRunId, inboundWakePublicationToReplace, interactionResolutionPublicationToReplace, interactionPromptPublicationToReplace, progressSupersededByFastResponse, runProgressSupersededByPublishedInteraction, taskStatusPublicationToReplace, closeProgressToReplace };
}

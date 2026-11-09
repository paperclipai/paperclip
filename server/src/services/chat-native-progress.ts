import { and, asc, desc, eq, gt, gte, inArray, like, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { agents, chatConversations, chatEndpoints, chatPublications, heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { notifyChatPublicationWork } from "./chat-work-notifications.js";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import { hasChatRunOwnedProviderInteraction } from "./chat-interaction-arbitration.js";
import { resolveChatOriginPublicationBindings } from "./issues.js";
import { boundRunIssueIdSql } from "./run-task-binding.js";
import { allowsAutomaticRunPublication, chatRunProjectionWindow, type ChatRunProjectionScope } from "./chat-run-publication-policy.js";
import { SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES, safeNativeChatProgressForEvent } from "./safe-native-chat-progress.js";

type SafeNativeChatProgressCandidate = {
  eventId: number;
  eventSeq: number;
  eventType: string;
  eventCreatedAt: string;
  runId: string;
  agentId: string;
  issueId: string;
  companyId: string;
  endpointId: string;
  conversationId: string;
  agentName: string;
};

const SAFE_NATIVE_CHAT_PROGRESS_CADENCE_MS = 20_000;

type NativeProgressCursor = Pick<SafeNativeChatProgressCandidate, "eventCreatedAt" | "runId" | "conversationId">;
type NativeProgressInput = { since?: Date; limit?: number; scope?: ChatRunProjectionScope; signal?: AbortSignal };

function nativeProgressPages(db: Db, since: Date, scope?: ChatRunProjectionScope) {
  const basePublication = alias(
    chatPublications,
    "safe_native_progress_base_publication",
  );
  const laterEvent = alias(
    heartbeatRunEvents,
    "safe_native_progress_later_event",
  );
  const issueIdFromContext = boundRunIssueIdSql();
  return async (pageSize: number, pageCursor: NativeProgressCursor | null): Promise<SafeNativeChatProgressCandidate[]> => await db
      .select({
        eventId: heartbeatRunEvents.id,
        eventSeq: heartbeatRunEvents.seq,
        eventType: heartbeatRunEvents.eventType,
        // Keep PostgreSQL microseconds in the cursor. Date truncation can
        // repeatedly select the same suppressed page without advancing.
        eventCreatedAt: sql<string>`${heartbeatRunEvents.createdAt}::text`,
        runId: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        issueId: chatConversations.issueId,
        companyId: chatConversations.companyId,
        endpointId: chatConversations.endpointId,
        conversationId: chatConversations.id,
        agentName: agents.name,
      })
      .from(heartbeatRunEvents)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, heartbeatRunEvents.runId),
          eq(heartbeatRuns.companyId, heartbeatRunEvents.companyId),
          eq(heartbeatRuns.agentId, heartbeatRunEvents.agentId),
          eq(heartbeatRuns.runtimeMode, "native"),
          eq(heartbeatRuns.status, "running"),
        ),
      )
      .innerJoin(
        chatConversations,
        and(
          eq(chatConversations.companyId, heartbeatRuns.companyId),
          sql`coalesce(${heartbeatRuns.issueId}::text, ${issueIdFromContext}) = ${chatConversations.issueId}::text`,
          inArray(chatConversations.state, ["active", "waiting"]),
        ),
      )
      .innerJoin(
        chatEndpoints,
        and(
          eq(chatEndpoints.companyId, chatConversations.companyId),
          eq(chatEndpoints.id, chatConversations.endpointId),
          eq(chatEndpoints.publicationMode, "automatic"),
          allowsAutomaticRunPublication(),
          eq(chatEndpoints.assignedAgentId, heartbeatRuns.agentId),
        ),
      )
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .innerJoin(
        basePublication,
        and(
          eq(basePublication.companyId, heartbeatRuns.companyId),
          eq(basePublication.endpointId, chatConversations.endpointId),
          eq(basePublication.conversationId, chatConversations.id),
          eq(basePublication.issueId, chatConversations.issueId),
          sql`${basePublication.idempotencyKey} = 'run:' || ${heartbeatRuns.id}::text || ':working:' || ${chatConversations.endpointId}::text`,
          inArray(basePublication.state, [
            "pending",
            "retry",
            "streaming",
            "published",
          ]),
        ),
      )
      .where(
        and(
          inArray(heartbeatRunEvents.eventType, [
            ...SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES,
          ]),
          gte(heartbeatRunEvents.createdAt, since),
          scope ? eq(heartbeatRuns.companyId, scope.companyId) : undefined,
          scope?.issueId ? eq(chatConversations.issueId, scope.issueId) : undefined,
          sql`${heartbeatRunEvents.createdAt} >= ${basePublication.createdAt} + interval '20 seconds'`,
          notExists(
            db
              .select({ id: laterEvent.id })
              .from(laterEvent)
              .where(
                and(
                  eq(laterEvent.companyId, heartbeatRunEvents.companyId),
                  eq(laterEvent.runId, heartbeatRunEvents.runId),
                  gt(laterEvent.seq, heartbeatRunEvents.seq),
                  inArray(laterEvent.eventType, [
                    ...SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES,
                  ]),
                ),
              ),
          ),
          pageCursor
            ? sql`(${heartbeatRunEvents.createdAt}, ${heartbeatRuns.id}, ${chatConversations.id}) >
                (${pageCursor.eventCreatedAt}::timestamptz, ${pageCursor.runId}::uuid, ${pageCursor.conversationId}::uuid)`
            : undefined,
        ),
      )
      .orderBy(
        asc(heartbeatRunEvents.createdAt),
        asc(heartbeatRuns.id),
        asc(chatConversations.id),
      )
      .limit(pageSize);
}

export async function loadNativeChatProgressScopes(db: Db, scope?: ChatRunProjectionScope, signal?: AbortSignal) {
  const pages = nativeProgressPages(db, chatRunProjectionWindow({}).since, scope);
  const scopes = new Map<string, { companyId: string; issueId: string }>();
  let cursor: NativeProgressCursor | null = null;
  for (;;) {
    signal?.throwIfAborted();
    const rows = await pages(200, cursor);
    for (const row of rows) scopes.set(`${row.companyId}:${row.issueId}`, { companyId: row.companyId, issueId: row.issueId });
    if (rows.length < 200) return [...scopes.values()];
    cursor = rows[rows.length - 1];
  }
}

/** A suppressed event is settled; lock contention still owes another attempt. */
export async function reconcileNativeChatProgress(db: Db, options: NativeProgressInput = {}) {
  const input = chatRunProjectionWindow(options);
  const pages = nativeProgressPages(db, input.since, options.scope);
  let inserted = 0, contended = false;
  let cursor: NativeProgressCursor | null = null;
  while (inserted < input.limit) {
    options.signal?.throwIfAborted();
    const pageSize = Math.max(25, Math.min(200, input.limit - inserted));
    const rows = await pages(pageSize, cursor);
    if (rows.length === 0) break;
    const lastRow = rows.at(-1)!;
    cursor = {
      eventCreatedAt: lastRow.eventCreatedAt,
      runId: lastRow.runId,
      conversationId: lastRow.conversationId,
    };

    for (const row of rows) {
      options.signal?.throwIfAborted();
      if (inserted >= input.limit) break;
      const result = await db.transaction(async (tx) => {
        // Keep the normal issue -> run order used by native finalization. The
        // publication insert takes an issue FK lock, so locking the run first
        // would invert that order against a concurrent terminal commit. A
        // contended issue/run is optional progress, not a reason to hold other
        // chats: skip it now and revisit it with a fresh cursor next sweep.
        const currentIssue = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              eq(issues.id, row.issueId),
              eq(issues.companyId, row.companyId),
            ),
          )
          .for("update", { skipLocked: true })
          .then((currentRows) => currentRows[0] ?? null);
        if (!currentIssue) {
          const [existing] = await tx.select({ id: issues.id }).from(issues)
            .where(and(eq(issues.id, row.issueId), eq(issues.companyId, row.companyId)));
          contended ||= Boolean(existing);
          return 0;
        }
        // Native event admission serializes on the run row. Taking the same
        // short lock makes terminal status, a later event, or a final comment
        // win before this non-terminal projection can be inserted.
        const currentRun = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, row.runId),
              eq(heartbeatRuns.companyId, row.companyId),
              eq(heartbeatRuns.agentId, row.agentId),
              eq(heartbeatRuns.runtimeMode, "native"),
              eq(heartbeatRuns.status, "running"),
            ),
          )
          .for("update", { skipLocked: true })
          .then((currentRows) => currentRows[0] ?? null);
        if (!currentRun) {
          const [existing] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, row.runId), eq(heartbeatRuns.companyId, row.companyId),
            eq(heartbeatRuns.agentId, row.agentId), eq(heartbeatRuns.runtimeMode, "native"),
            eq(heartbeatRuns.status, "running"),
          ));
          contended ||= Boolean(existing);
          return 0;
        }

        const destination = await tx
          .select({ id: chatConversations.id })
          .from(chatConversations)
          .innerJoin(
            chatEndpoints,
            and(
              eq(chatEndpoints.companyId, chatConversations.companyId),
              eq(chatEndpoints.id, chatConversations.endpointId),
              eq(chatEndpoints.publicationMode, "automatic"),
              allowsAutomaticRunPublication(),
              eq(chatEndpoints.assignedAgentId, row.agentId),
            ),
          )
          .where(
            and(
              eq(chatConversations.companyId, row.companyId),
              eq(chatConversations.id, row.conversationId),
              eq(chatConversations.endpointId, row.endpointId),
              eq(chatConversations.issueId, row.issueId),
              inArray(chatConversations.state, ["active", "waiting"]),
            ),
          )
          .limit(1)
          .then((currentRows) => currentRows[0] ?? null);
        if (!destination) return 0;

        const [currentEvent] = await tx
          .select({
            id: heartbeatRunEvents.id,
            seq: heartbeatRunEvents.seq,
            eventType: heartbeatRunEvents.eventType,
            createdAt: heartbeatRunEvents.createdAt,
          })
          .from(heartbeatRunEvents)
          .where(
            and(
              eq(heartbeatRunEvents.companyId, row.companyId),
              eq(heartbeatRunEvents.runId, row.runId),
              inArray(heartbeatRunEvents.eventType, [
                ...SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES,
              ]),
            ),
          )
          .orderBy(desc(heartbeatRunEvents.seq), desc(heartbeatRunEvents.id))
          .limit(1);
        if (
          !currentEvent ||
          currentEvent.id !== row.eventId ||
          currentEvent.seq !== row.eventSeq ||
          currentEvent.eventType !== row.eventType
        ) {
          return 0;
        }
        const progress = safeNativeChatProgressForEvent(
          currentEvent.eventType,
          row.agentName,
        );
        if (!progress) return 0;

        const baseKey = `run:${row.runId}:working:${row.endpointId}`;
        const [currentBase] = await tx
          .select({ createdAt: chatPublications.createdAt })
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.companyId, row.companyId),
              eq(chatPublications.endpointId, row.endpointId),
              eq(chatPublications.conversationId, row.conversationId),
              eq(chatPublications.issueId, row.issueId),
              eq(chatPublications.idempotencyKey, baseKey),
              inArray(chatPublications.state, [
                "pending",
                "retry",
                "streaming",
                "published",
              ]),
            ),
          )
          .limit(1);
        if (!currentBase) return 0;

        const progressKeyPrefix = `${baseKey}:native:`;
        const previousProgress = await tx
          .select({
            createdAt: chatPublications.createdAt,
            idempotencyKey: chatPublications.idempotencyKey,
          })
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.companyId, row.companyId),
              eq(chatPublications.endpointId, row.endpointId),
              eq(chatPublications.conversationId, row.conversationId),
              eq(chatPublications.issueId, row.issueId),
              like(chatPublications.idempotencyKey, `${progressKeyPrefix}%`),
            ),
          );
        if (
          previousProgress.some((publication) =>
            publication.idempotencyKey.startsWith(
              `${progressKeyPrefix}${progress.phase}:`,
            ),
          )
        ) {
          return 0;
        }
        const lastProgressAt = Math.max(
          currentBase.createdAt.getTime(),
          ...previousProgress.map((publication) =>
            publication.createdAt.getTime(),
          ),
        );
        if (
          currentEvent.createdAt.getTime() - lastProgressAt <
          SAFE_NATIVE_CHAT_PROGRESS_CADENCE_MS
        ) {
          return 0;
        }

        const bindings = await resolveChatOriginPublicationBindings(
          tx,
          row.companyId,
          row.issueId,
          row.runId,
        );
        if (
          !bindings.some(
            (binding) =>
              binding.endpointId === row.endpointId &&
              binding.conversationId === row.conversationId,
          )
        ) {
          return 0;
        }
        if (
          await hasChatRunOwnedProviderInteraction(tx, {
            companyId: row.companyId,
            issueId: row.issueId,
            runId: row.runId,
          })
        ) {
          return 0;
        }
        const explicitlyAuthoredFinal = await tx
          .select({ id: chatPublications.id })
          .from(chatPublications)
          .innerJoin(
            issueComments,
            and(
              eq(issueComments.companyId, chatPublications.companyId),
              eq(issueComments.id, chatPublications.commentId),
            ),
          )
          .where(
            and(
              eq(chatPublications.companyId, row.companyId),
              eq(chatPublications.endpointId, row.endpointId),
              eq(chatPublications.conversationId, row.conversationId),
              eq(chatPublications.issueId, row.issueId),
              eq(issueComments.authorType, "agent"),
              eq(issueComments.createdByRunId, row.runId),
              sql`(
                ${issueComments.metadata} ->> 'authorizationReason' = 'paperclip_runner_protocol'
                or left(coalesce(${issueComments.metadata} ->> 'authorizationReason', ''), 6) = 'allow_'
              )`,
            ),
          )
          .limit(1);
        if (explicitlyAuthoredFinal.length > 0) return 0;

        await notifyChatPublicationWork(tx);
        const insertedRows = await tx
          .insert(chatPublications)
          .values({
            companyId: row.companyId,
            endpointId: row.endpointId,
            conversationId: row.conversationId,
            issueId: row.issueId,
            idempotencyKey: `${progressKeyPrefix}${progress.phase}:${currentEvent.seq}`,
            payload: projectSafeChatPublication({
              classification: "external",
              source: "safe_milestone",
              text: progress.text,
              progressState: "working",
            }),
            state: "pending",
          })
          .onConflictDoNothing()
          .returning({ id: chatPublications.id });
        return insertedRows.length;
      });
      inserted += result;
    }
    if (rows.length < pageSize) break;
  }
  return { inserted, contended };
}

/** Explicit/manual callers retain the original count-only contract. */
export async function enqueueSafeNativeChatProgress(db: Db, options: NativeProgressInput = {}): Promise<number> {
  return (await reconcileNativeChatProgress(db, options)).inserted;
}

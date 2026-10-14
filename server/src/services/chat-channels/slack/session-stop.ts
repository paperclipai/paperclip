import type { EndpointRow, DbTransaction, DbOrTransaction, RuntimeContext, LifecycleRuntimeFence } from "../runtime-types.js";

import { dueChatAction, PROVIDER_EFFECT_STALE_MS } from "../../chat-action-work.js";

import { notifyChatActionWork } from "../../chat-work-notifications.js";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  agentWakeupRequests,
  agents,
  chatActions,
  chatConversations,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import type {
  SafeChatPublicationPayload,
} from "@paperclipai/shared";
import {
  isUuidLike,
} from "@paperclipai/shared";

import { logger } from "../../../middleware/logger.js";

import {
  logActivity,
} from "../../activity-log.js";

import { projectSafeChatPublication } from "../../chat-publication-projection.js";

import {
  type SlackSessionStop,
} from "../../chat-slack-sessions.js";

import {
  enqueueChatRunMilestones,
  safeMilestoneText,
} from "../../chat-run-publications.js";

export type SlackSessionStopTarget =
  { id: string; kind: "run" } | { id: string; kind: "wakeup" };

export type SlackSessionStopPayload = {
  version: 1;
  assignedAgentId: string;
  eventTimestamp: string;
  issueId: string | null;
  occurredAt: string;
  sessionGeneration: number | null;
  target: SlackSessionStopTarget | null;
  threadId: string;
  userId: string;
};

export function slackSessionStopPayload(
  value: Record<string, unknown>,
): SlackSessionStopPayload | null {
  const target = value.target;
  const parsedTarget =
    target === null
      ? null
      : target &&
          typeof target === "object" &&
          !Array.isArray(target) &&
          ((target as { kind?: unknown }).kind === "run" ||
            (target as { kind?: unknown }).kind === "wakeup") &&
          typeof (target as { id?: unknown }).id === "string" &&
          isUuidLike((target as { id: string }).id)
        ? (target as SlackSessionStopTarget)
        : undefined;
  if (
    value.version !== 1 ||
    typeof value.assignedAgentId !== "string" ||
    !isUuidLike(value.assignedAgentId) ||
    typeof value.eventTimestamp !== "string" ||
    !value.eventTimestamp ||
    (value.issueId !== null &&
      (typeof value.issueId !== "string" || !isUuidLike(value.issueId))) ||
    typeof value.occurredAt !== "string" ||
    !Number.isFinite(new Date(value.occurredAt).getTime()) ||
    (value.sessionGeneration !== null &&
      (typeof value.sessionGeneration !== "number" ||
        !Number.isSafeInteger(value.sessionGeneration) ||
        value.sessionGeneration < 1)) ||
    (parsedTarget !== null &&
      (value.issueId === null || value.sessionGeneration === null)) ||
    parsedTarget === undefined ||
    typeof value.threadId !== "string" ||
    !value.threadId.startsWith("slack:") ||
    typeof value.userId !== "string" ||
    !value.userId
  ) {
    return null;
  }
  return {
    version: 1,
    assignedAgentId: value.assignedAgentId,
    eventTimestamp: value.eventTimestamp,
    issueId: value.issueId,
    occurredAt: value.occurredAt,
    sessionGeneration: value.sessionGeneration,
    target: parsedTarget,
    threadId: value.threadId,
    userId: value.userId,
  };
}
type SlackSessionStopOptions = {
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  lockCurrentPrincipalAuthorization: (tx: DbOrTransaction, endpoint: EndpointRow, principalId: string) => Promise<{ allowed: boolean; userId: string | null }>;
  nonDirectDestinationAllowed: (endpoint: EndpointRow, resource: typeof chatEndpointResources.$inferSelect | null | undefined) => boolean;
  stageAuthorizedTaskControlPublication: (tx: DbOrTransaction, input: { companyId: string; conversationId: string; endpointId: string; idempotencyKey: string; issueId: string; payload: SafeChatPublicationPayload; principalId: string }) => Promise<{ id: string }>;
  getPublicBaseUrl: () => string | null;
  heartbeat: { cancelRun?: (runId: string, reason?: string, options?: { errorCode?: string; eventMessage?: string; eventPayload?: Record<string, unknown>; resultJson?: Record<string, unknown> }) => Promise<unknown> };
  redactError: (error: unknown) => string;
};

export function createSlackSessionStop(db: Db, options: SlackSessionStopOptions) {
  const { runtimeCallbackEndpoint, lockCurrentPrincipalAuthorization, nonDirectDestinationAllowed, stageAuthorizedTaskControlPublication, getPublicBaseUrl, redactError } = options;


  async function stageSlackSessionStop(
    endpoint: EndpointRow,
    event: SlackSessionStop,
    runtimeContext: RuntimeContext,
  ): Promise<string | null> {
    return db.transaction(async (tx) => {
      const currentEndpoint = await runtimeCallbackEndpoint(
        tx,
        endpoint.id,
        runtimeContext,
        ["active"],
      );
      if (!currentEndpoint || currentEndpoint.provider !== "slack") return null;

      const conversation = await tx
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.companyId, currentEndpoint.companyId),
            eq(chatConversations.endpointId, currentEndpoint.id),
            eq(chatConversations.externalThreadId, event.threadId),
            inArray(chatConversations.state, ["active", "waiting"]),
          ),
        )
        .orderBy(desc(chatConversations.sessionGeneration))
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null);
      const principal = await tx
        .select()
        .from(chatExternalPrincipals)
        .where(
          and(
            eq(chatExternalPrincipals.companyId, currentEndpoint.companyId),
            eq(chatExternalPrincipals.provider, "slack"),
            eq(
              chatExternalPrincipals.providerAccountId,
              currentEndpoint.providerAccountId ?? "unknown",
            ),
            eq(chatExternalPrincipals.externalId, event.userId),
            eq(chatExternalPrincipals.kind, "user"),
            eq(chatExternalPrincipals.isBot, false),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      const issue = conversation
        ? await tx
            .select()
            .from(issues)
            .where(
              and(
                eq(issues.companyId, currentEndpoint.companyId),
                eq(issues.id, conversation.issueId),
                eq(issues.assigneeAgentId, currentEndpoint.assignedAgentId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;

      // Slack carries fractional event timestamps. Treat that exact instant as
      // the cancellation boundary so a run admitted even milliseconds after
      // Stop was clicked can never be mistaken for the stopped session.
      const eventCutoff = event.occurredAt;
      const futureEvent = event.occurredAt.getTime() > Date.now() + 60_000;
      let target: SlackSessionStopTarget | null = null;
      if (issue && !futureEvent && issue.executionRunId) {
        const run = await tx
          .select({
            agentId: heartbeatRuns.agentId,
            companyId: heartbeatRuns.companyId,
            contextSnapshot: heartbeatRuns.contextSnapshot,
            createdAt: heartbeatRuns.createdAt,
            id: heartbeatRuns.id,
            startedAt: heartbeatRuns.startedAt,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, issue.executionRunId),
              eq(heartbeatRuns.companyId, currentEndpoint.companyId),
              eq(heartbeatRuns.agentId, currentEndpoint.assignedAgentId),
              inArray(heartbeatRuns.status, [
                "queued",
                "running",
                "scheduled_retry",
              ]),
              lte(heartbeatRuns.createdAt, eventCutoff),
              or(
                isNull(heartbeatRuns.startedAt),
                lte(heartbeatRuns.startedAt, eventCutoff),
              ),
              or(
                sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
                sql`${heartbeatRuns.contextSnapshot}->>'taskId' = ${issue.id}`,
              ),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (run) target = { id: run.id, kind: "run" };
      } else if (issue && !futureEvent && !issue.executionRunId) {
        const wakeup = await tx
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, currentEndpoint.companyId),
              eq(agentWakeupRequests.agentId, currentEndpoint.assignedAgentId),
              inArray(agentWakeupRequests.status, [
                "queued",
                "deferred_issue_execution",
              ]),
              isNull(agentWakeupRequests.runId),
              lte(agentWakeupRequests.requestedAt, eventCutoff),
              or(
                sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
                sql`${agentWakeupRequests.payload}->>'taskId' = ${issue.id}`,
                sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId' = ${issue.id}`,
                sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId' = ${issue.id}`,
              ),
            ),
          )
          .orderBy(desc(agentWakeupRequests.requestedAt))
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (wakeup) target = { id: wakeup.id, kind: "wakeup" };
      }

      const payload: SlackSessionStopPayload = {
        version: 1,
        assignedAgentId: currentEndpoint.assignedAgentId,
        eventTimestamp: event.eventTimestamp,
        issueId: issue?.id ?? null,
        occurredAt: event.occurredAt.toISOString(),
        sessionGeneration: conversation?.sessionGeneration ?? null,
        target,
        threadId: event.threadId,
        userId: event.userId,
      };
      await notifyChatActionWork(tx, "slack_session_stop");
      const [inserted] = await tx
        .insert(chatActions)
        .values({
          companyId: currentEndpoint.companyId,
          endpointId: currentEndpoint.id,
          conversationId: conversation?.id ?? null,
          principalId: principal?.id ?? null,
          kind: "slack_session_stop",
          providerActionId: `slack_session_stop:${event.providerEventId}`,
          payload,
          status: "received",
        })
        .onConflictDoNothing()
        .returning({ id: chatActions.id });
      return (
        inserted?.id ??
        (await tx
          .select({ id: chatActions.id })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, currentEndpoint.id),
              eq(
                chatActions.providerActionId,
                `slack_session_stop:${event.providerEventId}`,
              ),
              eq(chatActions.kind, "slack_session_stop"),
            ),
          )
          .then((rows) => rows[0]?.id ?? null))
      );
    });
  }

  async function processSlackSessionStop(actionId: string): Promise<void> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROVIDER_EFFECT_STALE_MS);
    const action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "slack_session_stop"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!action || ["processed", "cancelled"].includes(action.status)) return;
    if (action.status === "processing" && action.updatedAt > staleBefore)
      return;
    if (action.status === "failed") {
      if (action.result?.retryable !== true) return;
      const retryAt =
        typeof action.result.retryAt === "string"
          ? new Date(action.result.retryAt)
          : null;
      if (retryAt && retryAt > now) return;
    } else if (action.status !== "received" && action.status !== "processing") {
      return;
    }
    const payload = slackSessionStopPayload(action.payload);
    const previousAttempts =
      typeof action.result?.attempts === "number" &&
      Number.isSafeInteger(action.result.attempts)
        ? Math.max(0, action.result.attempts)
        : 0;
    const attempts = previousAttempts + 1;
    if (!payload) {
      await db.transaction(async (tx) => {
        await notifyChatActionWork(tx, "slack_session_stop");
        return tx
          .update(chatActions)
          .set({
            status: "failed",
            result: {
              attempts,
              code: "slack_session_stop_payload_invalid",
              retryable: false,
            },
            updatedAt: now,
          })
          .where(eq(chatActions.id, action.id));
      });
      return;
    }

    type StopClaim =
      | { kind: "cancel_run"; runId: string; userId: string }
      | { kind: "settled" }
      | { kind: "retry" };
    const claim = await db.transaction(async (tx): Promise<StopClaim> => {
      const current = await tx
        .select()
        .from(chatActions)
        .where(eq(chatActions.id, action.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      const currentRetryAt =
        typeof current?.result?.retryAt === "string"
          ? new Date(current.result.retryAt)
          : null;
      const currentRetryIsDue =
        currentRetryAt === null ||
        (Number.isFinite(currentRetryAt.getTime()) && currentRetryAt <= now);
      const eligible =
        current?.status === "received" ||
        (current?.status === "processing" &&
          current.updatedAt <= staleBefore &&
          (current.result?.attempts ?? 0) === previousAttempts) ||
        (current?.status === "failed" &&
          current.result?.retryable === true &&
          currentRetryIsDue &&
          (current.result?.attempts ?? 0) === previousAttempts);
      if (!current || !eligible) return { kind: "settled" };

      const settle = async (
        code: string,
        actorUserId: string | null,
        targetKind: "run" | "wakeup" | "none",
      ): Promise<StopClaim> => {
        await notifyChatActionWork(tx, "slack_session_stop");
        await tx
          .update(chatActions)
          .set({
            status:
              code === "slack_session_stop_cancelled"
                ? "processed"
                : "cancelled",
            result: { attempts, code, retryable: false },
            updatedAt: now,
          })
          .where(eq(chatActions.id, current.id));
        await logActivity(tx as unknown as Db, {
          companyId: current.companyId,
          actorType: actorUserId ? "user" : "system",
          actorId: actorUserId ?? "slack-session-stop",
          action:
            code === "slack_session_stop_cancelled"
              ? "chat.slack_session_stopped"
              : "chat.slack_session_stop_filtered",
          entityType: "chat_action",
          entityId: current.id,
          details: {
            endpointId: current.endpointId,
            conversationId: current.conversationId,
            eventTimestamp: payload.eventTimestamp,
            targetKind,
            resultCode: code,
          },
        });
        return { kind: "settled" };
      };

      if (
        !payload.target ||
        !payload.issueId ||
        !payload.sessionGeneration ||
        !current.conversationId ||
        !current.principalId
      ) {
        return settle("slack_session_stop_no_current_work", null, "none");
      }
      const endpoint = await tx
        .select()
        .from(chatEndpoints)
        .where(
          and(
            eq(chatEndpoints.id, current.endpointId),
            eq(chatEndpoints.companyId, current.companyId),
            eq(chatEndpoints.provider, "slack"),
            eq(chatEndpoints.status, "active"),
            eq(chatEndpoints.assignedAgentId, payload.assignedAgentId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      const conversation = endpoint
        ? await tx
            .select()
            .from(chatConversations)
            .where(
              and(
                eq(chatConversations.id, current.conversationId),
                eq(chatConversations.companyId, current.companyId),
                eq(chatConversations.endpointId, current.endpointId),
                eq(chatConversations.issueId, payload.issueId),
                eq(chatConversations.externalThreadId, payload.threadId),
                eq(
                  chatConversations.sessionGeneration,
                  payload.sessionGeneration,
                ),
                inArray(chatConversations.state, ["active", "waiting"]),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      const resource =
        endpoint && conversation?.resourceId
          ? await tx
              .select()
              .from(chatEndpointResources)
              .where(
                and(
                  eq(chatEndpointResources.id, conversation.resourceId),
                  eq(chatEndpointResources.companyId, current.companyId),
                  eq(chatEndpointResources.endpointId, current.endpointId),
                ),
              )
              .for("update")
              .then((rows) => rows[0] ?? null)
          : null;
      const principal = endpoint
        ? await tx
            .select()
            .from(chatExternalPrincipals)
            .where(
              and(
                eq(chatExternalPrincipals.id, current.principalId),
                eq(chatExternalPrincipals.companyId, current.companyId),
                eq(chatExternalPrincipals.provider, "slack"),
                eq(
                  chatExternalPrincipals.providerAccountId,
                  endpoint.providerAccountId ?? "unknown",
                ),
                eq(chatExternalPrincipals.externalId, payload.userId),
                eq(chatExternalPrincipals.kind, "user"),
                eq(chatExternalPrincipals.isBot, false),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      const authorization =
        endpoint && principal
          ? await lockCurrentPrincipalAuthorization(tx, endpoint, principal.id)
          : null;
      const destinationAllowed =
        endpoint && conversation
          ? conversation.isDirectMessage
            ? endpoint.allowDirectMessages
            : nonDirectDestinationAllowed(endpoint, resource)
          : false;
      const issue =
        endpoint && conversation
          ? await tx
              .select()
              .from(issues)
              .where(
                and(
                  eq(issues.id, payload.issueId),
                  eq(issues.companyId, current.companyId),
                  eq(issues.assigneeAgentId, payload.assignedAgentId),
                ),
              )
              .for("update")
              .then((rows) => rows[0] ?? null)
          : null;
      if (
        !endpoint ||
        !conversation ||
        !principal ||
        !authorization?.allowed ||
        !authorization.userId ||
        !destinationAllowed ||
        !issue
      ) {
        return settle(
          "slack_session_stop_no_longer_authorized",
          null,
          payload.target.kind,
        );
      }

      const eventCutoff = new Date(payload.occurredAt);
      let runId: string | null = null;
      if (payload.target.kind === "run") {
        runId = payload.target.id;
      } else {
        const wakeup = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.id, payload.target.id),
              eq(agentWakeupRequests.companyId, current.companyId),
              eq(agentWakeupRequests.agentId, payload.assignedAgentId),
              lte(agentWakeupRequests.requestedAt, eventCutoff),
              or(
                sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
                sql`${agentWakeupRequests.payload}->>'taskId' = ${issue.id}`,
                sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId' = ${issue.id}`,
                sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId' = ${issue.id}`,
              ),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          wakeup &&
          !wakeup.runId &&
          ["queued", "deferred_issue_execution"].includes(wakeup.status) &&
          !issue.executionRunId
        ) {
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "cancelled",
              finishedAt: now,
              error: "Cancelled from the bound Slack agent session",
              updatedAt: now,
            })
            .where(
              and(
                eq(agentWakeupRequests.id, wakeup.id),
                inArray(agentWakeupRequests.status, [
                  "queued",
                  "deferred_issue_execution",
                ]),
                isNull(agentWakeupRequests.runId),
              ),
            );
          const agentName = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(
              and(
                eq(agents.companyId, current.companyId),
                eq(agents.id, payload.assignedAgentId),
              ),
            )
            .then((rows) => rows[0]?.name ?? "Paperclip agent");
          await stageAuthorizedTaskControlPublication(tx, {
            companyId: current.companyId,
            conversationId: conversation.id,
            endpointId: current.endpointId,
            idempotencyKey: `control:stop:${current.id}`,
            issueId: issue.id,
            payload: projectSafeChatPublication({
              classification: "external",
              progressState: "failed",
              source: "safe_milestone",
              text: safeMilestoneText({
                agentName,
                errorCode: "slack_session_stopped",
                issueId: issue.id,
                milestone: "failed",
                publicBaseUrl: getPublicBaseUrl(),
              }),
            }),
            principalId: principal.id,
          });
          return settle(
            "slack_session_stop_cancelled",
            authorization.userId,
            "wakeup",
          );
        }
        runId = wakeup?.runId ?? null;
        if (!runId && wakeup?.status === "claimed") {
          await notifyChatActionWork(tx, "slack_session_stop");
          await tx
            .update(chatActions)
            .set({
              status: "failed",
              result: {
                attempts,
                code: "slack_session_stop_wakeup_in_flight",
                retryable: true,
                retryAt: new Date(Date.now() + 1_000).toISOString(),
              },
              updatedAt: now,
            })
            .where(eq(chatActions.id, current.id));
          return { kind: "retry" };
        }
      }

      const run = runId
        ? await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.id, runId),
                eq(heartbeatRuns.companyId, current.companyId),
                eq(heartbeatRuns.agentId, payload.assignedAgentId),
                payload.target.kind === "wakeup"
                  ? eq(heartbeatRuns.wakeupRequestId, payload.target.id)
                  : and(
                      lte(heartbeatRuns.createdAt, eventCutoff),
                      or(
                        isNull(heartbeatRuns.startedAt),
                        lte(heartbeatRuns.startedAt, eventCutoff),
                      ),
                    ),
                or(
                  sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
                  sql`${heartbeatRuns.contextSnapshot}->>'taskId' = ${issue.id}`,
                ),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      if (!run) {
        return settle(
          "slack_session_stop_target_superseded",
          authorization.userId,
          payload.target.kind,
        );
      }
      if (run.status === "cancelled") {
        return settle(
          "slack_session_stop_cancelled",
          authorization.userId,
          "run",
        );
      }
      if (
        issue.executionRunId !== run.id ||
        !["queued", "running", "scheduled_retry"].includes(run.status)
      ) {
        return settle(
          "slack_session_stop_target_superseded",
          authorization.userId,
          "run",
        );
      }
      await notifyChatActionWork(tx, "slack_session_stop");
      await tx
        .update(chatActions)
        .set({
          status: "processing",
          result: {
            attempts,
            authorizedUserId: authorization.userId,
            runId: run.id,
          },
          updatedAt: now,
        })
        .where(eq(chatActions.id, current.id));
      return {
        kind: "cancel_run",
        runId: run.id,
        userId: authorization.userId,
      };
    });
    if (claim.kind !== "cancel_run") return;

    try {
      if (!options.heartbeat.cancelRun) {
        throw new Error("Heartbeat cancellation is unavailable");
      }
      await options.heartbeat.cancelRun(
        claim.runId,
        "Stopped from the bound Slack agent session",
        {
          errorCode: "slack_session_stopped",
          eventMessage: "run cancelled from Slack",
          resultJson: {
            cancelledByActorType: "user",
            cancelledByUserId: claim.userId,
          },
          eventPayload: {
            endpointId: action.endpointId,
            conversationId: action.conversationId,
            provider: "slack",
          },
        },
      );
      await enqueueChatRunMilestones(db, { publicBaseUrl: getPublicBaseUrl() });
      const authoritativeRun = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, claim.runId))
        .then((rows) => rows[0] ?? null);
      const cancellationWon = authoritativeRun?.status === "cancelled";
      await db.transaction(async (tx) => {
        await notifyChatActionWork(tx, "slack_session_stop");
        const [settled] = await tx
          .update(chatActions)
          .set({
            status: cancellationWon ? "processed" : "cancelled",
            result: {
              attempts,
              code: cancellationWon
                ? "slack_session_stop_cancelled"
                : "slack_session_stop_target_superseded",
              runId: claim.runId,
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, action.id),
              eq(chatActions.status, "processing"),
              sql`(${chatActions.result}->>'attempts')::int = ${attempts}`,
              sql`${chatActions.result}->>'runId' = ${claim.runId}`,
            ),
          )
          .returning({ id: chatActions.id });
        if (!settled) return;
        await logActivity(tx as unknown as Db, {
          companyId: action.companyId,
          actorType: "user",
          actorId: claim.userId,
          action: cancellationWon
            ? "chat.slack_session_stopped"
            : "chat.slack_session_stop_filtered",
          entityType: "chat_action",
          entityId: action.id,
          details: {
            endpointId: action.endpointId,
            conversationId: action.conversationId,
            eventTimestamp: payload.eventTimestamp,
            targetKind: "run",
            resultCode: cancellationWon
              ? "slack_session_stop_cancelled"
              : "slack_session_stop_target_superseded",
          },
        });
      });
    } catch (error) {
      const retryable = attempts < 5;
      await db.transaction(async (tx) => {
        await notifyChatActionWork(tx, "slack_session_stop");
        return tx
          .update(chatActions)
          .set({
            status: "failed",
            result: {
              attempts,
              code: "slack_session_stop_cancellation_failed",
              retryable,
              ...(retryable
                ? {
                    retryAt: new Date(
                      Date.now() + Math.min(60_000, 1_000 * 2 ** (attempts - 1)),
                    ).toISOString(),
                  }
                : {}),
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, action.id),
              eq(chatActions.status, "processing"),
              sql`(${chatActions.result}->>'attempts')::int = ${attempts}`,
              sql`${chatActions.result}->>'runId' = ${claim.runId}`,
            ),
          );
      });
      logger.warn(
        {
          actionId: action.id,
          endpointId: action.endpointId,
          attempts,
          error: redactError(error),
        },
        "Slack session stop cancellation deferred",
      );
    }
  }

  async function processPendingSlackSessionStops(
    limit = 25,
    onlyActionId?: string,
  ) {
    const actions = await db.select({ id: chatActions.id }).from(chatActions)
      .where(and(dueChatAction("slack_session_stop"), onlyActionId ? eq(chatActions.id, onlyActionId) : undefined))
      .orderBy(asc(chatActions.createdAt)).limit(limit);
    for (const action of actions) await processSlackSessionStop(action.id);
    return actions.length;
  }
  return { stageSlackSessionStop, processSlackSessionStop, processPendingSlackSessionStops };
}

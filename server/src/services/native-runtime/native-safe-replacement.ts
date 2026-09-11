import { logger } from "../../middleware/logger.js";
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  toolInvocations,
  type Db,
} from "@paperclipai/db";
import { decideNativeReplacement } from "./native-replacement-evidence.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { buildExecutionContinuation } from "../execution-continuation.js";

export const NATIVE_SAFE_REPLACEMENT_REASON = "native_safe_replacement";
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const processAlive = (pid: number | null) => {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/** Retryable outbox: terminal_failure plus a new-format failure code is the durable candidate. */
export async function reconcileSafeNativeReplacements(
  db: Db,
  now = new Date(),
  options: {
    /** Test fault injection at durability boundaries; never exposed by an API. */
    failpoint?: (phase: "successor_inserted" | "lineage_committed") => void;
  } = {},
) {
  const candidates = await db
    .select({ run: heartbeatRuns, coordinator: nativeRunFinalizations })
    .from(heartbeatRuns)
    .innerJoin(
      nativeRunFinalizations,
      eq(nativeRunFinalizations.runId, heartbeatRuns.id),
    )
    .where(
      and(
        eq(heartbeatRuns.status, "failed"),
        eq(nativeRunFinalizations.phase, "terminal_failure"),
        eq(
          nativeRunFinalizations.failureCode,
          "native_provider_terminal_failed",
        ),
        isNull(nativeRunFinalizations.resultId),
        sql`coalesce(${nativeRunFinalizations.failureDetail}->>'successorRunId', '') = ''`,
        sql`coalesce(${nativeRunFinalizations.failureDetail}->>'replacementDenied', '') = ''`,
      ),
    )
    .limit(25);
  let scheduled = 0;
  for (const { run, coordinator } of candidates) {
    try {
      if (
        coordinator.failureDetail?.successorRunId ||
        coordinator.failureDetail?.replacementDenied
      )
        continue;
      const execution = record(
        record(run.runnerProfileJson).nativeExecutionInput,
      );
      const workspace = record(execution.workspace);
      const leases = await db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.companyId, run.companyId),
            eq(environmentLeases.heartbeatRunId, run.id),
          ),
        );
      // Teardown is still in progress. The next sweep rechecks its durable outcome.
      if (leases.some((lease) => lease.releasedAt === null)) continue;
      const invocations = await db
        .select()
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.companyId, run.companyId),
            eq(toolInvocations.runId, run.id),
          ),
        );
      const events = await db
        .select({
          eventType: heartbeatRunEvents.eventType,
          payload: heartbeatRunEvents.payload,
        })
        .from(heartbeatRunEvents)
        .where(
          and(
            eq(heartbeatRunEvents.companyId, run.companyId),
            eq(heartbeatRunEvents.runId, run.id),
            inArray(heartbeatRunEvents.eventType, [
              "harness.diagnostic",
              "tool.execution.started",
              "workspace.changed",
              "workspace.change.updated",
              "delegation.started",
              "terminal.input.sent",
              "artifact.generated",
              "item.started",
            ]),
          ),
        );
      const safeControlReads = new Set([
        "connections_search",
        "connection_request",
        "paperclip_get_agent",
        "paperclip_get_issue",
        "paperclip_list_issues",
        "paperclip_read_document",
      ]);
      const uncertainProviderActions = events.flatMap((event) => {
        const envelope = record(event.payload);
        const p = envelope.prpEvent
          ? record(record(envelope.prpEvent).payload)
          : envelope;
        if (event.eventType === "harness.diagnostic")
          return p.classification === "descendant"
            ? [`descendant ${String(p.receivedThreadId ?? "unknown")}`]
            : [];
        if (
          [
            "workspace.changed",
            "workspace.change.updated",
            "delegation.started",
            "terminal.input.sent",
            "artifact.generated",
          ].includes(event.eventType)
        )
          return [event.eventType];
        if (event.eventType === "tool.execution.started") {
          const name = typeof p.name === "string" ? p.name : "unknown tool";
          const receiptedRead = invocations.some(
            (row) =>
              (row.id === p.executionId ||
                row.correlationId === p.executionId) &&
              row.toolName === name &&
              row.riskLevel === "read" &&
              row.status === "succeeded" &&
              row.resultHash,
          );
          return p.transport === "process" ||
            (!receiptedRead && !safeControlReads.has(name))
            ? [String(p.executionId ?? name)]
            : [];
        }
        return [
          "command_execution",
          "commandExecution",
          "file_change",
          "fileChange",
          "collabAgentToolCall",
          "subAgentActivity",
        ].includes(String(p.kind ?? p.type))
          ? [String(p.kind ?? p.type)]
          : [];
      });
      let historyComplete = false;
      try {
        const continuation = await buildExecutionContinuation({
          db,
          companyId: run.companyId,
          issueId: coordinator.issueId,
          agentId: run.agentId,
          context: record(run.contextSnapshot),
          summary: null,
          exposeLowTrustRaw: false,
        });
        if (continuation.unresolvedInteractionIds.length > 0) continue;
        historyComplete = true;
      } catch {
        /* The named operator outcome retains incomplete context. */
      }
      const decision = decideNativeReplacement({
        failedSession: true,
        // A facade transport failure can conceal an authoritative protocol
        // rejection. A stopped process and read receipts do not resolve that.
        failureMeaningKnown:
          typeof coordinator.failureDetail?.originalFailureCode === "string" &&
          ![
            "notification_transport_failed",
            "provider_turn_failed",
            "native_provider_terminal_failed",
          ].includes(coordinator.failureDetail.originalFailureCode),
        predecessorFenced:
          coordinator.leaseOwner === null && run.status === "failed",
        providerStopped:
          !processAlive(run.processPid) &&
          !processAlive(run.processGroupId ? -run.processGroupId : null),
        workspacePreserved:
          typeof workspace.cwd === "string" &&
          (await stat(workspace.cwd).then(
            (s) => s.isDirectory(),
            () => false,
          )),
        historyComplete,
        effectInventoryComplete:
          record(run.runnerProfileJson).recoveryEventInventoryVersion === 1 &&
          record(execution.provider).kind === "codex",
        attempts: coordinator.attempt,
        invocations,
        apiReceipts: record(record(run.resultJson).apiToolReceipts),
        uncertainProviderActions,
      });
      if (!decision.allowed) {
        // Lack of containment can be temporary; do not prevent the next proof.
        if (decision.cause === "provider_ownership_unverified") continue;
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
          );
          const [task] = await tx
            .select()
            .from(issues)
            .where(
              and(
                eq(issues.id, coordinator.issueId),
                eq(issues.companyId, run.companyId),
              ),
            )
            .for("update");
          const [current] = await tx
            .select()
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, run.id))
            .for("update");
          if (
            !current ||
            current.phase !== "terminal_failure" ||
            current.failureDetail?.successorRunId ||
            current.failureDetail?.replacementDenied
          )
            return;
          await tx
            .update(nativeRunFinalizations)
            .set({
              failureDetail: {
                ...current.failureDetail,
                replacementDenied: decision.cause,
                nextAction: decision.nextAction,
              },
              updatedAt: now,
            })
            .where(eq(nativeRunFinalizations.runId, run.id));
          if (
            !task ||
            task.assigneeAgentId !== run.agentId ||
            ["done", "cancelled"].includes(task.status)
          )
            return;
          await issueRecoveryActionService(
            tx as unknown as Db,
          ).upsertSourceScoped({
            companyId: run.companyId,
            sourceIssueId: coordinator.issueId,
            kind: "active_run_watchdog",
            ownerType: "board",
            ownerAgentId: null,
            returnOwnerAgentId: run.agentId,
            cause: decision.cause,
            fingerprint: `native-replacement:${run.id}`,
            evidence: { runId: run.id, attempts: coordinator.attempt },
            nextAction: decision.nextAction,
            wakePolicy: null,
            maxAttempts: 3,
            supersedeOnIdentityChange: true,
          });
        });
        continue;
      }
      const created = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
        );
        const [task] = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, coordinator.issueId),
              eq(issues.companyId, run.companyId),
            ),
          )
          .for("update");
        const [current] = await tx
          .select()
          .from(nativeRunFinalizations)
          .where(eq(nativeRunFinalizations.runId, run.id))
          .for("update");
        if (
          !task ||
          task.assigneeAgentId !== run.agentId ||
          !["in_progress", "in_review"].includes(task.status) ||
          (task.executionRunId !== null && task.executionRunId !== run.id) ||
          (task.checkoutRunId !== null && task.checkoutRunId !== run.id) ||
          !current ||
          current.phase !== "terminal_failure" ||
          current.failureDetail?.successorRunId ||
          current.failureDetail?.replacementDenied ||
          current.attempt >= 3
        )
          return false;
        const successorRunId = randomUUID();
        const dueAt = new Date(now.getTime() + 30_000);
        const predecessorContext = { ...record(run.contextSnapshot) };
        // History comes from the failed source run. Consumed wake fields must
        // not grant this automatic retry fresh comment/resume authority.
        for (const key of [
          "explicitUserContinuation", "wakeCommentId", "wakeCommentIds", "commentId",
          "commentIds", "latestCommentId", "resumeIntent", "followUpRequested",
          "paperclipWake", "paperclipWakeComment", "paperclipTaskMarkdown", "paperclipTaskMarkdownCompact",
        ]) delete predecessorContext[key];
        const context = {
          ...predecessorContext,
          issueId: task.id,
          retryOfRunId: run.id,
          wakeReason: NATIVE_SAFE_REPLACEMENT_REASON,
          retryReason: NATIVE_SAFE_REPLACEMENT_REASON,
          forceFreshSession: true,
          recoveryIncidentRootRunId:
            record(run.contextSnapshot).recoveryIncidentRootRunId ?? run.id,
        };
        const [wake] = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: run.companyId,
            agentId: run.agentId,
            source: "automation",
            triggerDetail: "system",
            reason: NATIVE_SAFE_REPLACEMENT_REASON,
            status: "queued",
            payload: context,
            requestedByActorType: "system",
            idempotencyKey: `native-safe-replacement:${run.id}`,
          })
          .returning();
        await tx.insert(heartbeatRuns).values({
          id: successorRunId,
          companyId: run.companyId,
          agentId: run.agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "scheduled_retry",
          executionStatusDeliveryId: randomUUID(),
          wakeupRequestId: wake!.id,
          responsibleUserId: run.responsibleUserId,
          contextSnapshot: context,
          retryOfRunId: run.id,
          scheduledRetryAt: dueAt,
          scheduledRetryAttempt: current.attempt,
          scheduledRetryReason: NATIVE_SAFE_REPLACEMENT_REASON,
        });
        options.failpoint?.("successor_inserted");
        await tx
          .update(agentWakeupRequests)
          .set({ runId: successorRunId })
          .where(eq(agentWakeupRequests.id, wake!.id));
        await tx
          .update(nativeRunFinalizations)
          .set({
            failureDetail: {
              ...current.failureDetail,
              successorRunId,
              nextAction:
                "Continue in the linked fresh provider session after the retry delay.",
            },
            nextAttemptAt: dueAt,
            updatedAt: now,
          })
          .where(eq(nativeRunFinalizations.runId, run.id));
        await issueRecoveryActionService(
          tx as unknown as Db,
        ).resolveActiveForIssue({
          companyId: run.companyId,
          sourceIssueId: task.id,
          kind: "active_run_watchdog",
          fingerprint: createHash("sha256")
            .update(`${run.id}:${current.failureCode}`)
            .digest("hex"),
          status: "resolved",
          outcome: "handed_back",
          resolutionNote: `Safe continuation is scheduled in run ${successorRunId}.`,
        });
        await tx
          .update(heartbeatRuns)
          .set({ executionStatusDeliveryId: randomUUID() })
          .where(eq(heartbeatRuns.id, run.id));
        // The successor gets task authority only through the existing admission gate.
        await tx
          .update(issues)
          .set({ executionRunId: null, checkoutRunId: null, updatedAt: now })
          .where(
            and(
              eq(issues.id, task.id),
              eq(issues.assigneeAgentId, run.agentId),
            ),
          );
        return true;
      });
      if (created) {
        options.failpoint?.("lineage_committed");
        scheduled += 1;
      }
    } catch (error) {
      if (options.failpoint) throw error;
      logger.warn(
        { runId: run.id },
        "Native replacement remains pending; another sweep will retry its durable decision",
      );
    }
  }
  return { scanned: candidates.length, scheduled };
}

import { notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";
import { notifyNativeStatusReassessment } from "../native-status-reassessment-notifications.js";
import { notifyUnsafeWorkspaceExportRecovery } from "../unsafe-workspace-export-notifications.js";
import { notifyExecutionRunWork } from "../execution-control-notifications.js";
import { logger } from "../../middleware/logger.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { stat } from "node:fs/promises";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  aiConnectionPools,
  aiConnectionQuotaCooldowns,
  environmentLeases,
  executionWorkspaces,
  executionWorkspaceSnapshots,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  issueRecoveryActions,
  nativeRunFinalizations,
  toolInvocations,
  workspaceOperations,
  type Db,
} from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { decideNativeReplacement } from "./native-replacement-evidence.js";
import { issueService } from "../issues.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { aiConnectionRouterService } from "../ai-connection-router.js";
import type { AiConnectionRouterSelection } from "@paperclipai/shared";

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

type ReplacementDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A saved remote source is proved by its current ledger, never a controller path. */
async function remoteWorkspaceReplacementEvidence(
  db: ReplacementDb,
  run: typeof heartbeatRuns.$inferSelect,
  issueId: string,
  leases: Array<typeof environmentLeases.$inferSelect>,
  lock = false,
) {
  const [task] = await db.select({ workspaceId: issues.executionWorkspaceId }).from(issues).where(and(
    eq(issues.companyId, run.companyId), eq(issues.id, issueId),
  ));
  const query = task?.workspaceId ? db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, run.companyId), eq(executionWorkspaces.id, task.workspaceId),
  )) : null;
  const [workspace] = query ? await (lock ? query.for("update") : query) : [];
  const authority = readRemoteWorkspaceAuthority(workspace?.metadata);
  if (run.runnerProfileJson?.remoteWorkspace == null && !authority) return null;
  if (lock) {
    const [currentRun] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id),
    )).for("update");
    if (!currentRun || currentRun.status !== "failed") return { workspacePreserved: false, providerStopped: false };
    run = currentRun;
    leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    )).for("update");
  }
  const providerStopped = leases.length > 0 && leases.every(hasRemoteTerminationReceipt);
  const denied = { workspacePreserved: false, providerStopped };
  const parsed = remoteWorkspaceRunReferenceSchema.safeParse(run.runnerProfileJson?.remoteWorkspace);
  if (!workspace || !authority || !parsed.success || parsed.data.state !== "saved" || !parsed.data.snapshotId
    || run.runnerProfileJson?.nativeWorkspaceSync != null || ["archived", "cleanup_failed"].includes(workspace.status)) return denied;
  const reference = parsed.data;
  const executionWorkspace = record(record(run.runnerProfileJson?.nativeExecutionInput).workspace);
  if (workspace.id !== reference.workspaceId || executionWorkspace.cwd !== reference.remoteCwd
    || authority.dirty || authority.writerRunId || authority.epoch !== reference.epoch
    || authority.snapshotId !== reference.snapshotId) return denied;
  const lease = leases.find(row => row.id === reference.leaseId && row.providerLeaseId === reference.providerLeaseId
    && (!row.executionWorkspaceId || row.executionWorkspaceId === workspace.id)
    && row.metadata?.remoteWorkspaceId === workspace.id && row.metadata?.remoteCwd === reference.remoteCwd);
  if (!lease || !providerStopped) return denied;
  if (authority.location ? authority.location.leaseId !== lease.id || authority.location.environmentId !== lease.environmentId
    || authority.location.providerLeaseId !== reference.providerLeaseId || authority.location.remoteCwd !== reference.remoteCwd
    : record(lease.metadata?.remoteExecutionTermination).state !== "destroyed") return denied;
  const snapshotQuery = db.select().from(executionWorkspaceSnapshots).where(and(
    eq(executionWorkspaceSnapshots.companyId, run.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id),
    eq(executionWorkspaceSnapshots.id, reference.snapshotId!), eq(executionWorkspaceSnapshots.status, "committed"),
    eq(executionWorkspaceSnapshots.epoch, reference.epoch), eq(executionWorkspaceSnapshots.sourceRunId, run.id),
  ));
  const [snapshot] = await (lock ? snapshotQuery.for("update") : snapshotQuery);
  if (!snapshot?.sha256 || !snapshot.objectKey || !snapshot.key || !snapshot.manifestDigest || !snapshot.byteSize) return denied;
  const [operation] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.id, snapshot.sourceOperationId), eq(workspaceOperations.companyId, run.companyId),
    eq(workspaceOperations.executionWorkspaceId, workspace.id), eq(workspaceOperations.heartbeatRunId, run.id),
    eq(workspaceOperations.issueId, issueId), eq(workspaceOperations.phase, "remote_workspace_snapshot"),
    eq(workspaceOperations.status, "succeeded"),
    sql`${workspaceOperations.metadata}->>'boundary' = 'final'`,
    sql`${workspaceOperations.metadata}->>'epoch' = ${String(reference.epoch)}`,
    sql`${workspaceOperations.metadata}->>'snapshotId' = ${snapshot.id}`,
    sql`${workspaceOperations.metadata}->>'sha256' = ${snapshot.sha256}`,
  ));
  return { workspacePreserved: Boolean(operation), providerStopped };
}

export function nativeReplacementPending() {
  return and(
    eq(heartbeatRuns.status, "failed"),
    eq(nativeRunFinalizations.phase, "terminal_failure"),
    inArray(
      nativeRunFinalizations.failureCode,
      ["native_provider_terminal_failed", "native_session_cleanup_quarantined", "provider_transport_failed", "native_provider_usage_limit"],
    ),
    sql`(${nativeRunFinalizations.failureCode} <> 'native_provider_usage_limit' or exists (
      select 1 from heartbeat_run_events e where e.company_id = ${heartbeatRuns.companyId}
        and e.run_id = ${heartbeatRuns.id} and e.event_type = 'ai_connection.quota_attributed'
        and e.source_event_id = 'ai-connection-quota-attributed:' || ${heartbeatRuns.id}::text
    ))`,
    isNull(nativeRunFinalizations.resultId),
    sql`coalesce(${nativeRunFinalizations.failureDetail}->>'successorRunId', '') = ''`,
    sql`coalesce(${nativeRunFinalizations.failureDetail}->>'replacementDenied', '') = ''`,
    sql`(${nativeRunFinalizations.failureCode} <> 'native_provider_usage_limit' or coalesce(${heartbeatRuns.resultJson}->'executionCancellation'->>'state', '') not in ('requested', 'acknowledged'))`,
  );
}

/** Retryable outbox: terminal_failure plus a new-format failure code is the durable candidate. */
export async function reconcileSafeNativeReplacements(
  db: Db,
  now = new Date(),
  options: {
    verifyStoppedSession?: (run: typeof heartbeatRuns.$inferSelect) => Promise<{
      evidence: Record<string, unknown>;
      retire: () => boolean;
    } | null>;
    /** Test fault injection at durability boundaries; never exposed by an API. */
    failpoint?: (phase: "successor_inserted" | "lineage_committed") => void | Promise<void>;
  } = {},
) {
  const quotaCandidates = await db
    .select({ run: heartbeatRuns, coordinator: nativeRunFinalizations })
    .from(heartbeatRuns)
    .innerJoin(
      nativeRunFinalizations,
      eq(nativeRunFinalizations.runId, heartbeatRuns.id),
    )
    .where(
      and(nativeReplacementPending(), eq(nativeRunFinalizations.failureCode, "native_provider_usage_limit")),
    )
    .orderBy(sql`case when ${nativeRunFinalizations.failureCode} = 'native_provider_usage_limit' and
        coalesce(${nativeRunFinalizations.failureDetail}->>'replacementWaitingForCleanup', 'false') = 'true' and
        exists (select 1 from environment_leases l where l.company_id = ${heartbeatRuns.companyId}
          and l.heartbeat_run_id = ${heartbeatRuns.id} and l.released_at is null
          and l.status in ('active', 'pending_cleanup') and coalesce(l.cleanup_status, '') not in ('failed', 'success')) then 2
      when ${nativeRunFinalizations.failureCode} = 'native_provider_usage_limit' and
        ${nativeRunFinalizations.nextAttemptAt} > ${now.toISOString()}::timestamptz then 1 else 0 end`,
      nativeRunFinalizations.nextAttemptAt, heartbeatRuns.createdAt, heartbeatRuns.id)
    .limit(25);
  const otherCandidates = await db.select({ run: heartbeatRuns, coordinator: nativeRunFinalizations })
    .from(heartbeatRuns).innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
    .where(and(nativeReplacementPending(), ne(nativeRunFinalizations.failureCode, "native_provider_usage_limit")))
    .orderBy(heartbeatRuns.createdAt, heartbeatRuns.id).limit(25);
  const candidates = [...quotaCandidates, ...otherCandidates];
  let scheduled = 0;
  for (const { run, coordinator } of candidates) {
    const holdQuotaForOperator = async (cause: string, nextAction: string) => {
        await db.transaction(async tx => {
          const [task] = await tx.select().from(issues).where(and(
            eq(issues.id, coordinator.issueId), eq(issues.companyId, run.companyId),
          )).for("update");
          const [current] = await tx.select().from(nativeRunFinalizations).where(and(
            eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId),
          )).for("update");
          if (!current || current.phase !== "terminal_failure" || current.failureCode !== "native_provider_usage_limit" ||
              current.failureDetail?.successorRunId || current.failureDetail?.replacementDenied) return;
          await notifyExecutionRunWork(tx, { companyId: run.companyId });
          await tx.update(nativeRunFinalizations).set({ nextAttemptAt: null, updatedAt: now,
            failureDetail: { ...current.failureDetail, replacementWaitingForCleanup: false, replacementDenied: cause, nextAction },
          }).where(eq(nativeRunFinalizations.runId, run.id));
          if (!task || task.assigneeAgentId !== run.agentId || ["done", "cancelled"].includes(task.status)) return;
          await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
            companyId: run.companyId, sourceIssueId: task.id, kind: "active_run_watchdog",
            ownerType: "board", ownerAgentId: null, returnOwnerAgentId: run.agentId,
            cause, fingerprint: `native-replacement:${run.id}`, evidence: { runId: run.id, attempts: current.attempt },
            nextAction, wakePolicy: null, maxAttempts: 3, supersedeOnIdentityChange: true,
          });
        });
    };
    try {
      if (coordinator.failureDetail?.successorRunId || coordinator.failureDetail?.replacementDenied) continue;
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
      if (leases.some((lease) => lease.releasedAt === null)) {
        if (coordinator.failureCode === "native_provider_usage_limit") {
          if (leases.some(lease => lease.releasedAt === null &&
              (!['active', 'pending_cleanup'].includes(lease.status) || ['failed', 'success'].includes(lease.cleanupStatus ?? '')))) {
            await holdQuotaForOperator("provider_ownership_unverified", "Verify the previous provider and its workspace have stopped before continuing.");
          } else {
            await db.transaction(async tx => {
              await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, coordinator.issueId), eq(issues.companyId, run.companyId))).for("update");
              const [current] = await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)).for("update");
              if (!current || current.phase !== "terminal_failure" || current.failureCode !== "native_provider_usage_limit" || current.failureDetail?.successorRunId || current.failureDetail?.replacementDenied) return;
              const currentLeases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id))).for("update");
              if (!currentLeases.some(lease => lease.releasedAt === null) || currentLeases.some(lease => lease.releasedAt === null &&
                  (!['active', 'pending_cleanup'].includes(lease.status) || ['failed', 'success'].includes(lease.cleanupStatus ?? '')))) {
                await tx.update(nativeRunFinalizations).set({ nextAttemptAt: null, updatedAt: now,
                  failureDetail: { ...current.failureDetail, replacementWaitingForCleanup: false },
                }).where(eq(nativeRunFinalizations.runId, run.id));
                return;
              }
              await tx.update(nativeRunFinalizations).set({ nextAttemptAt: null, updatedAt: now,
                failureDetail: { ...current.failureDetail, replacementWaitingForCleanup: true },
              }).where(eq(nativeRunFinalizations.runId, run.id));
            });
          }
        }
        continue;
      }
      const stoppedSession = coordinator.failureCode !== "native_provider_terminal_failed"
        ? await options.verifyStoppedSession?.(run) ?? null : null;
      // A transport label alone is not evidence. Keep inspecting these candidates
      // as process cleanup and the final transcript become durable.
      if (coordinator.failureCode !== "native_provider_terminal_failed" && !stoppedSession) {
        if (coordinator.failureCode === "native_provider_usage_limit") await holdQuotaForOperator("provider_ownership_unverified", "Verify the previous provider stopped and reconcile its complete action history before continuing.");
        continue;
      }
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
          const completedTaskControlCallIds = stoppedSession?.evidence.completedTaskControlCallIds;
          if (name === "paperclip_finish" && Array.isArray(completedTaskControlCallIds) &&
              completedTaskControlCallIds.includes(p.executionId)) return [];
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
        if (continuation.unresolvedInteractionIds.length > 0) {
          if (coordinator.failureCode === "native_provider_usage_limit") await holdQuotaForOperator("continuation_evidence_incomplete", "Resolve the outstanding task interactions before continuing.");
          continue;
        }
        historyComplete = true;
      } catch {
        /* The named operator outcome retains incomplete context. */
      }
      const remoteWorkspace = await remoteWorkspaceReplacementEvidence(db, run, coordinator.issueId, leases);
      const decision = decideNativeReplacement({
        failedSession: true,
        // A facade transport failure can conceal an authoritative protocol
        // rejection. A stopped process and read receipts do not resolve that.
        failureMeaningKnown:
          Boolean(stoppedSession) || (typeof coordinator.failureDetail?.originalFailureCode === "string" &&
          ![
            "notification_transport_failed",
            "provider_turn_failed",
            "native_provider_terminal_failed",
          ].includes(coordinator.failureDetail.originalFailureCode)),
        predecessorFenced:
          coordinator.leaseOwner === null && run.status === "failed",
        providerStopped:
          !processAlive(run.processPid) &&
          !processAlive(run.processGroupId ? -run.processGroupId : null) &&
          (remoteWorkspace?.providerStopped ?? true),
        workspacePreserved: remoteWorkspace ? remoteWorkspace.workspacePreserved :
          typeof workspace.cwd === "string" &&
          (await stat(workspace.cwd).then(
            (s) => s.isDirectory(),
            () => false,
          )),
        historyComplete,
        effectInventoryComplete:
          Boolean(stoppedSession) || (record(run.runnerProfileJson).recoveryEventInventoryVersion === 1 &&
          record(execution.provider).kind === "codex"),
        attempts: coordinator.attempt,
        invocations,
        apiReceipts: record(record(run.resultJson).apiToolReceipts),
        uncertainProviderActions,
      });
      if (!decision.allowed) {
        // Lack of containment can be temporary; do not prevent the next proof.
        if (decision.cause === "provider_ownership_unverified" && coordinator.failureCode !== "native_provider_usage_limit") continue;
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
          await notifyExecutionRunWork(tx, { companyId: run.companyId });
          await tx
            .update(nativeRunFinalizations)
            .set({
              nextAttemptAt: null,
              failureDetail: {
                ...current.failureDetail,
                replacementWaitingForCleanup: false,
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
      let cooling = false;
      let stopFenced = false;
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
          !["todo", "in_progress", "in_review", "blocked"].includes(task.status) ||
          (task.executionRunId !== null && task.executionRunId !== run.id) ||
          (task.checkoutRunId !== null && task.checkoutRunId !== run.id) ||
          !current ||
          current.phase !== "terminal_failure" ||
          current.leaseOwner !== null ||
          current.failureCode !== coordinator.failureCode ||
          current.failureDetail?.successorRunId ||
          current.failureDetail?.replacementDenied ||
          current.attempt >= 3
        )
          return false;
        if (task.status === "blocked") {
          const failureHolds = await tx.select().from(issueRecoveryActions).where(and(
            eq(issueRecoveryActions.companyId, run.companyId),
            eq(issueRecoveryActions.sourceIssueId, task.id),
            eq(issueRecoveryActions.kind, "active_run_watchdog"),
            eq(issueRecoveryActions.cause, current.failureCode!),
            sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
          )).for("update");
          const ownsBlock = failureHolds.some(hold => {
            const receipt = record(hold.evidence.nativeFailureBlock);
            return receipt.runId === run.id && receipt.statusVersion === task.statusVersion;
          });
          if (!ownsBlock) return false;
        }
        if (remoteWorkspace) {
          const currentWorkspace = await remoteWorkspaceReplacementEvidence(tx, run, coordinator.issueId, leases, true);
          if (!currentWorkspace?.workspacePreserved || !currentWorkspace.providerStopped) return false;
        }
        if (stoppedSession) {
          const [currentRun] = await tx.select().from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
          )).for("update");
          if (current.failureCode === "native_provider_usage_limit" && currentRun &&
              ["requested", "acknowledged"].includes(String(record(record(currentRun.resultJson).executionCancellation).state))) {
            stopFenced = true;
            return false;
          }
          if (!currentRun || currentRun.status !== "failed" || currentRun.runnerInstanceId !== run.runnerInstanceId ||
              currentRun.nativeSessionId !== run.nativeSessionId || currentRun.processPid || currentRun.processGroupId ||
              currentRun.retryOfRunId !== run.retryOfRunId || currentRun.issueId !== run.issueId ||
              ["requested", "acknowledged"].includes(String(record(record(currentRun.resultJson).executionCancellation).state)) ||
              !isDeepStrictEqual(currentRun.contextSnapshot, run.contextSnapshot)) return false;
        }
        let quotaSelection: AiConnectionRouterSelection | undefined;
        let quotaCycleReset = false;
        if (current.failureCode === "native_provider_usage_limit") {
          // The cooldown is account-wide; only the run-bound attribution receipt
          // proves that this particular execution exhausted its selected account.
          const context = record(run.contextSnapshot);
          const selection = record(context.aiRouterSelection);
          const binding = record(selection.binding);
          const taskKey = context.aiRouterTaskKey;
          const poolId = selection.poolId;
          if (run.scopeKind !== "issue" || run.issueId !== task.id ||
              typeof taskKey !== "string" || (taskKey !== task.id && taskKey !== task.identifier) ||
              typeof poolId !== "string" || typeof selection.memberId !== "string" ||
              typeof binding.connectionId !== "string" || typeof binding.grantId !== "string") return false;
          const [receipt] = await tx.select().from(heartbeatRunEvents).where(and(
            eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
            eq(heartbeatRunEvents.agentId, run.agentId), isNull(heartbeatRunEvents.sourceInstanceId),
            eq(heartbeatRunEvents.eventType, "ai_connection.quota_attributed"),
            eq(heartbeatRunEvents.sourceEventId, `ai-connection-quota-attributed:${run.id}`),
          ));
          const attribution = record(receipt?.payload);
          if (attribution.schema !== "paperclip.ai-connection-quota-attribution.v1" ||
              attribution.companyId !== run.companyId || attribution.runId !== run.id ||
              attribution.agentId !== run.agentId || attribution.poolId !== poolId ||
              attribution.taskKey !== taskKey || attribution.memberId !== selection.memberId ||
              attribution.connectionId !== binding.connectionId || attribution.grantId !== binding.grantId ||
              !isDeepStrictEqual(attribution.selection, selection) ||
              typeof attribution.retryAt !== "string" || !Number.isFinite(Date.parse(attribution.retryAt))) return false;
          const attemptedMemberIds = [selection.memberId];
          const attemptedRuns = [run];
          const seenRuns = new Set([run.id]);
          let predecessorId = run.retryOfRunId;
          let childId = run.id;
          while (predecessorId) {
            if (seenRuns.has(predecessorId) || seenRuns.size >= 100) return false;
            seenRuns.add(predecessorId);
            const [predecessor] = await tx.select().from(heartbeatRuns).where(and(
              eq(heartbeatRuns.id, predecessorId), eq(heartbeatRuns.companyId, run.companyId),
              eq(heartbeatRuns.agentId, run.agentId),
            ));
            if (!predecessor || predecessor.issueId !== run.issueId) return false;
            const [predecessorFinalization] = await tx.select().from(nativeRunFinalizations).where(and(
              eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, predecessor.id),
            ));
            if (predecessorFinalization?.failureDetail?.quotaCycleResetSuccessorRunId === childId &&
                predecessorFinalization.failureDetail.successorRunId === childId) break;
            const previous = record(record(predecessor.contextSnapshot).aiRouterSelection);
            if (previous.poolId !== poolId || typeof previous.memberId !== "string") return false;
            if (attemptedMemberIds.includes(previous.memberId)) return false;
            attemptedMemberIds.push(previous.memberId);
            attemptedRuns.push(predecessor);
            childId = predecessor.id;
            predecessorId = predecessor.retryOfRunId;
          }
          const [agent] = await tx.select().from(agents).where(and(
            eq(agents.companyId, run.companyId), eq(agents.id, run.agentId),
          )).for("share");
          const configured = record(record(agent?.runtimeConfig).aiConnection);
          if (!agent || configured.mode !== "router" || configured.connectionId !== poolId) return false;
          const router = aiConnectionRouterService(tx as unknown as Db);
          const transitionInput = {
            companyId: run.companyId, poolId, agentId: run.agentId, taskKey,
            expectedSelection: selection as unknown as AiConnectionRouterSelection,
            userId: run.responsibleUserId, adapterType: agent.adapterType, attemptedMemberIds,
          };
          let transition = await router.transitionQuotaPin(transitionInput);
          if (transition.kind !== "selected") {
            const [pool] = await tx.select().from(aiConnectionPools).where(and(
              eq(aiConnectionPools.companyId, run.companyId), eq(aiConnectionPools.id, poolId),
            ));
            if (!pool) return false;
            const eligible = new Set<string>();
            const future: Date[] = transition.kind === "cooldown" ? [transition.retryAt] : [];
            for (const attempted of attemptedRuns) {
              const attemptedSelection = record(record(attempted.contextSnapshot).aiRouterSelection);
              const attemptedBinding = record(attemptedSelection.binding);
              const [proof] = await tx.select().from(heartbeatRunEvents).where(and(
                eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, attempted.id),
                eq(heartbeatRunEvents.agentId, run.agentId), isNull(heartbeatRunEvents.sourceInstanceId),
                eq(heartbeatRunEvents.eventType, "ai_connection.quota_attributed"),
                eq(heartbeatRunEvents.sourceEventId, `ai-connection-quota-attributed:${attempted.id}`),
              ));
              const p = record(proof?.payload);
              if (p.schema !== "paperclip.ai-connection-quota-attribution.v1" || p.companyId !== run.companyId ||
                  p.runId !== attempted.id || p.agentId !== run.agentId || p.poolId !== poolId || p.taskKey !== taskKey ||
                  p.memberId !== attemptedSelection.memberId || p.connectionId !== attemptedBinding.connectionId ||
                  p.grantId !== attemptedBinding.grantId || !isDeepStrictEqual(p.selection, attemptedSelection) ||
                  typeof p.quotaIdentityHash !== "string" || typeof p.retryAt !== "string" ||
                  !Number.isFinite(Date.parse(p.retryAt)) || typeof attemptedBinding.connectionId !== "string" ||
                  typeof attemptedSelection.memberId !== "string") continue;
              const matchingMember = pool.config.members.find(member => member.id === attemptedSelection.memberId &&
                isDeepStrictEqual(member.binding, attemptedBinding));
              if (!matchingMember) continue;
              const rows = await tx.select().from(aiConnectionQuotaCooldowns).where(and(
                eq(aiConnectionQuotaCooldowns.companyId, run.companyId),
                sql`encode(sha256(convert_to(${aiConnectionQuotaCooldowns.credentialIdentity}, 'UTF8')), 'hex') = ${p.quotaIdentityHash}`,
              ));
              const cooldown = rows.sort((a, b) => b.retryAt.getTime() - a.retryAt.getTime())[0];
              if (!cooldown) continue;
              const deadline = Math.max(cooldown.retryAt.getTime(), Date.parse(p.retryAt));
              if (deadline > now.getTime()) future.push(new Date(deadline));
              else eligible.add(attemptedSelection.memberId);
            }
            if (eligible.size) {
              transition = await router.transitionQuotaPin({ ...transitionInput,
                attemptedMemberIds: pool.config.members.filter(member => !eligible.has(member.id)).map(member => member.id),
              });
              quotaCycleReset = transition.kind === "selected";
            } else if (future.length) {
              transition = { kind: "cooldown", retryAt: new Date(Math.min(...future.map(date => date.getTime()))) };
            }
          }
          if (transition.kind === "cooldown") {
            await tx.update(nativeRunFinalizations).set({ nextAttemptAt: transition.retryAt, updatedAt: now,
              failureDetail: { ...current.failureDetail, replacementWaitingForCleanup: false, nextAction: `Wait for an eligible account's usage limit to reset at ${transition.retryAt.toISOString()}.` },
            }).where(eq(nativeRunFinalizations.runId, run.id));
            cooling = true;
            return false;
          }
          if (transition.kind !== "selected") return false;
          quotaSelection = transition.selection;
        }
        if (task.status === "blocked") {
          // Restore only this failure's unchanged projection. The normal issue
          // service still enforces dependency readiness and assignee eligibility.
          await issueService(tx as unknown as Db).update(task.id, { status: "in_progress" }, tx);
        }
        if (stoppedSession) {
          // If the last ownership proof changes, roll back the status restoration.
          if (!stoppedSession.retire()) throw new Error("native_replacement_stopped_session_changed");
          await appendHeartbeatRunEvent(tx as unknown as Db, {
            companyId: run.companyId, runId: run.id, agentId: run.agentId,
            eventType: "native.stopped_text_turn_verified", stream: "system", level: "info",
            message: "The previous runner and provider stopped. The interrupted turn had no external actions; any completion bookkeeping has a verified receipt.",
            payload: stoppedSession.evidence,
          });
        }
        const successorRunId = randomUUID();
        const dueAt = quotaSelection ? now : new Date(now.getTime() + 30_000);
        const predecessorContext = { ...record(run.contextSnapshot) };
        if (quotaSelection) {
          predecessorContext.aiRouterSelection = quotaSelection;
          delete predecessorContext.aiConnection;
        }
        // History comes from the failed source run. Consumed wake fields must
        // not grant this automatic retry fresh comment/resume authority.
        for (const key of [
          "explicitUserContinuation", "wakeCommentId", "wakeCommentIds", "commentId",
          "commentIds", "latestCommentId", "resumeIntent", "followUpRequested",
          "paperclipWake", "paperclipWakeComment", "paperclipTaskMarkdown", "paperclipTaskMarkdownCompact",
          "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownAssignmentCompact", "paperclipTurnContext",
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
        await notifyExecutionRunWork(tx, { companyId: run.companyId });
        await notifyScheduledRetryDispatch(tx, { companyId: run.companyId });
        await tx.insert(heartbeatRuns).values({
          id: successorRunId,
          companyId: run.companyId,
          agentId: run.agentId,
          ...(quotaSelection ? { scopeKind: "issue" as const, issueId: task.id } : {}),
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
        await options.failpoint?.("successor_inserted");
        await tx
          .update(agentWakeupRequests)
          .set({ runId: successorRunId })
          .where(eq(agentWakeupRequests.id, wake!.id));
        await tx
          .update(nativeRunFinalizations)
          .set({
            failureDetail: {
              ...current.failureDetail,
              ...(quotaCycleReset ? { quotaCycleResetSuccessorRunId: successorRunId } : {}),
              ...(stoppedSession ? { stoppedTextTurn: stoppedSession.evidence } : {}),
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
        // A previous sweep can have resolved the UI bookkeeping while retaining
        // an effective no-replay hold. Retire only this exact failure's hold in
        // the same transaction as its verified successor; unrelated holds remain.
        const holds = await tx.select().from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, run.companyId),
          eq(issueRecoveryActions.sourceIssueId, task.id),
          eq(issueRecoveryActions.kind, "active_run_watchdog"),
          eq(issueRecoveryActions.cause, current.failureCode!),
          sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
        )).for("update");
        if (holds.some(hold => hold.status === "active" || hold.status === "escalated")) {
          await notifyUnsafeWorkspaceExportRecovery(tx, { companyId: run.companyId, issueId: task.id });
        }
        for (const hold of holds) {
          await tx.update(issueRecoveryActions).set({
            status: "resolved", outcome: "handed_back", resolvedAt: now, updatedAt: now,
            wakePolicy: null, monitorPolicy: null,
            nextAction: `Safe continuation is scheduled in run ${successorRunId}.`,
            resolutionNote: "Verified process termination and action receipts allow a fresh session to continue.",
            evidence: { ...hold.evidence, verifiedReplacement: { successorRunId, recordedAt: now.toISOString() },
              ...(hold.evidence.automaticRecovery ? { automaticRecovery: {
                ...record(hold.evidence.automaticRecovery), replay: "verified_safe_replacement", successorRunId,
              } } : {}),
            },
          }).where(eq(issueRecoveryActions.id, hold.id));
        }
        await tx
          .update(heartbeatRuns)
          .set({ executionStatusDeliveryId: randomUUID() })
          .where(eq(heartbeatRuns.id, run.id));
        await notifyNativeStatusReassessment(tx, { companyId: run.companyId, issueId: task.id });
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
        await options.failpoint?.("lineage_committed");
        scheduled += 1;
      } else if (!cooling && !stopFenced && coordinator.failureCode === "native_provider_usage_limit") {
        await holdQuotaForOperator("quota_failover_unavailable", "Inspect account permissions, pool configuration, and the original run before choosing a recovery action.");
      }
    } catch (error) {
      if (options.failpoint) throw error;
      if (coordinator.failureCode === "native_provider_usage_limit") {
        try {
          await holdQuotaForOperator("quota_failover_reconciliation_failed", "Inspect the failed quota recovery and reconcile the original run before continuing.");
        } catch (holdError) {
          logger.warn({ err: holdError, runId: run.id }, "Could not persist the quota recovery operator action");
        }
      }
      logger.warn(
        { runId: run.id },
        "Native replacement remains pending; another sweep will retry its durable decision",
      );
    }
  }
  return { scanned: candidates.length, scheduled };
}

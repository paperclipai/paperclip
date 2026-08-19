import { createHash, randomUUID } from "node:crypto";
import type { AdapterExecutionResult } from "../../adapters/index.js";
import type { NativeFinalizationResult } from "@paperclipai/shared";
import type {
  NativeExecutionInputV1,
  NativeSession,
  NativeSessionBackend,
} from "../../vendor/paperclip-runner/index.js";
import {
  createCodexNativeSessionBackend,
  executeNativeSession,
} from "../../vendor/paperclip-runner/index.js";
import type { Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeAuthoritativeIssueStatus,
  type NativeStatusDecision,
} from "./status-arbiter.js";

type ActiveNativeSession = {
  session: NativeSession;
  cancelRequested: boolean;
};

const activeNativeSessions = new Map<string, ActiveNativeSession>();

export function nativeSessionFailureDisposition(attempt: number, now = new Date()) {
  const exhausted = attempt >= 3;
  return {
    phase: exhausted ? "terminal_failure" as const : "retryable_failure" as const,
    failureCode: exhausted ? "native_session_retry_exhausted" as const : "native_session_interrupted" as const,
    nextAttemptAt: exhausted ? null : new Date(now.getTime() + 30_000),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function cancelNativeSession(runId: string, reason: string): Promise<boolean>;
export function cancelNativeSession(
  runId: string,
  reason: string,
  options: { db: Db; scope?: "turn" | "run" | "issue"; replacementAccepted?: boolean },
): Promise<{ dispatched: boolean; decision: NativeStatusDecision | null; decisionId: string | null; auditId: string | null }>;
export async function cancelNativeSession(
  runId: string,
  reason: string,
  options?: { db: Db; scope?: "turn" | "run" | "issue"; replacementAccepted?: boolean },
): Promise<boolean | { dispatched: boolean; decision: NativeStatusDecision | null; decisionId: string | null; auditId: string | null }> {
  let decision: NativeStatusDecision | null = null;
  let decisionContext: {
    companyId: string;
    issueId: string;
    assessmentId: string | null;
    priorStatus: string;
    priorStatusVersion: number;
    priorDecisionId: string | null;
    agentId: string;
  } | null = null;
  if (options) {
    const run = await options.db.select({
      agentId: heartbeatRuns.agentId,
      companyId: heartbeatRuns.companyId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      runtimeMode: heartbeatRuns.runtimeMode,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1).then((rows) => rows[0] ?? null);
    const context = record(run?.contextSnapshot);
    const issueId = typeof context.issueId === "string"
      ? context.issueId
      : typeof context.taskId === "string" ? context.taskId : null;
    const issue = run && issueId
      ? await options.db.select({
          status: issues.status,
          statusVersion: issues.statusVersion,
          lastStatusDecisionId: issues.lastStatusDecisionId,
        }).from(issues).where(and(
          eq(issues.id, issueId),
          eq(issues.companyId, run.companyId),
        )).limit(1).then((rows) => rows[0] ?? null)
      : null;
    if (run && issue && issueId && run.runtimeMode === "native") {
      decision = resolveNativeCancellationStatus({
        scope: options.scope ?? "run",
        priorIssueStatus: issue.status as NativeAuthoritativeIssueStatus,
        agentId: run.agentId,
        replacementAccepted: options.replacementAccepted,
      });
      const coordinator = await options.db.select({
        assessmentId: nativeRunFinalizations.assessmentId,
      }).from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.runId, runId),
        eq(nativeRunFinalizations.companyId, run.companyId),
        eq(nativeRunFinalizations.issueId, issueId),
      )).limit(1).then((rows) => rows[0] ?? null);
      decisionContext = {
        companyId: run.companyId,
        issueId,
        assessmentId: coordinator?.assessmentId ?? null,
        priorStatus: issue.status,
        priorStatusVersion: Number(issue.statusVersion),
        priorDecisionId: issue.lastStatusDecisionId,
        agentId: run.agentId,
      };
    }
  }
  const active = activeNativeSessions.get(runId);
  let dispatched = false;
  if (active) {
    dispatched = true;
    if (!active.cancelRequested) {
      active.cancelRequested = true;
      try {
        if (active.session.cancel) await active.session.cancel({ reason });
        else if (active.session.interrupt) await active.session.interrupt({ reason });
      } catch (error) {
        active.cancelRequested = false;
        throw error;
      }
    }
  }
  if (!options) return dispatched;

  let decisionId: string | null = null;
  let auditId: string | null = null;
  if (decision && decisionContext) {
    if (decisionContext.assessmentId && decision.reasonCode !== null) {
      const committed = await commitNativeStatusDecision({
        db: options.db,
        companyId: decisionContext.companyId,
        issueId: decisionContext.issueId,
        runId,
        assessmentId: decisionContext.assessmentId,
        priorStatus: decisionContext.priorStatus,
        priorStatusVersion: decisionContext.priorStatusVersion,
        priorDecisionId: decisionContext.priorDecisionId,
        decision,
      });
      decisionId = committed.decision.id;
    } else if (options.replacementAccepted && decision.effects.some((effect) => effect.kind === "accept_replacement_turn")) {
      await options.db.update(heartbeatRuns).set({
        status: "running",
        continuationAttempt: sql`${heartbeatRuns.continuationAttempt} + 1`,
        nextAction: "Accept a replacement native turn on the existing run.",
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, runId));
    }
    const currentRun = await options.db.select({ resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1).then((rows) => rows[0] ?? null);
    await options.db.update(heartbeatRuns).set({
      resultJson: {
        ...record(currentRun?.resultJson),
        nativeCancellation: {
          scope: options.scope ?? "run",
          reasonCode: decision.reasonCode,
          effects: decision.effects.map((effect) => effect.kind),
          dispatched,
          decisionId,
        },
      },
      updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, runId));
    const activity = await persistActivity(options.db, {
      companyId: decisionContext.companyId,
      actorType: "system",
      actorId: "native-session-cancellation",
      action: decisionId ? "issue.status_decision_recorded" : "native.cancellation_audited",
      entityType: "heartbeat_run",
      entityId: runId,
      agentId: decisionContext.agentId,
      runId,
      issueId: decisionContext.issueId,
      details: {
        scope: options.scope ?? "run",
        reasonCode: decision.reasonCode,
        effects: decision.effects.map((effect) => effect.kind),
        dispatched,
        decisionId,
      },
    });
    auditId = activity.activity?.id ?? null;
    publishActivity(activity.publication);
  }
  return { dispatched, decision, decisionId, auditId };
}

/** Authenticated cancellation scope projected through the shared arbiter. */
export function resolveNativeCancellationStatus(input: {
  scope: "turn" | "run" | "issue";
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
  replacementAccepted?: boolean;
}): NativeStatusDecision {
  if (input.scope === "turn") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: input.replacementAccepted ? null : "cancellation_turn_only",
      unblockDescriptor: null,
      effects: [{ kind: "accept_replacement_turn" }],
    };
  }
  if (input.scope === "run") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "cancellation_run_only",
      unblockDescriptor: null,
      effects: [{ kind: "release_run_resources" }],
    };
  }
  return {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "cancelled",
    toStatus: "cancelled",
    reasonCode: "cancellation_issue_authorized",
    unblockDescriptor: null,
    effects: [{ kind: "release_checkout" }, { kind: "cancel_continuations" }],
  };
}

export async function executePaperclipNativeSession(input: {
  db: Db;
  execution: NativeExecutionInputV1;
  runnerInstanceId: string;
  leaseOwner?: string;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  /** Test seam at the provider boundary; production always uses the package Codex backend. */
  backend?: NativeSessionBackend;
}): Promise<AdapterExecutionResult> {
  const leaseOwner = input.leaseOwner ?? `${input.runnerInstanceId}:${randomUUID()}`;
  const leaseNow = new Date();
  const leaseExpiresAt = new Date(leaseNow.getTime() + 20 * 60_000);
  const attempt = await input.db.transaction(async (tx) => {
    const coordinator = await tx.select().from(nativeRunFinalizations)
      .where(and(
        eq(nativeRunFinalizations.runId, input.execution.binding.runId),
        eq(nativeRunFinalizations.companyId, input.execution.binding.companyId),
        eq(nativeRunFinalizations.issueId, input.execution.binding.issueId),
      )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!coordinator) throw new Error("native_finalization_coordinator_missing");
    if (["committed", "applied"].includes(coordinator.phase)) throw new Error("native_run_already_committed");
    if (
      coordinator.leaseOwner
      && coordinator.leaseOwner !== leaseOwner
      && coordinator.leaseExpiresAt
      && coordinator.leaseExpiresAt > leaseNow
    ) throw new Error("native_finalization_lease_busy");
    await tx.update(nativeRunFinalizations).set({
      phase: coordinator.resultId ? coordinator.phase : "observed",
      attempt: coordinator.attempt + 1,
      leaseOwner,
      leaseExpiresAt,
      failureCode: null,
      failureDetail: null,
      nextAttemptAt: null,
      updatedAt: leaseNow,
    }).where(eq(nativeRunFinalizations.runId, coordinator.runId));
    await tx.update(heartbeatRuns).set({
      nativePhase: coordinator.resultId ? coordinator.phase : "observed",
      nativePhaseUpdatedAt: leaseNow,
      updatedAt: leaseNow,
    }).where(eq(heartbeatRuns.id, coordinator.runId));
    return coordinator.attempt + 1;
  });
  const controlPlaneInstanceId = `${input.runnerInstanceId}:control`;
  const controlPlane = new PaperclipControlPlanePort(input.db, {
    companyId: input.execution.binding.companyId,
    issueId: input.execution.binding.issueId,
    runId: input.execution.binding.runId,
    agentId: input.execution.binding.agentId,
    completionContractId: input.execution.completionContract.id,
    completionContractSha256: input.execution.completionContract.sha256,
    sourceInstanceId: input.runnerInstanceId,
    controlPlaneSourceInstanceId: controlPlaneInstanceId,
  });
  let native: Awaited<ReturnType<typeof executeNativeSession>>;
  try {
    native = await executeNativeSession({
      input: input.execution,
      backend: input.backend
        ?? createCodexNativeSessionBackend(input.execution, {
          runnerInstanceId: input.runnerInstanceId,
          onSpawn: input.onSpawn,
        }),
      controlPlane,
      runnerInstanceId: input.runnerInstanceId,
      controlPlaneInstanceId,
      onSession: (session) => {
        if (session) activeNativeSessions.set(input.execution.binding.runId, {
          session,
          cancelRequested: false,
        });
        else activeNativeSessions.delete(input.execution.binding.runId);
      },
    });
  } catch (error) {
    const now = new Date();
    const { phase, failureCode, nextAttemptAt } = nativeSessionFailureDisposition(attempt, now);
    const exhausted = phase === "terminal_failure";
    const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
    await input.db.transaction(async (tx) => {
      const updated = await tx.update(nativeRunFinalizations).set({
        phase,
        leaseOwner: null,
        leaseExpiresAt: null,
        failureCode,
        failureDetail: {
          message,
          originalFailureCode: "native_session_interrupted",
          recoveryOwner: { kind: "agent", agentId: input.execution.binding.agentId },
          nextAction: exhausted
            ? "Inspect the persisted native session after its bounded resume budget was exhausted."
            : "Resume this same run from its persisted native provider checkpoint after the retry delay.",
        },
        nextAttemptAt,
        updatedAt: now,
      }).where(and(
        eq(nativeRunFinalizations.runId, input.execution.binding.runId),
        eq(nativeRunFinalizations.leaseOwner, leaseOwner),
      )).returning({ runId: nativeRunFinalizations.runId }).then((rows) => rows[0] ?? null);
      if (!updated) throw new Error("native_session_lease_lost");
      await tx.update(heartbeatRuns).set({
        nativePhase: phase,
        nativePhaseUpdatedAt: now,
        error: message,
        errorCode: failureCode,
        updatedAt: now,
      }).where(eq(heartbeatRuns.id, input.execution.binding.runId));
      await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
        companyId: input.execution.binding.companyId,
        sourceIssueId: input.execution.binding.issueId,
        kind: "active_run_watchdog",
        ownerType: "agent",
        ownerAgentId: input.execution.binding.agentId,
        cause: failureCode,
        fingerprint: createHash("sha256")
          .update(`${input.execution.binding.runId}:${failureCode}`)
          .digest("hex"),
        evidence: { runId: input.execution.binding.runId, coordinatorAttempt: attempt },
        nextAction: exhausted
          ? "Inspect or explicitly restart the exhausted persisted native session."
          : "Resume the persisted native session on the same heartbeat run.",
        wakePolicy: nextAttemptAt
          ? { kind: "resume_native_run", runId: input.execution.binding.runId, notBefore: nextAttemptAt.toISOString() }
          : null,
        maxAttempts: 3,
      });
    });
    throw error;
  }
  await input.db.update(nativeRunFinalizations).set({
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(nativeRunFinalizations.runId, input.execution.binding.runId),
    eq(nativeRunFinalizations.leaseOwner, leaseOwner),
  ));
  const finalization: NativeFinalizationResult = {
    schema: "paperclip.native-finalization.v1",
    runtimeMode: "native",
    runId: input.execution.binding.runId,
    issueId: input.execution.binding.issueId,
    companyId: input.execution.binding.companyId,
    result: native.result as unknown as Record<string, unknown>,
    terminal: native.terminal,
    turnId: native.turnId,
    sourceInstanceId: input.runnerInstanceId,
    normalizedSessionId: native.normalizedSessionId,
    providerSessionId: native.providerSessionId,
    driverKind: native.driverKind,
    driverVersion: native.driverVersion,
    nativeEventCount: native.nativeEventCount,
    highestContiguousSourceSeq: native.highestContiguousSourceSeq,
    workspaceFinalizeStatus: "pending",
  };
  return {
    exitCode: native.terminal.runTerminalState === "succeeded" ? 0 : 1,
    signal: null,
    timedOut: false,
    errorMessage: native.terminal.runTerminalState === "succeeded"
      ? null
      : `Native session ${native.terminal.runTerminalState}`,
    resultJson: {
      nativeResult: native.result as unknown as Record<string, unknown>,
      nativeTerminal: native.terminal as unknown as Record<string, unknown>,
    },
    summary: native.result.summary,
    sessionId: native.normalizedSessionId,
    sessionDisplayId: native.providerSessionId ?? native.normalizedSessionId,
    provider: "openai",
    usageBasis: "per_run",
    nativeFinalization: finalization,
  };
}

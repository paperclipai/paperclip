import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import { recordNativeLocalProcessStop } from "../native-local-process-stop.js";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeAuthorityWork,
  nativeSessionAuthorities,
} from "@paperclipai/db";
import { readProcessStartedAt } from "../hot-restart.js";
import { getServerInfoSnapshot } from "../../server-info.js";
import { redactSensitiveText } from "../../redaction.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { reportRunFailure } from "../run-failure-report.js";
import { isNativeRunnerOwnershipHeld } from "./native-runner-ownership.js";
import { readRunEventLane } from "../run-event-history.js";

export type NativeControllerIdentity = {
  bootId: string;
  pid: number;
  processStartedAt: Date;
};

export type NativeRestartKind = "hot" | "hard" | "graceful";

export type NativeRestartRecoveryClaim =
  | {
      kind: "reattach_existing_runner";
      runId: string;
      leaseOwner: string;
      controllerGeneration: number;
      providerAttempt: number;
      restartKind: NativeRestartKind;
      recoveryRequestId: string | null;
      process: {
        pid: number;
        processGroupId: number | null;
        startedAt: string;
      };
    }
  | {
      kind: "reattach_remote_runner";
      runId: string;
      leaseOwner: string;
      controllerGeneration: number;
      providerAttempt: number;
      restartKind: NativeRestartKind;
      recoveryRequestId: string | null;
      remote: { providerLeaseId: string; remoteCwd: string };
    }
  | {
      kind: "resume_dead_runner";
      runId: string;
      leaseOwner: string;
      controllerGeneration: number;
      providerAttempt: number;
      restartKind: NativeRestartKind;
      recoveryRequestId: string | null;
    }
  | {
      kind: "bootstrap_incomplete";
      runId: string;
      leaseOwner: string;
      controllerGeneration: number;
      providerAttempt: number;
      restartKind: NativeRestartKind;
      recoveryRequestId: string | null;
    };

export type NativeRestartRecoveryDisposition =
  | NativeRestartRecoveryClaim
  | {
      kind: "awaiting_evidence" | "blocked" | "already_finalized";
      runId: string;
      reason: string;
    };

/** Kept as a bounded diagnostic for retained rows and API compatibility.
 * Ownership is the exact random leaseOwner plus controller identity, never
 * this counter alone. Saturation must not prevent another controller claim
 * or make an old lease valid again. */
export function nextNativeControllerGeneration(current: number): number {
  if (!Number.isInteger(current) || current < 0 || current > 2_147_483_647) {
    throw new Error("native_controller_generation_invalid");
  }
  return Math.min(current + 1, 2_147_483_647);
}

export function nextNativeProviderAttempt(
  currentAttempt: number,
  recoveryKind?: NativeRestartRecoveryClaim["kind"],
): number {
  return recoveryKind === "reattach_existing_runner" ||
    recoveryKind === "reattach_remote_runner"
    ? currentAttempt
    : currentAttempt + 1;
}

const controllerBootId = randomUUID();

function processIsAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

function processGroupIsAlive(
  processGroupId: number | null | undefined,
): boolean {
  if (
    process.platform === "win32" ||
    !processGroupId ||
    !Number.isInteger(processGroupId) ||
    processGroupId <= 0
  ) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

async function observedProcessStart(pid: number): Promise<Date | null> {
  try {
    const startedAt = await readProcessStartedAt(pid);
    if (!startedAt) return null;
    const parsed = new Date(startedAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

export async function currentNativeControllerIdentity(): Promise<NativeControllerIdentity> {
  const observed = await observedProcessStart(process.pid);
  const fallback = new Date(getServerInfoSnapshot().processStartedAt);
  return {
    bootId: controllerBootId,
    pid: process.pid,
    processStartedAt:
      observed ?? (Number.isNaN(fallback.getTime()) ? new Date() : fallback),
  };
}

function sameProcessStart(left: Date | null, right: Date | null): boolean {
  return left !== null && right !== null && left.getTime() === right.getTime();
}

function definitivelyDifferentProcessStart(
  left: Date | null,
  right: Date | null,
): boolean {
  if (left === null || right === null) return false;
  // `ps -o lstart` has only whole-second precision on macOS and BSD. A
  // sub-second disagreement can therefore be the same process when one probe
  // fell back to a higher-precision spawn timestamp. Treat it as ambiguous and
  // fail closed instead of declaring the live PID recycled.
  return Math.abs(left.getTime() - right.getTime()) >= 1_000;
}

export async function evaluateNativeControllerTakeover(input: {
  owner: Pick<
    typeof nativeRunFinalizations.$inferSelect,
    | "leaseOwner"
    | "leaseExpiresAt"
    | "controllerPid"
    | "controllerProcessStartedAt"
  >;
  now: Date;
  coordinatedPreviousController?: {
    pid: number;
    processStartedAt: Date | null;
  } | null;
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartedAt?: (pid: number) => Promise<Date | null>;
}): Promise<{ allowed: boolean; reason: string }> {
  const { owner, now } = input;
  const isAlive = input.isProcessAlive ?? processIsAlive;
  const readStartedAt = input.readProcessStartedAt ?? observedProcessStart;
  if (!owner.leaseOwner || !owner.leaseExpiresAt) {
    return { allowed: true, reason: "unowned" };
  }

  const priorPid = owner.controllerPid;
  if (!priorPid) {
    return {
      allowed: false,
      reason:
        owner.leaseExpiresAt <= now
          ? "expired_lease_without_controller_identity"
          : "live_legacy_lease_without_controller_identity",
    };
  }
  if (!isAlive(priorPid)) {
    return {
      allowed: true,
      reason:
        owner.leaseExpiresAt <= now
          ? "expired_lease_controller_process_dead"
          : "controller_process_dead",
    };
  }

  const observedStartedAt = await readStartedAt(priorPid);
  if (
    owner.controllerProcessStartedAt &&
    observedStartedAt &&
    definitivelyDifferentProcessStart(
      owner.controllerProcessStartedAt,
      observedStartedAt,
    )
  ) {
    return { allowed: true, reason: "controller_pid_recycled" };
  }

  const coordinated = input.coordinatedPreviousController;
  if (
    coordinated &&
    coordinated.pid === priorPid &&
    coordinated.processStartedAt &&
    owner.controllerProcessStartedAt &&
    sameProcessStart(
      coordinated.processStartedAt,
      owner.controllerProcessStartedAt,
    )
  ) {
    return { allowed: false, reason: "coordinated_controller_still_alive" };
  }

  return { allowed: false, reason: "controller_still_alive" };
}

export type NativeProviderProcessIdentity = {
  pid: number;
  processStartedAt: Date | null;
};

export async function evaluateNativeProviderProcesses(input: {
  identities: NativeProviderProcessIdentity[];
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartedAt?: (pid: number) => Promise<Date | null>;
}): Promise<{
  knownPids: number[];
  livePids: number[];
  ambiguousLivePids: number[];
  recycledPids: number[];
}> {
  const isAlive = input.isProcessAlive ?? processIsAlive;
  const readStartedAt = input.readProcessStartedAt ?? observedProcessStart;
  const expectedStarts = new Map<number, Date | null>();
  for (const identity of input.identities) {
    const current = expectedStarts.get(identity.pid);
    if (
      current === undefined ||
      (current === null && identity.processStartedAt)
    ) {
      expectedStarts.set(identity.pid, identity.processStartedAt);
    }
  }

  const livePids: number[] = [];
  const ambiguousLivePids: number[] = [];
  const recycledPids: number[] = [];
  for (const [pid, expectedStartedAt] of expectedStarts) {
    if (!isAlive(pid)) continue;
    const observedStartedAt = await readStartedAt(pid);
    if (!expectedStartedAt || !observedStartedAt) {
      ambiguousLivePids.push(pid);
    } else if (sameProcessStart(expectedStartedAt, observedStartedAt)) {
      livePids.push(pid);
    } else if (
      definitivelyDifferentProcessStart(expectedStartedAt, observedStartedAt)
    ) {
      recycledPids.push(pid);
    } else {
      ambiguousLivePids.push(pid);
    }
  }
  return {
    knownPids: [...expectedStarts.keys()],
    livePids,
    ambiguousLivePids,
    recycledPids,
  };
}

export function classifyNativeRunnerRecoveryEvidence(input: {
  runnerPidAlive: boolean;
  runnerGroupAlive: boolean;
  remoteSandbox?: boolean;
  processStartMatches: boolean;
  knownProviderProcessAlive?: boolean;
  knownProviderProcessIdentityAmbiguous?: boolean;
  unretiredIndexedProcessOwner?: boolean;
  hasCheckpoint: boolean;
  checkpointIdentityMatches?: boolean;
  hasProviderEvidence: boolean;
  checkpointFailed?: boolean;
  providerAttempt?: number;
}): {
  claimKind: NativeRestartRecoveryClaim["kind"] | null;
  reason: string;
} {
  if (input.checkpointFailed)
    return {
      claimKind: null,
      reason: "provider_checkpoint_permanently_failed",
    };
  // Sandbox PIDs belong to another host. This claim only authorizes remote
  // inspection; the executor must prove the original lease and authenticate
  // the surviving runner before it can resume delivery.
  if (input.remoteSandbox) {
    return input.hasCheckpoint &&
      input.checkpointIdentityMatches === true &&
      input.hasProviderEvidence
      ? {
          claimKind: "reattach_remote_runner",
          reason: "remote_runner_requires_sandbox_verification",
        }
      : { claimKind: null, reason: "ambiguous_remote_recovery_evidence" };
  }
  if (input.runnerPidAlive && input.processStartMatches) {
    return {
      claimKind: "reattach_existing_runner",
      reason: "runner_process_identity_verified",
    };
  }
  if (input.runnerPidAlive || input.runnerGroupAlive) {
    return {
      claimKind: null,
      reason: input.runnerPidAlive
        ? "live_runner_identity_mismatch"
        : "live_runner_process_group_without_exact_pid",
    };
  }
  if (input.unretiredIndexedProcessOwner) {
    return {
      claimKind: null,
      reason: "provider_process_tree_retirement_unproven",
    };
  }
  if (input.knownProviderProcessAlive) {
    return {
      claimKind: null,
      reason: "live_provider_process_without_runner_authority",
    };
  }
  if (input.knownProviderProcessIdentityAmbiguous) {
    return {
      claimKind: null,
      reason: "live_provider_process_identity_unverifiable",
    };
  }
  if ((input.providerAttempt ?? 0) >= 3)
    return { claimKind: null, reason: "execution_recovery_budget_exhausted" };
  const checkpointIdentityMatches =
    input.checkpointIdentityMatches ?? input.hasCheckpoint;
  if (
    input.hasCheckpoint &&
    checkpointIdentityMatches &&
    input.hasProviderEvidence
  ) {
    return {
      claimKind: "resume_dead_runner",
      reason: "dead_runner_with_exact_provider_checkpoint",
    };
  }
  if (!input.hasCheckpoint && !input.hasProviderEvidence) {
    return {
      claimKind: "bootstrap_incomplete",
      reason: "dead_runner_before_provider_identity",
    };
  }
  return { claimKind: null, reason: "ambiguous_provider_recovery_evidence" };
}

function historyEntry(input: {
  now: Date;
  restartKind: NativeRestartKind;
  controller: NativeControllerIdentity;
  generation: number;
  disposition: string;
  reason: string;
  requestId: string | null;
  providerAttempt: number;
  processPid: number | null;
  processStartedAt: Date | null;
  hasCheckpoint: boolean;
  checkpointIdentityMatches?: boolean;
  hasProviderEvidence: boolean;
  knownProviderPids?: number[];
  liveProviderPids?: number[];
  ambiguousProviderPids?: number[];
  recycledProviderPids?: number[];
  stderrTail?: string | null;
}) {
  return {
    at: input.now.toISOString(),
    restartKind: input.restartKind,
    controllerBootId: input.controller.bootId,
    controllerPid: input.controller.pid,
    controllerProcessStartedAt: input.controller.processStartedAt.toISOString(),
    controllerGeneration: input.generation,
    disposition: input.disposition,
    reason: input.reason,
    stateRootAction:
      input.disposition === "reattach_existing_runner" ||
      input.disposition === "reattach_remote_runner"
        ? "reopen_exact_root"
        : input.disposition === "resume_dead_runner"
          ? "reuse_exact_root"
          : input.disposition === "bootstrap_incomplete"
            ? "quarantine_incomplete_root_then_bootstrap"
            : input.disposition === "awaiting_evidence"
              ? "preserve_awaiting_evidence"
              : "preserve_fail_closed",
    recoveryRequestId: input.requestId,
    providerAttempt: input.providerAttempt,
    processPid: input.processPid,
    processStartedAt: input.processStartedAt?.toISOString() ?? null,
    hasCheckpoint: input.hasCheckpoint,
    checkpointIdentityMatches: input.checkpointIdentityMatches ?? false,
    hasProviderEvidence: input.hasProviderEvidence,
    knownProviderPids: input.knownProviderPids ?? [],
    liveProviderPids: input.liveProviderPids ?? [],
    ambiguousProviderPids: input.ambiguousProviderPids ?? [],
    recycledProviderPids: input.recycledProviderPids ?? [],
    stderrTail:
      input.stderrTail && input.stderrTail.trim()
        ? redactSensitiveText(input.stderrTail).slice(-4_096)
        : null,
  } satisfies Record<string, unknown>;
}

function appendBoundedRecoveryHistory(entry: Record<string, unknown>) {
  const encoded = JSON.stringify(entry);
  return sql`(
    select coalesce(jsonb_agg(item order by ordinal), '[]'::jsonb)
    from jsonb_array_elements(
      coalesce(${nativeRunFinalizations.recoveryHistory}, '[]'::jsonb)
      || jsonb_build_array(${encoded}::jsonb)
    ) with ordinality as history(item, ordinal)
    where ordinal > greatest(
      jsonb_array_length(
        coalesce(${nativeRunFinalizations.recoveryHistory}, '[]'::jsonb)
        || jsonb_build_array(${encoded}::jsonb)
      ) - 20,
      0
    )
  )`;
}

/**
 * Claims abandoned local runner executions without changing the provider retry
 * attempt. The transaction locks the run, coordinator, and issue execution
 * owner so two successor servers cannot both reconstruct the same authority.
 */
export async function claimNativeRestartRecoveries(input: {
  db: Db;
  controller?: NativeControllerIdentity;
  restartKind: NativeRestartKind;
  recoveryRequestId?: string | null;
  runIds?: string[];
  now?: Date;
  limit?: number;
  coordinatedPreviousController?: {
    pid: number;
    processStartedAt: Date | null;
  } | null;
}): Promise<NativeRestartRecoveryDisposition[]> {
  const now = input.now ?? new Date();
  const controller =
    input.controller ?? (await currentNativeControllerIdentity());
  const candidateQuery = input.db
    .select({
      runId: heartbeatRuns.id,
      issueId: nativeRunFinalizations.issueId,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .innerJoin(
      nativeRunFinalizations,
      eq(nativeRunFinalizations.runId, heartbeatRuns.id),
    )
    .where(
      and(
        eq(heartbeatRuns.runtimeMode, "native"),
        eq(agents.adapterType, "paperclip_runner"),
        inArray(heartbeatRuns.status, ["running", "failed"]),
        isNull(nativeRunFinalizations.resultId),
        or(
          eq(nativeRunFinalizations.phase, "observed"),
          and(
            eq(nativeRunFinalizations.phase, "retryable_failure"),
            or(
              isNull(nativeRunFinalizations.nextAttemptAt),
              lte(nativeRunFinalizations.nextAttemptAt, now),
            ),
          ),
        ),
        ...(input.runIds?.length
          ? [inArray(heartbeatRuns.id, input.runIds)]
          : []),
      ),
    )
    .orderBy(heartbeatRuns.id);
  const candidates = await (input.limit === undefined
    ? candidateQuery
    : candidateQuery.limit(input.limit));

  const dispositions: NativeRestartRecoveryDisposition[] = [];
  for (const candidate of candidates) {
    // Set inside the transaction only when the write below genuinely
    // transitions the run into "failed". Read after the transaction
    // commits, so a rolled-back write never reports a false failure.
    let terminalRunToReport: typeof heartbeatRuns.$inferSelect | null = null;
    const disposition = await input.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
      );
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, candidate.issueId))
        .for("update");
      const row = await tx
        .select({
          run: heartbeatRuns,
          coordinator: nativeRunFinalizations,
          issueExecutionRunId: issues.executionRunId,
          issueAssigneeAgentId: issues.assigneeAgentId,
          issueStatus: issues.status,
        })
        .from(heartbeatRuns)
        .innerJoin(
          nativeRunFinalizations,
          eq(nativeRunFinalizations.runId, heartbeatRuns.id),
        )
        .innerJoin(
          issues,
          and(
            eq(issues.id, nativeRunFinalizations.issueId),
            eq(issues.companyId, nativeRunFinalizations.companyId),
          ),
        )
        .where(eq(heartbeatRuns.id, candidate.runId))
        .for("update")
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!row) {
        return {
          kind: "blocked",
          runId: candidate.runId,
          reason: "recovery_rows_missing",
        } as const;
      }
      if (isNativeRunnerOwnershipHeld(row.run)) {
        return {
          kind: "blocked",
          runId: row.run.id,
          reason: "native_execution_ownership_unverified",
        } as const;
      }
      if (row.coordinator.resultId) {
        return {
          kind: "already_finalized",
          runId: row.run.id,
          reason: "result_already_persisted",
        } as const;
      }
      if (row.issueExecutionRunId !== row.run.id) {
        return {
          kind: "blocked",
          runId: row.run.id,
          reason: "issue_execution_lock_changed",
        } as const;
      }

      const takeover = await evaluateNativeControllerTakeover({
        owner: row.coordinator,
        now,
        coordinatedPreviousController:
          input.coordinatedPreviousController ?? null,
      });
      if (!takeover.allowed) {
        const event = historyEntry({
          now,
          restartKind: input.restartKind,
          controller,
          generation: row.coordinator.controllerGeneration,
          disposition: "awaiting_evidence",
          reason: takeover.reason,
          requestId: input.recoveryRequestId ?? null,
          providerAttempt: row.coordinator.attempt,
          processPid: row.run.processPid,
          processStartedAt: row.run.processStartedAt,
          hasCheckpoint: false,
          hasProviderEvidence: false,
          stderrTail: row.run.stderrExcerpt,
        });
        await tx
          .update(nativeRunFinalizations)
          .set({
            recoveryState: "awaiting_evidence",
            recoveryRequestId: input.recoveryRequestId ?? null,
            recoveryHistory: appendBoundedRecoveryHistory(event),
            updatedAt: now,
          })
          .where(
            and(
              eq(nativeRunFinalizations.runId, row.run.id),
              eq(nativeRunFinalizations.attempt, row.coordinator.attempt),
              eq(nativeRunFinalizations.phase, row.coordinator.phase),
            ),
          );
        return {
          kind: "awaiting_evidence",
          runId: row.run.id,
          reason: takeover.reason,
        } as const;
      }

      const profile = row.run.runnerProfileJson ?? {};
      const remoteWorkspace = readNativeWorkspaceSyncReference(
        profile.nativeWorkspaceSync,
      );
      const remoteSandbox = profile.nativeWorkspaceSync != null;
      const runnerPidAlive =
        !remoteSandbox && processIsAlive(row.run.processPid);
      const runnerGroupAlive =
        !remoteSandbox && processGroupIsAlive(row.run.processGroupId);
      const observedRunnerStart =
        row.run.processPid && runnerPidAlive
          ? await observedProcessStart(row.run.processPid)
          : null;
      const exactRunnerIdentity =
        runnerPidAlive &&
        row.run.processPid !== null &&
        sameProcessStart(row.run.processStartedAt, observedRunnerStart);

      const checkpoint = profile.sessionCheckpoint;
      const checkpointRecord =
        checkpoint &&
        typeof checkpoint === "object" &&
        !Array.isArray(checkpoint)
          ? (checkpoint as Record<string, unknown>)
          : {};
      const hasCheckpoint = checkpoint !== undefined && checkpoint !== null;
      const checkpointIdentity =
        checkpointRecord.identity &&
        typeof checkpointRecord.identity === "object" &&
        !Array.isArray(checkpointRecord.identity)
          ? (checkpointRecord.identity as Record<string, unknown>)
          : {};
      const checkpointIdentityMatches =
        hasCheckpoint &&
        typeof row.run.nativeSessionId === "string" &&
        row.run.nativeSessionId.length > 0 &&
        checkpointIdentity.runId === row.run.id &&
        checkpointIdentity.companyId === row.run.companyId &&
        checkpointIdentity.issueId === row.coordinator.issueId &&
        checkpointIdentity.agentId === row.run.agentId &&
        checkpointIdentity.sessionId === row.run.nativeSessionId;
      const hasCheckpointProviderIdentity =
        (typeof checkpointRecord.providerSessionId === "string" &&
          checkpointRecord.providerSessionId.length > 0) ||
        (checkpointRecord.providerIdentity !== null &&
          typeof checkpointRecord.providerIdentity === "object" &&
          !Array.isArray(checkpointRecord.providerIdentity) &&
          Object.keys(checkpointRecord.providerIdentity).length > 0);
      const [indexedAuthority] = row.run.nativeSessionId ? await tx.select().from(nativeSessionAuthorities).where(and(
        eq(nativeSessionAuthorities.companyId, row.run.companyId),
        eq(nativeSessionAuthorities.issueId, row.coordinator.issueId),
        eq(nativeSessionAuthorities.normalizedSessionId, row.run.nativeSessionId),
        eq(nativeSessionAuthorities.runId, row.run.id),
      )).for("share") : [];
      // A filtered LIMIT over the transcript can still inspect all history when
      // recent output contains none of these event types. Indexed recovery uses
      // the materialized owner relation and sticky bootstrap fact exclusively.
      const providerEvents = indexedAuthority
        ? []
        : (await readRunEventLane(
            tx as unknown as Db,
            row.run.id,
            "provider-identity",
            100,
          ))
            .filter((event) => event.companyId === row.run.companyId)
            .map(({ id, payload }) => ({ id, payload }));
      const checkpointProcess =
        checkpointRecord.process &&
        typeof checkpointRecord.process === "object" &&
        !Array.isArray(checkpointRecord.process)
          ? (checkpointRecord.process as Record<string, unknown>)
          : {};
      const providerProcessIdentities: NativeProviderProcessIdentity[] = [];
      const checkpointProcessFields = [
        ["providerPid", "providerProcessStartedAt"],
        ["codexPid", "codexProcessStartedAt"],
        ["sidecarPid", "sidecarProcessStartedAt"],
        ["agentPid", "agentProcessStartedAt"],
      ] as const;
      for (const [field, startedAtField] of checkpointProcessFields) {
        const value = checkpointProcess[field];
        if (typeof value === "number" && Number.isInteger(value) && value > 0) {
          const rawStartedAt = checkpointProcess[startedAtField];
          const parsedStartedAt =
            typeof rawStartedAt === "string" ? new Date(rawStartedAt) : null;
          providerProcessIdentities.push({
            pid: value,
            processStartedAt:
              parsedStartedAt && !Number.isNaN(parsedStartedAt.getTime())
                ? parsedStartedAt
                : null,
          });
        }
      }
      for (const providerEvent of providerEvents) {
        const prpEvent = providerEvent.payload?.prpEvent;
        const event =
          prpEvent && typeof prpEvent === "object" && !Array.isArray(prpEvent)
            ? (prpEvent as Record<string, unknown>)
            : {};
        const eventPayload =
          event.payload &&
          typeof event.payload === "object" &&
          !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : {};
        const processId = eventPayload.processId;
        if (
          typeof processId === "number" &&
          Number.isInteger(processId) &&
          processId > 0
        ) {
          const rawStartedAt =
            eventPayload.processStartedAt ??
            eventPayload.providerProcessStartedAt;
          const parsedStartedAt =
            typeof rawStartedAt === "string" ? new Date(rawStartedAt) : null;
          providerProcessIdentities.push({
            pid: processId,
            processStartedAt:
              parsedStartedAt && !Number.isNaN(parsedStartedAt.getTime())
                ? parsedStartedAt
                : null,
          });
        }
      }
      const providerProcesses = await evaluateNativeProviderProcesses({
        identities: (remoteSandbox ? [] : providerProcessIdentities).filter(
          (identity) => identity.pid !== row.run.processPid,
        ),
      });
      // Indexed owners are current authority, independent of transcript rows.
      // Admission checks their presence without loading historical launch facts.
      let indexedOwnerEvidence = false;
      let unretiredIndexedProcessOwner = false;
      if (indexedAuthority) {
        const authority = indexedAuthority;
        if (authority.successorRunId !== null) throw new Error("native_process_owner_authority_superseded");
        if (authority.stateSha256 !== createHash("sha256").update(authority.state).digest("hex")) throw new Error("native_process_owner_authority_corrupt");
        const currentState = JSON.parse(authority.state);
        const currentIdentity = currentState.identity;
        if (currentIdentity?.normalizedSessionId !== row.run.nativeSessionId || currentIdentity?.runId !== row.run.id) throw new Error("native_process_owner_authority_binding_invalid");
        if (currentState.indexedState?.processOwnerIndexVersion !== 1 || typeof currentState.indexedState?.providerEverStarted !== "boolean") throw new Error("native_process_owner_index_not_ready");
        indexedOwnerEvidence = currentState.indexedState.providerEverStarted;
        // A surviving runner retains ownership; reattachment only restores
        // its authenticated transport. Replacement requires retirement of
        // every earlier launch, including children which escaped a process
        // group. A missing PID cannot establish that proof. Any unresolved
        // owner therefore holds replacement; an indexed existence query is
        // sufficient regardless of the number of earlier launches. Remote
        // reattachment separately verifies the original sandbox and runner.
        if (!exactRunnerIdentity && !remoteSandbox) {
          const unresolved = await tx.select({ workId: nativeAuthorityWork.workId })
            .from(nativeAuthorityWork).where(and(
              eq(nativeAuthorityWork.companyId, row.run.companyId),
              eq(nativeAuthorityWork.issueId, row.coordinator.issueId),
              eq(nativeAuthorityWork.normalizedSessionId, authority.normalizedSessionId),
              eq(nativeAuthorityWork.collection, "process-owner"),
            )).limit(1);
          unretiredIndexedProcessOwner = unresolved.length > 0;
          indexedOwnerEvidence ||= unretiredIndexedProcessOwner;
        }
      }
      const hasProviderEvidence =
        hasCheckpointProviderIdentity || providerEvents.length > 0 || indexedOwnerEvidence;

      const classification = classifyNativeRunnerRecoveryEvidence({
        remoteSandbox,
        runnerPidAlive,
        runnerGroupAlive,
        processStartMatches: exactRunnerIdentity,
        knownProviderProcessAlive: providerProcesses.livePids.length > 0,
        knownProviderProcessIdentityAmbiguous:
          providerProcesses.ambiguousLivePids.length > 0,
        unretiredIndexedProcessOwner,
        hasCheckpoint,
        checkpointIdentityMatches:
          checkpointIdentityMatches &&
          (!remoteSandbox || remoteWorkspace !== null),
        hasProviderEvidence,
        checkpointFailed:
          (checkpointRecord.terminal as Record<string, unknown> | undefined)
            ?.runTerminalState === "failed",
        providerAttempt: row.coordinator.attempt,
      });
      const ownershipChanged =
        row.issueAssigneeAgentId !== row.run.agentId ||
        ["done", "cancelled"].includes(row.issueStatus);
      const claimKind = ownershipChanged ? null : classification.claimKind;
      const reason = ownershipChanged
        ? "task_ownership_or_status_changed"
        : classification.reason;

      if (!claimKind) {
        const generation = row.coordinator.controllerGeneration;
        const event = historyEntry({
          now,
          restartKind: input.restartKind,
          controller,
          generation,
          disposition: "blocked",
          reason,
          requestId: input.recoveryRequestId ?? null,
          providerAttempt: row.coordinator.attempt,
          processPid: row.run.processPid,
          processStartedAt: row.run.processStartedAt,
          hasCheckpoint,
          checkpointIdentityMatches,
          hasProviderEvidence,
          knownProviderPids: providerProcesses.knownPids,
          liveProviderPids: providerProcesses.livePids,
          ambiguousProviderPids: providerProcesses.ambiguousLivePids,
          recycledProviderPids: providerProcesses.recycledPids,
          stderrTail: row.run.stderrExcerpt,
        });
        await tx
          .update(nativeRunFinalizations)
          .set({
            phase: "terminal_failure",
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            failureCode: "native_restart_recovery_blocked",
            failureDetail: {
              ...row.coordinator.failureDetail,
              reason,
              nextAction:
                "Inspect the preserved checkpoint and reconcile the previous execution before starting a fresh session.",
            },
            recoveryState: "blocked",
            recoveryRequestId: input.recoveryRequestId ?? null,
            recoveryHistory: appendBoundedRecoveryHistory(event),
            updatedAt: now,
          })
          .where(
            and(
              eq(nativeRunFinalizations.runId, row.run.id),
              eq(nativeRunFinalizations.attempt, row.coordinator.attempt),
              eq(nativeRunFinalizations.phase, row.coordinator.phase),
            ),
          );
        const [updatedRun] = await tx
          .update(heartbeatRuns)
          .set({
            status: "failed",
            nativePhase: "terminal_failure",
            nativePhaseUpdatedAt: now,
            executionStatusDeliveryId: randomUUID(),
            finishedAt: now,
            errorCode: "native_restart_recovery_blocked",
            error: reason,
            updatedAt: now,
          })
          .where(eq(heartbeatRuns.id, row.run.id))
          .returning();
        if (updatedRun && updatedRun.status !== row.run.status) {
          terminalRunToReport = updatedRun;
        }
        await tx
          .update(issues)
          .set({ executionRunId: null, updatedAt: now })
          .where(
            and(
              eq(issues.id, row.coordinator.issueId),
              eq(issues.companyId, row.run.companyId),
              eq(issues.executionRunId, row.run.id),
            ),
          );
        await tx
          .update(issues)
          .set({ checkoutRunId: null, updatedAt: now })
          .where(
            and(
              eq(issues.id, row.coordinator.issueId),
              eq(issues.companyId, row.run.companyId),
              eq(issues.checkoutRunId, row.run.id),
            ),
          );
        if (
          row.issueAssigneeAgentId === row.run.agentId &&
          !["done", "cancelled"].includes(row.issueStatus)
        )
          await issueRecoveryActionService(
            tx as unknown as Db,
          ).upsertSourceScoped({
            companyId: row.run.companyId,
            sourceIssueId: row.coordinator.issueId,
            kind: "active_run_watchdog",
            ownerType: "board",
            returnOwnerAgentId: row.run.agentId,
            cause: "native_restart_recovery_blocked",
            fingerprint: `native-restart:${row.run.id}`,
            evidence: {
              runId: row.run.id,
              reason,
              providerAttempt: row.coordinator.attempt,
            },
            nextAction:
              "Inspect the preserved checkpoint and reconcile the previous execution before starting a fresh session.",
            maxAttempts: 3,
            wakePolicy: null,
            supersedeOnIdentityChange: true,
          });
        return { kind: "blocked", runId: row.run.id, reason } as const;
      }

      const generation = nextNativeControllerGeneration(row.coordinator.controllerGeneration);
      const leaseOwner = `${controller.bootId}:${generation}:${randomUUID()}`;
      const event = historyEntry({
        now,
        restartKind: input.restartKind,
        controller,
        generation,
        disposition: claimKind,
        reason,
        requestId: input.recoveryRequestId ?? null,
        providerAttempt: row.coordinator.attempt,
        processPid: row.run.processPid,
        processStartedAt: row.run.processStartedAt,
        hasCheckpoint,
        checkpointIdentityMatches,
        hasProviderEvidence,
        knownProviderPids: providerProcesses.knownPids,
        liveProviderPids: providerProcesses.livePids,
        ambiguousProviderPids: providerProcesses.ambiguousLivePids,
        recycledProviderPids: providerProcesses.recycledPids,
        stderrTail: row.run.stderrExcerpt,
      });
      const claimed = await tx
        .update(nativeRunFinalizations)
        .set({
          phase: "observed",
          leaseOwner,
          leaseExpiresAt: new Date(now.getTime() + 20 * 60_000),
          controllerBootId: controller.bootId,
          controllerPid: controller.pid,
          controllerProcessStartedAt: controller.processStartedAt,
          controllerGeneration: generation,
          recoveryState:
            claimKind === "reattach_existing_runner" ||
            claimKind === "reattach_remote_runner"
              ? "awaiting_runner_reattach"
              : claimKind === "resume_dead_runner"
                ? "resuming_session"
                : "bootstrap_incomplete",
          recoveryRequestId: input.recoveryRequestId ?? null,
          recoveryHistory: appendBoundedRecoveryHistory(event),
          failureCode: null,
          nextAttemptAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(nativeRunFinalizations.runId, row.run.id),
            eq(nativeRunFinalizations.attempt, row.coordinator.attempt),
            eq(nativeRunFinalizations.phase, row.coordinator.phase),
            row.coordinator.leaseOwner === null
              ? isNull(nativeRunFinalizations.leaseOwner)
              : eq(
                  nativeRunFinalizations.leaseOwner,
                  row.coordinator.leaseOwner,
                ),
          ),
        )
        .returning({ runId: nativeRunFinalizations.runId })
        .then((rows) => rows[0] ?? null);
      if (!claimed) {
        return {
          kind: "awaiting_evidence",
          runId: row.run.id,
          reason: "concurrent_recovery_claim",
        } as const;
      }

      if (
        claimKind !== "reattach_existing_runner" &&
        claimKind !== "reattach_remote_runner"
      ) {
        await recordNativeLocalProcessStop(tx as unknown as Db, row.run);
      }

      await tx
        .update(heartbeatRuns)
        .set({
          status: "running",
          finishedAt: null,
          error: null,
          errorCode: null,
          nativePhase: "observed",
          nativePhaseUpdatedAt: now,
          ...(claimKind === "reattach_existing_runner" ||
          claimKind === "reattach_remote_runner"
            ? {}
            : {
                processPid: null,
                processGroupId: null,
                processStartedAt: null,
              }),
          updatedAt: now,
        })
        .where(eq(heartbeatRuns.id, row.run.id));

      const common = {
        runId: row.run.id,
        leaseOwner,
        controllerGeneration: generation,
        providerAttempt: row.coordinator.attempt,
        restartKind: input.restartKind,
        recoveryRequestId: input.recoveryRequestId ?? null,
      };
      if (claimKind === "reattach_remote_runner") {
        return {
          kind: claimKind,
          ...common,
          remote: {
            providerLeaseId: remoteWorkspace!.providerLeaseId,
            remoteCwd: remoteWorkspace!.remoteCwd,
          },
        } satisfies NativeRestartRecoveryClaim;
      }
      if (claimKind === "reattach_existing_runner") {
        return {
          kind: claimKind,
          ...common,
          process: {
            pid: row.run.processPid!,
            processGroupId: row.run.processGroupId,
            startedAt: row.run.processStartedAt!.toISOString(),
          },
        } satisfies NativeRestartRecoveryClaim;
      }
      return {
        kind: claimKind,
        ...common,
      } satisfies NativeRestartRecoveryClaim;
    });
    if (terminalRunToReport)
      void reportRunFailure(input.db, terminalRunToReport);
    dispositions.push(disposition);
  }
  return dispositions;
}

export async function nativeRestartRecoverySummary(db: Db) {
  const rows = await db
    .select({
      state: nativeRunFinalizations.recoveryState,
      count: sql<number>`count(*)::int`,
    })
    .from(nativeRunFinalizations)
    .where(
      inArray(nativeRunFinalizations.recoveryState, [
        "awaiting_evidence",
        "awaiting_runner_reattach",
        "resuming_session",
        "bootstrap_incomplete",
        "blocked",
      ]),
    )
    .groupBy(nativeRunFinalizations.recoveryState);
  return Object.fromEntries(
    rows.map((row) => [row.state ?? "unknown", row.count]),
  );
}

import { beginRunPhase } from "../execution-preparation-timing.js";
import { logActivity } from "../activity-log.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { nativeSha256 } from "./canonical.js";
import { NATIVE_WORKSPACE_OWNER_UNVERIFIED } from "./native-workspace-finalization-recovery-state.js";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations, workspaceOperations, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { currentNativeWorkspaceRecoveryResult } from "./native-workspace-recovery-binding.js";
import { withWorkspaceLockKeepalive } from "./native-workspace-lock-keepalive.js";
import {
  currentNativeControllerIdentity,
  evaluateNativeControllerTakeover,
} from "./native-restart-recovery.js";

import { currentWorkspaceWorker, requestWorkspaceWorkerStopProof, type WorkspaceWorker, type WorkspaceWorkerStopProof } from "./native-workspace-platform-proof.js";

const OWNER_KEY = "nativeWorkspaceFinalizationOwner";
const activeOwnerTokens = new Set<string>();
// Positive same-boot evidence, retained only when durable cleanup could not be
// confirmed. Absence from the active set alone never proves another token joined.
const joinedOwnerTokens = new Set<string>();
type Owner = {
  token: string;
  controllerBootId?: string;
  hostname: string;
  pid: number;
  processStartedAt: string;
  worker?: WorkspaceWorker;
};
export type NativeWorkspaceFinalizationOwnership = {
  token: string;
  /** Recheck both the physical lock connection and the durable owner before publishing. */
  assertHeld(): Promise<void>;
};
export class NativeWorkspaceFinalizationBusyError extends Error {
  constructor() { super("native_workspace_finalization_busy"); }
}
export class NativeWorkspaceFinalizationOwnershipLostError extends Error {
  constructor(options?: ErrorOptions) {
    super("native_workspace_finalization_ownership_lost", options);
  }
}

function readOwner(value: unknown): Owner | null {
  if (!value || typeof value !== "object") return null;
  const owner = value as Partial<Owner>;
  return typeof owner.token === "string" && typeof owner.hostname === "string"
    && Number.isInteger(owner.pid) && Number(owner.pid) > 0
    && typeof owner.processStartedAt === "string" && Number.isFinite(Date.parse(owner.processStartedAt))
    ? owner as Owner : null;
}

/**
 * The advisory lock serializes controllers without holding row locks across I/O.
 * The durable receipt additionally prevents a disconnected lock session from
 * authorizing takeover while its controller is still doing physical copyback.
 * There is deliberately no wall-clock timeout that can steal a slow export.
 */
export async function withNativeWorkspaceFinalizationOwnership<T>(
  input: { db: Db; companyId: string; runId: string; retainedRepairActionId?: string },
  action: (ownership: NativeWorkspaceFinalizationOwnership) => Promise<T>,
): Promise<{ acquired: false; reason?: "owner_unverified" } | { acquired: true; value: T }> {
  const identity = await currentNativeControllerIdentity();
  const owner: Owner = {
    token: randomUUID(), controllerBootId: identity.bootId, hostname: os.hostname(), pid: identity.pid,
    processStartedAt: identity.processStartedAt.toISOString(), worker: currentWorkspaceWorker(),
  };
  const scope = and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    input.retainedRepairActionId ? inArray(heartbeatRuns.runtimeMode, ["native", "legacy"]) : eq(heartbeatRuns.runtimeMode, "native"));
  const owned = and(scope, sql`${heartbeatRuns.runnerProfileJson}->${OWNER_KEY}->>'token' = ${owner.token}`);
  let claimed = false;
  let actionPromise: Promise<T> | undefined;
  const finishAcquisition = beginRunPhase("execution.workspace_ownership_wait");
  try {
    return await withDedicatedDbConnection(input.db, (dedicated) => dedicated.transaction(async (lock) => {
      const rows = await lock.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`native-workspace-finalization:${input.companyId}:${input.runId}`}, 0)) as acquired,
        (select setting::bigint from pg_settings where name = 'idle_in_transaction_session_timeout') as idle_timeout_ms`);
      if (rows[0]?.acquired !== true) return { acquired: false } as const;
      return withWorkspaceLockKeepalive(lock as unknown as Db, Number(rows[0].idle_timeout_ms), async () => {
        // Reads and durable progress use the ordinary pool, not the lock transaction.
        const [run] = await input.db.select({ profile: heartbeatRuns.runnerProfileJson,
          issueId: sql<string | null>`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')`,
          agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(scope).limit(1);
        if (!run) throw new Error("native_workspace_finalization_binding_missing");
        const rawPrior = run.profile?.[OWNER_KEY];
        const prior = readOwner(rawPrior);
        let automaticResultId: string | undefined;
        const currentRecoveryResult = async (db: Db) => {
          if (!run.issueId) return null;
          // Use the arbiter's lock order and release row locks before copyback I/O.
          const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
            eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId),
            eq(nativeRunFinalizations.issueId, run.issueId),
          )).for("update");
          const [issue] = await db.select().from(issues).where(and(
            eq(issues.companyId, input.companyId), eq(issues.id, run.issueId),
          )).for("update");
          const [currentRun] = await db.select().from(heartbeatRuns).where(scope).for("update");
          if (input.retainedRepairActionId) {
            const [repair] = await db.select().from(issueRecoveryActions).where(and(
              eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, run.issueId),
              eq(issueRecoveryActions.id, input.retainedRepairActionId),
            )).for("update");
            const continuation = repair?.evidence.explicitUserContinuation as {
              runId?: string; readiness?: { mode?: string; sourceRunId?: string };
            } | undefined;
            const independentRun = continuation?.readiness?.mode === "fresh_isolated_workspace"
              && continuation.readiness.sourceRunId === input.runId ? continuation.runId : undefined;
            return currentRun && issue && repair && repair.evidence.runId === currentRun.id
              && repair.evidence.workspaceRecovery && !coordinator?.leaseOwner
              && ["failed", "interrupted", "timed_out", "cancelled", "succeeded"].includes(currentRun.status)
              && (!issue.executionRunId || issue.executionRunId === independentRun)
              && (!issue.checkoutRunId || issue.checkoutRunId === independentRun) ? repair : null;
          }
          return coordinator && issue && currentRun ? currentNativeWorkspaceRecoveryResult(db, {
            companyId: input.companyId, coordinator, issue, run: currentRun,
          }) : null;
        };
        let platformProof: WorkspaceWorkerStopProof | null = null;
        if (rawPrior != null) {
          const requireStopVerification = async () => {
            if (input.retainedRepairActionId) return { acquired: false, reason: "owner_unverified" } as const;
            const fingerprint = nativeSha256({ runId: input.runId, owner: rawPrior });
            const nextAction = "Verify the previous controller and its workspace-copyback processes have stopped, then release only this exact workspace owner receipt using doc/native-workspace-finalization-recovery.md. Resume workspace finalization without another provider turn.";
            const recovery = issueRecoveryActionService(input.db);
            const existing = run.issueId ? await recovery.getActiveForIssue(input.companyId, run.issueId) : null;
            // Rechecking the same physical owner is not a new recovery attempt.
            if (existing?.cause === NATIVE_WORKSPACE_OWNER_UNVERIFIED && existing.fingerprint === fingerprint) {
              if (!existing.evidence?.workspaceOwnerStop) {
                await input.db.update(issueRecoveryActions).set({ nextAction, updatedAt: new Date(),
                  evidence: sql`jsonb_set(coalesce(${issueRecoveryActions.evidence}, '{}'::jsonb), '{workspaceOwnerRecovery}', '{"state":"operator_required"}'::jsonb)`,
                }).where(and(
                  eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, existing.id),
                  eq(issueRecoveryActions.fingerprint, fingerprint), eq(issueRecoveryActions.cause, NATIVE_WORKSPACE_OWNER_UNVERIFIED),
                  inArray(issueRecoveryActions.status, ["active", "escalated"]),
                  sql`${issueRecoveryActions.evidence}->'workspaceOwnerStop' is null`,
                  sql`(${issueRecoveryActions.nextAction} is distinct from ${nextAction} or ${issueRecoveryActions.evidence}#>>'{workspaceOwnerRecovery,state}' is distinct from 'operator_required')`,
                ));
              }
              return { acquired: false } as const;
            }
            if (run.issueId) await recovery.upsertSourceScoped({
              companyId: input.companyId, sourceIssueId: run.issueId,
              kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: run.agentId,
              cause: NATIVE_WORKSPACE_OWNER_UNVERIFIED,
              fingerprint,
              evidence: { runId: input.runId, owner: rawPrior, workspaceOwnerRecovery: { state: "operator_required" } },
              nextAction,
              wakePolicy: null, maxAttempts: 1, supersedeOnIdentityChange: true,
            });
            return { acquired: false } as const;
          };
          // The harness checks the exact owned deployment, including orphaned children.
          // A live deployment, unsigned answer or older receipt stays fenced.
          if (prior?.worker) platformProof = await requestWorkspaceWorkerStopProof({ runId: input.runId, ownerToken: prior.token, worker: prior.worker });
          if (!prior) return requireStopVerification();
          if (!platformProof && prior.hostname !== owner.hostname) return requireStopVerification();
          const knownJoinedHere = prior.controllerBootId === identity.bootId
            && prior.pid === identity.pid && joinedOwnerTokens.has(prior.token)
            && !activeOwnerTokens.has(prior.token);
          if (!platformProof && !knownJoinedHere) {
            const takeover = await evaluateNativeControllerTakeover({
              owner: { leaseOwner: prior.token, leaseExpiresAt: new Date(0), controllerPid: prior.pid,
                controllerProcessStartedAt: new Date(prior.processStartedAt) }, now: new Date(),
            });
            if (!takeover.allowed) return requireStopVerification();
            // A dead parent may have orphaned tar/Git children. Only a durable
            // completed-copyback barrier proves they joined; otherwise board proof
            // is required even on the same host. Both callers reuse this barrier.
            const [completedCopyback] = await input.db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
              eq(workspaceOperations.companyId, input.companyId),
              eq(workspaceOperations.heartbeatRunId, input.runId),
              eq(workspaceOperations.issueId, run.issueId!),
              eq(workspaceOperations.phase, "workspace_finalize"),
              eq(workspaceOperations.status, "succeeded"),
            )).limit(1);
            if (!completedCopyback) return requireStopVerification();
          }
        }
        // Claim before the potentially ambiguous write so finally can remove
        // only our token even if the server committed but its response was lost.
        const claimOwner = async (db: Db) => {
          activeOwnerTokens.add(owner.token);
          claimed = true;
          const [claimedRun] = await db.update(heartbeatRuns).set({
            runnerProfileJson: sql`jsonb_set(coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb), array[${OWNER_KEY}], ${JSON.stringify(owner)}::jsonb) || ${JSON.stringify(platformProof ? { nativeWorkspaceOwnerStopProof: platformProof } : {})}::jsonb`,
          }).where(and(scope, prior
            ? sql`${heartbeatRuns.runnerProfileJson}->${OWNER_KEY} = ${JSON.stringify(rawPrior)}::jsonb`
            : sql`${heartbeatRuns.runnerProfileJson}->>${OWNER_KEY} is null`
          )).returning({ id: heartbeatRuns.id });
          return claimedRun;
        };
        // A stop receipt proves the old worker exited, not that its task is still
        // current. Revalidate after the provider read and atomically with the CAS.
        const claimedRun = platformProof ? await input.db.transaction(async tx => {
          const result = await currentRecoveryResult(tx as unknown as Db);
          if (!result) return null;
          const claimedRun = await claimOwner(tx as unknown as Db);
          if (claimedRun) automaticResultId = result.id;
          return claimedRun;
        }) : await claimOwner(input.db);
        if (!claimedRun) return { acquired: false } as const;
        if (platformProof && run.issueId) await logActivity(input.db, {
          companyId: input.companyId, actorType: "system", actorId: "workspace-recovery",
          action: "issue.workspace_owner_stop_verified", entityType: "issue", entityId: run.issueId,
          runId: input.runId, details: { proof: platformProof },
        });
        if (prior) joinedOwnerTokens.delete(prior.token);
        const ownership: NativeWorkspaceFinalizationOwnership = {
          token: owner.token,
          assertHeld: async () => {
            try {
              // A failed transaction is never transparently reconnected by the DB client.
              await lock.execute(sql`select 1`);
              const [current] = await input.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(owned).limit(1);
              if (!current) throw new Error("owner_replaced");
              if (automaticResultId) {
                const result = await input.db.transaction(tx => currentRecoveryResult(tx as unknown as Db));
                if (result?.id !== automaticResultId) throw new Error("task_replaced");
              }
            } catch (cause) {
              throw new NativeWorkspaceFinalizationOwnershipLostError({ cause });
            }
          },
        };
        await ownership.assertHeld();
        if (platformProof && run.issueId) await input.db.update(issueRecoveryActions).set({
          evidence: sql`jsonb_set(coalesce(${issueRecoveryActions.evidence}, '{}'::jsonb), '{workspaceOwnerRecovery}', '{"state":"resuming"}'::jsonb)`,
          updatedAt: new Date(),
        }).where(and(
          eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, run.issueId),
          eq(issueRecoveryActions.cause, NATIVE_WORKSPACE_OWNER_UNVERIFIED),
          eq(issueRecoveryActions.fingerprint, nativeSha256({ runId: input.runId, owner: rawPrior })),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
        ));
        finishAcquisition();
        actionPromise = action(ownership);
        const value = await actionPromise;
        await ownership.assertHeld();
        return { acquired: true, value } as const;
      });
    }));
  } catch (error) {
    finishAcquisition(true);
    throw error;
  } finally {
    finishAcquisition();
    // postgres.js may reject the transaction when the socket dies before the
    // callback settles. Join that callback before releasing its durable fence.
    await actionPromise?.catch(() => undefined);
    if (claimed) {
      activeOwnerTokens.delete(owner.token);
      joinedOwnerTokens.add(owner.token);
      try {
        await input.db.update(heartbeatRuns).set({
          runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) - ${OWNER_KEY}`,
        }).where(owned);
        joinedOwnerTokens.delete(owner.token);
      } catch {
        // A reconnect in this exact controller boot can use the positive join
        // receipt. A new boot still needs durable barrier or operator proof.
      }
    }
  }
}

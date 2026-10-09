import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { nativeSha256 } from "./canonical.js";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, workspaceOperations, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import {
  currentNativeControllerIdentity,
  evaluateNativeControllerTakeover,
} from "./native-restart-recovery.js";

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
  input: { db: Db; companyId: string; runId: string },
  action: (ownership: NativeWorkspaceFinalizationOwnership) => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const identity = await currentNativeControllerIdentity();
  const owner: Owner = {
    token: randomUUID(), controllerBootId: identity.bootId, hostname: os.hostname(), pid: identity.pid,
    processStartedAt: identity.processStartedAt.toISOString(),
  };
  const scope = and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.runtimeMode, "native"));
  const owned = and(scope, sql`${heartbeatRuns.runnerProfileJson}->${OWNER_KEY}->>'token' = ${owner.token}`);
  let claimed = false;
  let actionPromise: Promise<T> | undefined;
  try {
    return await withDedicatedDbConnection(input.db, (dedicated) => dedicated.transaction(async (lock) => {
      const rows = await lock.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`native-workspace-finalization:${input.companyId}:${input.runId}`}, 0)) as acquired`);
      if (rows[0]?.acquired !== true) return { acquired: false } as const;
      // Reads and durable progress use the ordinary pool, not the lock transaction.
      const [run] = await input.db.select({ profile: heartbeatRuns.runnerProfileJson, issueId: heartbeatRuns.nativeIssueId, agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(scope).limit(1);
      if (!run) throw new Error("native_workspace_finalization_binding_missing");
      const rawPrior = run.profile?.[OWNER_KEY];
      const prior = readOwner(rawPrior);
      if (rawPrior != null) {
        const requireStopVerification = async () => {
          if (run.issueId) await issueRecoveryActionService(input.db).upsertSourceScoped({
            companyId: input.companyId, sourceIssueId: run.issueId,
            kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: run.agentId,
            cause: "native_workspace_finalization_owner_unverified",
            fingerprint: nativeSha256({ runId: input.runId, owner: rawPrior }),
            evidence: { runId: input.runId, owner: rawPrior },
            nextAction: "Verify the previous controller and its workspace-copyback processes have stopped, then release only this exact workspace owner receipt using doc/native-workspace-finalization-recovery.md. Resume workspace finalization without another provider turn.",
            wakePolicy: null, maxAttempts: 1, supersedeOnIdentityChange: true,
          });
          return { acquired: false } as const;
        };
        // A foreign host or malformed receipt cannot prove the old physical owner stopped.
        if (!prior || prior.hostname !== owner.hostname) return requireStopVerification();
        const knownJoinedHere = prior.controllerBootId === identity.bootId
          && prior.pid === identity.pid && joinedOwnerTokens.has(prior.token)
          && !activeOwnerTokens.has(prior.token);
        if (!knownJoinedHere) {
          const takeover = await evaluateNativeControllerTakeover({
            owner: { leaseOwner: prior.token, leaseExpiresAt: new Date(0), controllerPid: prior.pid,
              controllerProcessStartedAt: new Date(prior.processStartedAt) }, now: new Date(),
          });
          if (!takeover.allowed) return { acquired: false } as const;
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
      activeOwnerTokens.add(owner.token);
      claimed = true;
      const [claimedRun] = await input.db.update(heartbeatRuns).set({
        runnerProfileJson: sql`jsonb_set(coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb), array[${OWNER_KEY}], ${JSON.stringify(owner)}::jsonb)`,
      }).where(and(scope, prior
        ? sql`${heartbeatRuns.runnerProfileJson}->${OWNER_KEY}->>'token' = ${prior.token}`
        : sql`${heartbeatRuns.runnerProfileJson}->>${OWNER_KEY} is null`
      )).returning({ id: heartbeatRuns.id });
      if (!claimedRun) return { acquired: false } as const;
      if (prior) joinedOwnerTokens.delete(prior.token);
      const ownership: NativeWorkspaceFinalizationOwnership = {
        token: owner.token,
        assertHeld: async () => {
          try {
            // A failed transaction is never transparently reconnected by the DB client.
            await lock.execute(sql`select 1`);
            const [current] = await input.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(owned).limit(1);
            if (!current) throw new Error("owner_replaced");
          } catch (cause) {
            throw new NativeWorkspaceFinalizationOwnershipLostError({ cause });
          }
        },
      };
      await ownership.assertHeld();
      actionPromise = action(ownership);
      const value = await actionPromise;
      await ownership.assertHeld();
      return { acquired: true, value } as const;
    }));
  } finally {
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

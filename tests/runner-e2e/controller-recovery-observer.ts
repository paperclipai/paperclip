/** Read-only qualification observer. This never calls recovery, renews a lease,
 * parses checkpoint records, or interprets an underlying harness protocol. */
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
const { sql }: typeof import("../../packages/db/node_modules/drizzle-orm/index.js") =
  createRequire(new URL("../../packages/db/package.json", import.meta.url))("drizzle-orm");
import { createDb, type Db } from "../../packages/db/src/index.js";
import { paperclipConfigSchema } from "../../packages/shared/src/config-schema.js";
import { loadNativeRunnerCheckpoint } from "../../server/src/services/native-runtime/native-runner-checkpoint.js";
import type { ControllerReplacementReceipt } from "./controller-replacement.js";

export interface RecoveryBinding { companyId: string; issueId: string; runId: string }
export interface RecoverySnapshot {
  runId: string; runnerInstanceId: string; nativeSessionId: string;
  bootId: string; generation: number; attempt: number; leaseExpiresAt: string | null;
  sourceSeq: number; history: Array<Record<string, unknown>>;
  authenticatedConnectionCount: number;
  checkpointSourceSeq: number;
}
export interface ControllerRecoveryReceipt {
  binding: RecoveryBinding;
  runnerInstanceId: string;
  nativeSessionId: string;
  previousGeneration: number;
  generation: number;
  previousBootId: string;
  bootId: string;
  previousLeaseExpiresAt: string | null;
  ownershipAcquiredAt: string;
  ownershipObservedAfterMs: number;
  authenticatedAttachmentObservedAfterMs: number;
  resumedProcessingObservedAfterMs: number;
  runnerSourceSeqBefore: number;
  runnerSourceSeqAfter: number;
  previousAuthenticatedConnectionCount: number;
  authenticatedConnectionCount: number;
  attachmentEvidence: "runner_checkpoint_authenticated_connection";
}
export function parseRecoveryBinding(value: unknown): RecoveryBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid controller recovery binding");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || !["companyId", "issueId", "runId"].every(key =>
    typeof row[key] === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row[key] as string))) {
    throw new Error("Invalid controller recovery binding");
  }
  return row as unknown as RecoveryBinding;
}

export function recoveryObservation(before: RecoverySnapshot, after: RecoverySnapshot, fault: ControllerReplacementReceipt,
  binding: RecoveryBinding, observedAfterMs: number): ControllerRecoveryReceipt | null {
  if (before.runId !== binding.runId || after.runId !== before.runId || after.runnerInstanceId !== before.runnerInstanceId
    || after.nativeSessionId !== before.nativeSessionId || after.attempt !== before.attempt) {
    throw new Error("Controller replacement changed the admitted execution");
  }
  if (after.bootId === before.bootId || after.generation <= before.generation) return null;
  const claim = after.history.findLast(entry => entry.controllerBootId === after.bootId
    && entry.controllerGeneration === after.generation);
  if (!claim || claim.disposition !== "reattach_remote_runner" || typeof claim.at !== "string") {
    throw new Error("Replacement did not naturally adopt the original remote runner");
  }
  const claimedAt = Date.parse(claim.at);
  if (!Number.isFinite(claimedAt) || claimedAt < Date.parse(fault.startedAt)
    || (fault.signal === "SIGKILL" && before.leaseExpiresAt && claimedAt < Date.parse(before.leaseExpiresAt))) {
    throw new Error("Replacement bypassed natural controller lease expiry");
  }
  if (after.authenticatedConnectionCount <= before.authenticatedConnectionCount || after.sourceSeq <= before.sourceSeq) return null;
  // The runner-owned projection counts successful authentications. New canonical
  // receipts separately prove ingestion beyond both the saved checkpoint and DB
  // cursor. Replaying an old saved event alone cannot pass either boundary.
  return { binding, runnerInstanceId: before.runnerInstanceId, nativeSessionId: before.nativeSessionId,
    previousGeneration: before.generation, generation: after.generation, previousBootId: before.bootId,
    bootId: after.bootId, previousLeaseExpiresAt: before.leaseExpiresAt, ownershipAcquiredAt: claim.at,
    ownershipObservedAfterMs: observedAfterMs, authenticatedAttachmentObservedAfterMs: observedAfterMs,
    resumedProcessingObservedAfterMs: observedAfterMs, runnerSourceSeqBefore: before.sourceSeq,
    runnerSourceSeqAfter: after.sourceSeq, previousAuthenticatedConnectionCount: before.authenticatedConnectionCount,
    authenticatedConnectionCount: after.authenticatedConnectionCount, attachmentEvidence: "runner_checkpoint_authenticated_connection" };
}

/** B can claim before A exits. Preserve A's original owner/authentication
 * identity while excluding every event committed through A's final exit. */
export function advanceRecoveryCursor(before: RecoverySnapshot, stopped: RecoverySnapshot): RecoverySnapshot {
  if (before.runId !== stopped.runId || before.runnerInstanceId !== stopped.runnerInstanceId
    || before.nativeSessionId !== stopped.nativeSessionId || before.attempt !== stopped.attempt) {
    throw new Error("Controller replacement changed the admitted execution");
  }
  return { ...before, sourceSeq: Math.max(before.sourceSeq, stopped.sourceSeq, stopped.checkpointSourceSeq) };
}

export function validControllerRecoveryReceipt(fault: ControllerReplacementReceipt | undefined): boolean {
  const r = fault?.recovery;
  return Boolean(r && r.bootId !== r.previousBootId && r.generation > r.previousGeneration
    && r.runnerSourceSeqAfter > r.runnerSourceSeqBefore && r.authenticatedConnectionCount > r.previousAuthenticatedConnectionCount
    && r.attachmentEvidence === "runner_checkpoint_authenticated_connection"
    && [r.ownershipObservedAfterMs, r.authenticatedAttachmentObservedAfterMs, r.resumedProcessingObservedAfterMs]
      .every(ms => Number.isFinite(ms) && ms >= fault!.readyAfterMs! && ms < 420_000));
}

export async function readControllerRecoverySnapshot(db: Db, binding: RecoveryBinding): Promise<RecoverySnapshot> {
  return db.transaction(async tx => {
    const [row] = await tx.execute(sql`select r.id as "runId", r.runner_instance_id as "runnerInstanceId",
      r.native_session_id as "nativeSessionId", f.controller_boot_id as "bootId", f.controller_generation as generation,
      f.attempt, f.lease_expires_at::text as "leaseExpiresAt", f.recovery_history as history,
      coalesce((select max(e.source_seq) from heartbeat_run_events e where e.run_id = r.id
        and e.company_id = r.company_id and e.source_instance_id = r.runner_instance_id::text), 0)::float8 as "sourceSeq"
      from heartbeat_runs r join native_run_finalizations f on f.run_id = r.id and f.company_id = r.company_id
      where r.id = ${binding.runId} and r.company_id = ${binding.companyId} and r.native_issue_id = ${binding.issueId}`);
    if (!row?.runnerInstanceId || !row.nativeSessionId || !row.bootId) throw new Error("Recovery binding has no admitted native owner");
    if (!Array.isArray(row.history) || row.history.some(entry => entry === null
      || typeof entry !== "object" || Array.isArray(entry))) {
      throw new Error("Recovery history must be an array of records");
    }
    // Use the existing server loader and Runner's public diagnostic projection.
    // The qualification code never reads encrypted material or private formats.
    const checkpoint = await loadNativeRunnerCheckpoint(tx as unknown as Db, binding);
    const evidence = checkpoint?.recoveryEvidence;
    if (!evidence || evidence.runnerInstanceId !== row.runnerInstanceId || evidence.normalizedSessionId !== row.nativeSessionId) {
      throw new Error("Recovery checkpoint has no matching runner evidence");
    }
    return { ...row, authenticatedConnectionCount: evidence.authenticatedConnectionCount,
      checkpointSourceSeq: evidence.highestRecordedSourceSeq } as RecoverySnapshot;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function createControllerRecoveryObserver(configPath: string, binding: RecoveryBinding) {
  const config = paperclipConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const url = config.database.mode === "postgres" ? config.database.connectionString
    : `postgres://paperclip:paperclip@127.0.0.1:${config.database.embeddedPostgresPort}/paperclip`;
  if (!url) throw new Error("Qualification database is unavailable");
  const db = createDb(url);
  let before: RecoverySnapshot | undefined;
  const read = () => readControllerRecoverySnapshot(db, binding);
  const capture = async (fault: ControllerReplacementReceipt) => {
      before = await read();
      before.sourceSeq = Math.max(before.sourceSeq, before.checkpointSourceSeq);
      fault.recoveryProgress = { binding, previousBootId: before.bootId, previousGeneration: before.generation,
        previousLeaseExpiresAt: before.leaseExpiresAt, runnerSourceSeqBefore: before.sourceSeq,
        previousAuthenticatedConnectionCount: before.authenticatedConnectionCount,
        runnerInstanceId: before.runnerInstanceId, nativeSessionId: before.nativeSessionId };
  };
  return {
    beforeHandoff: capture,
    // Called only after the old server is confirmed dead. This also excludes
    // receipts committed while it was stopping from replacement evidence.
    stopped: capture,
    stoppedAfterHandoff: async (fault: ControllerReplacementReceipt) => {
      if (!before) throw new Error("Missing pre-handoff controller observation");
      before = advanceRecoveryCursor(before, await read());
      fault.recoveryProgress = { ...fault.recoveryProgress, runnerSourceSeqBefore: before.sourceSeq };
    },
    recovered: async (fault: ControllerReplacementReceipt, record: () => Promise<void>, cancelled: () => boolean) => {
      if (!before) throw new Error("Missing controller boundary observation");
      const deadline = Date.parse(fault.startedAt) + 420_000;
      let ownershipObservedAfterMs: number | undefined;
      let authenticatedObservedAfterMs: number | undefined;
      while (Date.now() < deadline && !cancelled()) {
        const current = await read();
        const elapsed = Date.now() - Date.parse(fault.startedAt);
        if (current.bootId !== before.bootId && current.generation > before.generation && ownershipObservedAfterMs === undefined) {
          ownershipObservedAfterMs = elapsed;
          fault.recoveryProgress = { ...fault.recoveryProgress, bootId: current.bootId, generation: current.generation,
            ownershipObservedAfterMs };
          await record();
        }
        if (ownershipObservedAfterMs !== undefined && current.authenticatedConnectionCount > before.authenticatedConnectionCount
          && authenticatedObservedAfterMs === undefined) {
          authenticatedObservedAfterMs = elapsed;
          fault.recoveryProgress = { ...fault.recoveryProgress, authenticatedConnectionCount: current.authenticatedConnectionCount,
            authenticatedAttachmentObservedAfterMs: elapsed };
          await record();
        }
        const recovered = recoveryObservation(before, current, fault, binding, elapsed);
        if (recovered) {
          recovered.ownershipObservedAfterMs = ownershipObservedAfterMs!;
          recovered.authenticatedAttachmentObservedAfterMs = authenticatedObservedAfterMs!;
          fault.recovery = recovered;
          await record();
          return;
        }
        await delay(250);
      }
      throw new Error("Original runner did not reattach and resume ingestion within its original 420-second grace");
    },
    close: () => db.$client.end(),
  };
}

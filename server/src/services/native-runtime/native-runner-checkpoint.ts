import { readNativeCheckpointRetirement } from "./native-runner-checkpoint-retirement.js";
import { NATIVE_PREPARATION_FENCING_VERSION } from "./native-active-runs.js";
import { notifyLiveRunRecovery } from "../live-run-recovery-notifications.js";
import { createHash } from "node:crypto";
import { and, eq, exists, gt, isNull, lte, inArray, notExists, or, sql, type SQL } from "drizzle-orm";
import { checkpointDb, heartbeatRuns, issues, nativeRunFinalizations, nativeRunnerCheckpoints, type Db } from "@paperclipai/db";
import { inspectDurablePrpCheckpointHeader, inspectUnauthenticatedBootstrapCheckpoint, inspectUnclaimedBootstrapCheckpoint, decodeDurablePrpCheckpoint, type DurablePrpCheckpoint, type DurablePrpControlPlane, type DurableRecoveryIdentity } from "../../vendor/paperclip-runner/index.js";
import { createLocalEncryptedCipher, deriveLocalEncryptedInstanceSecret } from "../../secrets/local-encrypted-provider.js";
import { legacyControllerBootId } from "../legacy-controller-lease.js";
import { assertNativeSourceCheckpointConsumer, lockSourceRecoveryCoordinators } from "./native-source-recovery-ownership.js";
import { runnerdStateHasNoProviderTurn, runnerdStateIsIncompleteBootstrap } from "./native-bootstrap-proof.js";

type Binding = { companyId: string; issueId: string; runId: string };
export const NATIVE_CHECKPOINT_HEADER_INSPECTION_MAX_BYTES = 1024 * 1024;
export const NATIVE_CHECKPOINT_INSPECTION_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
export type NativeRunnerCheckpointOwner = Binding & { bootId: string; leaseOwner: string; generation: number; authorityRunId: string };
export type NativeRunnerCheckpointFenceOwner = Omit<NativeRunnerCheckpointOwner, "leaseOwner"> & { leaseOwner: string | null };
function encryptParts(binding: Binding, records: ReadonlyMap<string, string>) {
  if (!records.size) return [];
  const cipher = createLocalEncryptedCipher("write");
  return [...records].map(([part, contents]) => ({
    companyId: binding.companyId, issueId: binding.issueId, runId: binding.runId, part,
    material: cipher.encrypt(JSON.stringify({ companyId: binding.companyId, issueId: binding.issueId, runId: binding.runId, part, contents })),
  }));
}

export async function insertMigratedNativeRunnerCheckpoint(tx: CheckpointTransaction, binding: Binding, checkpoint: DurablePrpCheckpoint) {
  if (checkpoint.runId !== binding.runId) throw new Error("native_runner_checkpoint_binding_mismatch");
  let batch: ReturnType<typeof encryptParts> = [];
  let batchBytes = 0;
  for (const part of encryptParts(binding, checkpoint.records)) {
    const bytes = Buffer.byteLength(JSON.stringify(part));
    if (batch.length && (batch.length >= 64 || batchBytes + bytes > 512 * 1024)) {
      await tx.insert(nativeRunnerCheckpoints).values(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(part);
    batchBytes += bytes;
  }
  if (batch.length) await tx.insert(nativeRunnerCheckpoints).values(batch);
}

function decryptPart(cipher: ReturnType<typeof createLocalEncryptedCipher>, binding: Binding,
  part: string, material: Record<string, unknown>): string {
  const envelope = JSON.parse(cipher.decrypt(material));
  if (envelope.companyId !== binding.companyId || envelope.issueId !== binding.issueId
    || envelope.runId !== binding.runId || envelope.part !== part || typeof envelope.contents !== "string") {
    throw new Error("native_runner_checkpoint_binding_mismatch");
  }
  return envelope.contents;
}

type CheckpointTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A dependent run-lock query can consume this CTE to preserve coordinator-first
 * lock order without adding a second database round trip. */
export function nativeRunnerCheckpointOwnerLock(tx: CheckpointTransaction, owner: NativeRunnerCheckpointFenceOwner) {
  return tx.$with("checkpoint_owner").as(tx.select({
    leaseOwner: nativeRunFinalizations.leaseOwner,
    leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
    resultId: nativeRunFinalizations.resultId,
    phase: nativeRunFinalizations.phase,
  }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, owner.companyId), eq(nativeRunFinalizations.issueId, owner.issueId),
    eq(nativeRunFinalizations.runId, owner.authorityRunId), eq(nativeRunFinalizations.controllerBootId, owner.bootId),
    eq(nativeRunFinalizations.controllerGeneration, owner.generation))).for("update"));
}

/** Locks the coordinator before callers lock a run. A caller that subsequently
 * waits for another lock must recheck the fence before writing. */
export async function lockNativeRunnerCheckpointOwner(
  tx: CheckpointTransaction, owner: NativeRunnerCheckpointFenceOwner,
) {
  // A locking CTE acquires ownership before the outer projection samples
  // wall time. Sampling in the locking SELECT can precede its lock wait.
  // Keep both steps in one statement without another database round trip.
  const locked = nativeRunnerCheckpointOwnerLock(tx, owner);
  const [owned] = await tx.with(locked).select({ leaseOwner: locked.leaseOwner,
    leaseExpiresAt: locked.leaseExpiresAt, resultId: locked.resultId, phase: locked.phase, now: sql<Date>`clock_timestamp()` }).from(locked);
  if (!owned) throw new Error("native_runner_checkpoint_owner_lost");
  return owned;
}

export async function validateNativeRunnerCheckpointOwner(
  tx: CheckpointTransaction, owner: NativeRunnerCheckpointFenceOwner,
  owned: Omit<Awaited<ReturnType<typeof lockNativeRunnerCheckpointOwner>>, "phase">, newWork: boolean,
): Promise<void> {
  const current = owned;
  const activeOwner = owner.leaseOwner !== null && current.leaseOwner === owner.leaseOwner
    && current.leaseExpiresAt !== null && current.leaseExpiresAt > new Date(owned.now);
  if (!activeOwner) {
    await assertNativeSourceCheckpointConsumer(tx, owner);
    const [task] = await tx.select({ executionRunId: issues.executionRunId }).from(issues)
      .where(and(eq(issues.companyId, owner.companyId), eq(issues.id, owner.issueId)));
    const [successor] = task?.executionRunId && task.executionRunId !== owner.runId
      ? await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
          eq(nativeRunFinalizations.runId, task.executionRunId), eq(nativeRunFinalizations.companyId, owner.companyId),
          eq(nativeRunFinalizations.issueId, owner.issueId), eq(nativeRunFinalizations.controllerBootId, owner.bootId),
          gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))) : [];
    const [preparingSuccessor] = !successor && task?.executionRunId && task.executionRunId !== owner.runId
      ? await tx.select({ runId: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, task.executionRunId), eq(heartbeatRuns.companyId, owner.companyId),
          eq(heartbeatRuns.issueId, owner.issueId), eq(heartbeatRuns.runtimeMode, "legacy"),
          eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.executionStage, "preparing"),
          eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
          gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
          notExists(tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, heartbeatRuns.id))))) : [];
    const [waitingSuccessor] = !successor && !preparingSuccessor && task?.executionRunId && task.executionRunId !== owner.runId
      ? await tx.select({ runId: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, task.executionRunId), eq(heartbeatRuns.companyId, owner.companyId),
          eq(heartbeatRuns.issueId, owner.issueId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
          notExists(tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, heartbeatRuns.id))))) : [];
    if (!current.resultId || newWork || !task
      || (task.executionRunId && task.executionRunId !== owner.runId && !successor && !preparingSuccessor && !waitingSuccessor)) {
      throw new Error("native_runner_checkpoint_owner_lost");
    }
  }
}

export async function assertNativeRunnerCheckpointOwner(tx: CheckpointTransaction, owner: NativeRunnerCheckpointOwner, newWork: boolean) {
  const locked = await lockNativeRunnerCheckpointOwner(tx, owner);
  await validateNativeRunnerCheckpointOwner(tx, owner, locked, newWork);
}

export function nativeRunnerCheckpointWriter(db: Db, owner: NativeRunnerCheckpointOwner) {
  const persistenceDb = checkpointDb(db);
  let previousWork = new Set<string>();
  return async (checkpoint: DurablePrpCheckpoint): Promise<void> => {
    if (checkpoint.runId !== owner.runId) throw new Error("native_runner_checkpoint_binding_mismatch");
    const changed = encryptParts(owner, checkpoint.changedRecords);
    await persistenceDb.transaction(async tx => {
      if (owner.runId !== owner.authorityRunId) {
        await lockSourceRecoveryCoordinators(tx, owner.companyId, [owner.runId, owner.authorityRunId]);
        await assertNativeSourceCheckpointConsumer(tx, owner, checkpoint);
      }
      await assertNativeRunnerCheckpointOwner(tx, owner, checkpoint.workCommandIds.some(id => !previousWork.has(id)));
      if (checkpoint.reset || checkpoint.changedRecords.has("header") || checkpoint.removedRecords.includes("header")) {
        const [header] = await tx.select({ material: nativeRunnerCheckpoints.material }).from(nativeRunnerCheckpoints).where(and(
          eq(nativeRunnerCheckpoints.companyId, owner.companyId), eq(nativeRunnerCheckpoints.runId, owner.runId),
          eq(nativeRunnerCheckpoints.part, "header"))).for("share").limit(1);
        if (header && readNativeCheckpointRetirement(header.material, owner)) throw new Error("native_runner_checkpoint_retired");
      }
      if (checkpoint.predecessor) {
        const [prior] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, checkpoint.predecessor.runId), eq(heartbeatRuns.companyId, owner.companyId),
          eq(heartbeatRuns.nativeIssueId, owner.issueId),
          eq(heartbeatRuns.nativeSessionId, checkpoint.predecessor.normalizedSessionId)));
        if (!prior) throw new Error("native_runner_checkpoint_binding_mismatch");
      }
      await notifyLiveRunRecovery(tx, { companyId: owner.companyId, runId: owner.runId });
      if (checkpoint.reset) await tx.delete(nativeRunnerCheckpoints).where(and(
        eq(nativeRunnerCheckpoints.companyId, owner.companyId), eq(nativeRunnerCheckpoints.runId, owner.runId)));
      else if (checkpoint.removedRecords.length) await tx.delete(nativeRunnerCheckpoints).where(and(
        eq(nativeRunnerCheckpoints.companyId, owner.companyId), eq(nativeRunnerCheckpoints.runId, owner.runId),
        inArray(nativeRunnerCheckpoints.part, [...checkpoint.removedRecords])));
      if (changed.length) await tx.insert(nativeRunnerCheckpoints).values(changed)
        .onConflictDoUpdate({ target: [nativeRunnerCheckpoints.runId, nativeRunnerCheckpoints.part],
          set: { material: sql`excluded.material`, updatedAt: sql`now()` } });
    });
    previousWork = new Set(checkpoint.workCommandIds);
  };
}

const authorities = new WeakMap<DurablePrpControlPlane, Map<string, { fence: string; write: ReturnType<typeof nativeRunnerCheckpointWriter> }>>();

export function nativeRunnerCheckpointPersistence(db: Db, bootId: string, authorityRunId: string | (() => string),
  detach: (runIds: readonly string[], leaseOwner?: string) => Promise<unknown>) {
  return { db, bootId, authorityRunId, onFailure: async (runId: string, leaseOwner: string) => {
    try { await detach([runId], leaseOwner); }
    finally {
      await db.update(nativeRunFinalizations).set({ leaseExpiresAt: sql`clock_timestamp()` })
        .where(and(eq(nativeRunFinalizations.runId, runId), eq(nativeRunFinalizations.controllerBootId, bootId), eq(nativeRunFinalizations.leaseOwner, leaseOwner),
          isNull(nativeRunFinalizations.resultId)));
    }
  } };
}

/** Attachment identity owns the stored records; current business authority owns
 * the write lease. They differ when a completed warm session is recovered. */
export function nativeRunnerCheckpointRegistration(input: Omit<Parameters<typeof registerNativeRunnerCheckpoint>[0], "authority">) {
  return (authority: DurablePrpControlPlane, identity?: { runId: string }) => registerNativeRunnerCheckpoint({
    ...input, authority, binding: { ...input.binding, runId: identity?.runId ?? input.binding.runId },
  });
}

export async function registerNativeRunnerCheckpoint(input: {
  db: Db; binding: Binding; bootId: string; authority: DurablePrpControlPlane;
  authorityRunId?: string | (() => string);
  onFailure?: (runId: string, leaseOwner: string) => Promise<void>;
}): Promise<void> {
  const authorityRunId = typeof input.authorityRunId === "function"
    ? input.authorityRunId() : input.authorityRunId ?? input.binding.runId;
  const [owner] = await input.db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.binding.companyId),
    eq(nativeRunFinalizations.issueId, input.binding.issueId),
    eq(nativeRunFinalizations.runId, authorityRunId),
    eq(nativeRunFinalizations.controllerBootId, input.bootId),
    gt(nativeRunFinalizations.leaseExpiresAt, sql`now()`)));
  if (!owner?.leaseOwner) throw new Error("native_runner_checkpoint_owner_lost");
  let writers = authorities.get(input.authority);
  if (!writers) {
    writers = new Map();
    const boundWriters = writers;
    input.authority.setCheckpointPersistence(async snapshot => {
      const writer = boundWriters.get(snapshot.runId);
      if (!writer) throw new Error("native_runner_checkpoint_owner_lost");
      await writer.write(snapshot);
    });
    authorities.set(input.authority, writers);
  }
  const fence = JSON.stringify([authorityRunId, input.bootId, owner.controllerGeneration, owner.leaseOwner]);
  if (writers.get(input.binding.runId)?.fence !== fence) {
    const write = nativeRunnerCheckpointWriter(input.db, {
      ...input.binding, authorityRunId, bootId: input.bootId, generation: owner.controllerGeneration, leaseOwner: owner.leaseOwner,
    });
    writers.set(input.binding.runId, { fence, write: async checkpoint => {
      try { await write(checkpoint); }
      catch (error) {
        void input.onFailure?.(authorityRunId, owner.leaseOwner!).catch(() => undefined);
        throw error;
      }
    } });
  }
  await input.authority.flushCheckpoint();
}

/** Exact-run bounded metadata read; never loads command/event payload records. */
export async function loadNativeRunnerCheckpointHeader(db: Pick<Db, "select">, binding: Binding): Promise<string | null> {
  const [row] = await db.select({ material: nativeRunnerCheckpoints.material }).from(nativeRunnerCheckpoints).where(and(
    eq(nativeRunnerCheckpoints.companyId, binding.companyId), eq(nativeRunnerCheckpoints.issueId, binding.issueId),
    eq(nativeRunnerCheckpoints.runId, binding.runId), eq(nativeRunnerCheckpoints.part, "header"))).limit(1);
  if (!row) return null;
  if (readNativeCheckpointRetirement(row.material, binding)) throw new Error("native_runner_checkpoint_retired");
  try { return decryptPart(createLocalEncryptedCipher("read"), binding, "header", row.material); }
  catch { return null; }
}

export async function loadNativeRunnerCheckpoint(db: Pick<Db, "select">, binding: Binding): Promise<DurablePrpCheckpoint | null> {
  const rows = await db.select().from(nativeRunnerCheckpoints).where(and(
    eq(nativeRunnerCheckpoints.companyId, binding.companyId), eq(nativeRunnerCheckpoints.issueId, binding.issueId),
    eq(nativeRunnerCheckpoints.runId, binding.runId)));
  if (!rows.length) return null;
  const header = rows.find(row => row.part === "header");
  if (header && readNativeCheckpointRetirement(header.material, binding)) throw new Error("native_runner_checkpoint_retired");
  const cipher = createLocalEncryptedCipher("read");
  const parts = new Map(rows.map(row =>
    [row.part, decryptPart(cipher, binding, row.part, row.material)] as const));
  const checkpoint = decodeDurablePrpCheckpoint(parts);
  if (checkpoint.runId !== binding.runId) throw new Error("native_runner_checkpoint_binding_mismatch");
  return checkpoint;
}

export async function loadNativeUnclaimedBootstrapCheckpoint(
  db: Pick<Db, "select">, binding: Binding, identity: DurableRecoveryIdentity,
) {
  try {
    if (binding.runId !== identity.runId) return null;
    const rows = await db.select().from(nativeRunnerCheckpoints).where(and(
      eq(nativeRunnerCheckpoints.companyId, binding.companyId), eq(nativeRunnerCheckpoints.issueId, binding.issueId),
      eq(nativeRunnerCheckpoints.runId, binding.runId))).limit(5);
    if (rows.length !== 4 || rows.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row.material)), 0)
      > 2 * NATIVE_CHECKPOINT_INSPECTION_TOTAL_MAX_BYTES) return null;
    const cipher = createLocalEncryptedCipher("read");
    const records = new Map(rows.map(row => [row.part, decryptPart(cipher, binding, row.part, row.material)] as const));
    return inspectUnclaimedBootstrapCheckpoint(records, identity);
  } catch { return null; }
}

export async function nativeRunnerNeverAuthenticated(
  db: Pick<Db, "select">, binding: Binding,
  identity: Pick<DurableRecoveryIdentity, "runId" | "normalizedSessionId" | "runnerInstanceId">,
): Promise<boolean> {
  try {
    if (binding.runId !== identity.runId) return false;
    const rows = await db.select().from(nativeRunnerCheckpoints).where(and(
      eq(nativeRunnerCheckpoints.companyId, binding.companyId), eq(nativeRunnerCheckpoints.issueId, binding.issueId),
      eq(nativeRunnerCheckpoints.runId, binding.runId))).limit(MAX_BOOTSTRAP_CHECKPOINT_COMMANDS + 3);
    if (rows.length < 4 || rows.length > MAX_BOOTSTRAP_CHECKPOINT_COMMANDS + 2
      || rows.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row.material)), 0)
        > 2 * NATIVE_CHECKPOINT_INSPECTION_TOTAL_MAX_BYTES) return false;
    const cipher = createLocalEncryptedCipher("read");
    const records = new Map(rows.map(row => [row.part, decryptPart(cipher, binding, row.part, row.material)] as const));
    return inspectUnauthenticatedBootstrapCheckpoint(records, identity);
  } catch { return false; }
}

const BOOTSTRAP_CHECKPOINT_PARTS = new Set(["header", "cursor"]);
const MAX_BOOTSTRAP_CHECKPOINT_COMMANDS = 8;
/** Session-open events are few; a longer journal is never a bootstrap. */
const MAX_BOOTSTRAP_CHECKPOINT_EVENTS = 16;

export type NativeRemoteBootstrapProof = "bootstrap_incomplete" | "session_opened_without_turn";

/**
 * A remote runner's controller state lives only in this checkpoint, and every
 * command is written here before the controller sends it. Once the previous
 * controller's lease has expired, the checkpoint is therefore a complete record
 * of what reached the sandbox runner. Returns which proof holds:
 * `bootstrap_incomplete` when it holds only run.prepare and an unfinished
 * session.open with no committed or acknowledged event, or
 * `session_opened_without_turn` when session.open completed and every committed
 * event is a session-open event. Either way no provider turn can exist. The
 * sandbox runner journal is not on this host; the proof uses the controller
 * record alone, as for a local root whose runner never journaled.
 */
export async function nativeRunnerCheckpointRemoteBootstrapProof(
  db: Pick<Db, "select">, binding: Binding, expected: { runnerInstanceId: string; normalizedSessionId: string },
): Promise<NativeRemoteBootstrapProof | null> {
  const evidence = await nativeRunnerCheckpointRemoteBootstrapEvidence(db, binding, expected.normalizedSessionId);
  return evidence?.runnerInstanceId === expected.runnerInstanceId ? evidence.proof : null;
}

/**
 * The same proof, with the runner instance the checkpoint names. A caller that
 * must hold the proof across a new controller's registration reads it first.
 */
export async function nativeRunnerCheckpointRemoteBootstrapEvidence(
  db: Pick<Db, "select">, binding: Binding, normalizedSessionId: string,
): Promise<{ proof: NativeRemoteBootstrapProof; runnerInstanceId: string } | null> {
  try {
    const limit = BOOTSTRAP_CHECKPOINT_PARTS.size + MAX_BOOTSTRAP_CHECKPOINT_COMMANDS + MAX_BOOTSTRAP_CHECKPOINT_EVENTS;
    const parts = await db.select({ part: nativeRunnerCheckpoints.part }).from(nativeRunnerCheckpoints).where(and(
      eq(nativeRunnerCheckpoints.companyId, binding.companyId), eq(nativeRunnerCheckpoints.issueId, binding.issueId),
      eq(nativeRunnerCheckpoints.runId, binding.runId))).limit(limit + 1);
    const eventParts = parts.map(row => row.part).filter(part => /^event:\d+$/.test(part));
    const commandParts = parts.map(row => row.part).filter(part => /^command:\d+$/.test(part));
    if (!parts.length || parts.length > limit || eventParts.length > MAX_BOOTSTRAP_CHECKPOINT_EVENTS
      || commandParts.length > MAX_BOOTSTRAP_CHECKPOINT_COMMANDS
      || parts.some(row => !BOOTSTRAP_CHECKPOINT_PARTS.has(row.part) && !/^(?:event|command):\d+$/.test(row.part))) return null;
    const checkpoint = await loadNativeRunnerCheckpoint(db, binding);
    if (!checkpoint || checkpoint.predecessor !== null
      || checkpoint.recoveryEvidence.normalizedSessionId !== normalizedSessionId) return null;
    const runnerInstanceId = checkpoint.recoveryEvidence.runnerInstanceId;
    // The decoder above validated these canonical v2 records. Rebuild the
    // controller state in memory without writing files under recovery locks.
    const read = (part: string) => {
      const value = checkpoint.records.get(part);
      return value === undefined ? undefined : JSON.parse(value) as Record<string, unknown>;
    };
    const header = read("header");
    const cursor = read("cursor");
    if (header?.schema !== "paperclip.runner.controller-checkpoint.v2" || !cursor
      || cursor.commandCount !== commandParts.length) return null;
    const state: Record<string, unknown> = {
      ...(header.state as Record<string, unknown>),
      ackedSourceSeq: cursor.ackedSourceSeq,
      commands: commandParts.map(part => Number(part.slice("command:".length))).sort((a, b) => a - b)
        .map(seq => read(`command:${seq}`)),
      committedEvents: eventParts.map(part => Number(part.slice("event:".length))).sort((a, b) => a - b)
        .map(seq => read(`event:${seq}`)),
    };
    if ((state.identity as { runId?: unknown } | undefined)?.runId !== binding.runId) return null;
    if (runnerdStateIsIncompleteBootstrap(state)) return { proof: "bootstrap_incomplete", runnerInstanceId };
    return runnerdStateHasNoProviderTurn(state) ? { proof: "session_opened_without_turn", runnerInstanceId } : null;
  } catch {
    return null;
  }
}

export async function restoreNativeRunnerCheckpoint(db: Db, binding: Binding, root: string, normalizedSessionId?: string) {
  const checkpoint = await loadNativeRunnerCheckpoint(db, binding);
  if (!checkpoint) return null;
  if (normalizedSessionId !== undefined && checkpoint.recoveryEvidence.normalizedSessionId !== normalizedSessionId) {
    throw new Error("native_runner_checkpoint_binding_mismatch");
  }
  checkpoint.restoreSessionDirectory(root);
  return checkpoint;
}

export async function hasNativeRunnerCheckpoint(db: Pick<Db, "select">, binding: Binding): Promise<boolean> {
  const [row] = await db.select({ runId: nativeRunnerCheckpoints.runId }).from(nativeRunnerCheckpoints).where(and(
    eq(nativeRunnerCheckpoints.companyId, binding.companyId), eq(nativeRunnerCheckpoints.issueId, binding.issueId),
    eq(nativeRunnerCheckpoints.runId, binding.runId))).limit(1);
  return row !== undefined;
}

/** Recovery history dispositions of a restart claim that took a run over. */
const NATIVE_RESTART_CLAIM_DISPOSITIONS = ["reattach_existing_runner", "reattach_remote_runner",
  "resume_dead_runner", "bootstrap_incomplete"] as const;

export async function listExpiredNativeRunnerAuthorities(db: Db, now: Date, runIds: string[]): Promise<string[]> {
  if (!runIds.length) return [];
  // The caller supplies the finite expired active-run inventory. Return all of
  // it: a blocked owner's unchanged row must not starve later recoverable runs.
  const rows = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, nativeRunFinalizations.runId))
    .where(and(inArray(nativeRunFinalizations.runId, runIds),
      eq(heartbeatRuns.status, "running"), eq(nativeRunFinalizations.phase, "observed"),
      isNull(nativeRunFinalizations.resultId),
      or(isNull(nativeRunFinalizations.leaseExpiresAt), lte(nativeRunFinalizations.leaseExpiresAt, now)),
      or(exists(db.select({ runId: nativeRunnerCheckpoints.runId }).from(nativeRunnerCheckpoints).where(and(
        eq(nativeRunnerCheckpoints.runId, nativeRunFinalizations.runId),
        eq(nativeRunnerCheckpoints.issueId, nativeRunFinalizations.issueId),
        eq(nativeRunnerCheckpoints.companyId, nativeRunFinalizations.companyId)))),
        and(sql`${heartbeatRuns.runnerProfileJson}->'nativePreparationFencingVersion' = ${JSON.stringify(NATIVE_PREPARATION_FENCING_VERSION)}::jsonb`,
          isNull(heartbeatRuns.processPid), isNull(heartbeatRuns.processGroupId), isNull(heartbeatRuns.processStartedAt)),
        // A graceful shutdown handed this run to the next controller. That
        // handoff exists before any checkpoint (for example, a run stopped
        // just after its claim), and a follow-up may carry its predecessor's
        // Runner identity. Without it nothing but a later server boot would
        // look at the run again. The restart claim still proves the takeover.
        // It stays eligible through ownership waits (the departing server may
        // still be alive at the first look) until a claim follows the handoff.
        and(inArray(nativeRunFinalizations.recoveryState, ["awaiting_runner_reattach", "awaiting_evidence"]),
          sql`exists (select 1 from jsonb_array_elements(coalesce(${nativeRunFinalizations.recoveryHistory}, '[]'::jsonb))
            with ordinality as handoff(item, ordinal)
            where handoff.item ->> 'disposition' = 'restart_suspended'
              and not exists (select 1 from jsonb_array_elements(${nativeRunFinalizations.recoveryHistory})
                with ordinality as later(item, ordinal)
                where later.ordinal > handoff.ordinal and later.item ->> 'disposition' in (${sql.join(
                  NATIVE_RESTART_CLAIM_DISPOSITIONS.map(disposition => sql`${disposition}`), sql`, `)})))`))));
  return rows.map(row => row.runId);
}

/** Only a header that decrypted has a repeatable answer: a key or material failure may not recur. */
function inspectUpgradeHeaderMaterial(binding: Binding, material: Record<string, unknown>) {
  let contents: string;
  try { contents = decryptPart(createLocalEncryptedCipher("read"), binding, "header", material); }
  catch { return { decrypted: false as const, identity: null }; }
  return { decrypted: true as const, identity: inspectDurablePrpCheckpointHeader(contents) };
}

/** Inspect only the bounded encrypted header. Protocol interpretation stays in Runner. */
export function inspectNativeRunnerUpgradeHeader(binding: Binding, material: Record<string, unknown>) {
  return inspectUpgradeHeaderMaterial(binding, material).identity;
}

/** The only header fields that rollout evidence compares, and that a memo keeps. */
export type NativeRunnerUpgradeHeaderIdentity = Pick<DurableRecoveryIdentity,
  "runId" | "runnerInstanceId" | "normalizedSessionId" | "environmentLeaseId">;
const upgradeHeaderIdentity = (identity: DurableRecoveryIdentity | null): NativeRunnerUpgradeHeaderIdentity | null => identity && {
  runId: identity.runId, runnerInstanceId: identity.runnerInstanceId,
  normalizedSessionId: identity.normalizedSessionId, environmentLeaseId: identity.environmentLeaseId };

/** One read of header evidence. `known` is a JSON object from binding to the row
 * revision this read answers without the material. Call `finish` after a completed read. */
export type NativeRunnerUpgradeHeaderRead = {
  readonly known: string;
  inspect(binding: Binding, revision: string, material: Record<string, unknown> | null): NativeRunnerUpgradeHeaderIdentity | null;
  finish(): void;
};

/** PostgreSQL writes a new row version, with a new xmin or ctid, for every change to
 * a row, so an unchanged revision means unchanged material. The write time and stored
 * size are included so that no single field carries that guarantee. */
export function nativeRunnerCheckpointRevisionSql(checkpoint: SQL) {
  return sql`${checkpoint}.xmin::text || ':' || ${checkpoint}.ctid::text
    || ':' || (extract(epoch from ${checkpoint}.updated_at) * 1000000)::bigint::text
    || ':' || pg_column_size(${checkpoint}.material)::text`;
}

/** `material` must already be null for a row the reader will not inspect. The statement
 * that reads a run sends its header's material only for a revision the read does not know. */
export function nativeRunnerUpgradeHeaderSql(read: Pick<NativeRunnerUpgradeHeaderRead, "known">,
  row: { companyId: SQL; issueId: SQL; runId: SQL; revision: SQL; material: SQL }) {
  return {
    join: sql`left join jsonb_each_text(${read.known}::jsonb) as known_header(binding, revision)
      on known_header.binding = ${row.companyId}::text || '/' || ${row.issueId}::text || '/' || ${row.runId}::text`,
    revision: sql`case when ${row.material} is not null then ${row.revision} end`,
    material: sql`case when ${row.revision} is distinct from known_header.revision then ${row.material} end`,
  };
}

/** A read that remembers nothing: every inspected header is sent and decrypted. */
export function directNativeRunnerUpgradeHeaderRead(): NativeRunnerUpgradeHeaderRead {
  return { known: "{}", finish() {},
    inspect: (binding, _revision, material) => material ? upgradeHeaderIdentity(inspectNativeRunnerUpgradeHeader(binding, material)) : null };
}

/** A digest of a value derived from the secrets key for this purpose alone. It opens nothing. */
function upgradeHeaderKeyIdentity(): string | null {
  try {
    return createHash("sha256").update(deriveLocalEncryptedInstanceSecret("native-runner-upgrade-header-memo",
      process.env, { allowCreate: false })).digest("hex");
  } catch { return null; }
}

/** Remembers the answer for a header that decrypted, so an unchanged header is not
 * sent or decrypted again. An answer is reused only for the same binding, row revision
 * and secrets key; a header that did not decrypt is read and tried on every read.
 * An entry holds four identifiers, entries are bounded in number and bytes, and a
 * read forgets every header it did not inspect, such as that of a run that ended. */
export function createNativeRunnerUpgradeHeaderMemo(limits: { maxEntries?: number; maxBytes?: number } = {}) {
  const maxEntries = limits.maxEntries ?? 1_200, maxBytes = limits.maxBytes ?? 1024 * 1024;
  type Answer = { revision: string; identity: NativeRunnerUpgradeHeaderIdentity | null };
  const entries = new Map<string, Answer & { keyIdentity: string; bytes: number }>();
  let bytes = 0;
  const forget = (key: string) => {
    const entry = entries.get(key);
    if (entry && entries.delete(key)) bytes -= entry.bytes;
  };
  return {
    get size() { return entries.size; },
    get bytes() { return bytes; },
    read(): NativeRunnerUpgradeHeaderRead {
      let keyIdentity = entries.size ? upgradeHeaderKeyIdentity() : undefined;
      const usable = new Map([...entries].filter(([, entry]) => entry.keyIdentity === keyIdentity));
      const reused = new Set<string>(), decrypted = new Map<string, Answer>();
      let keyChanged = false;
      // A direct read loads the key for each header, after the query. An answer from memory
      // is as conservative only if the key is loaded and unchanged when the answer is used.
      const sameKey = () => {
        const now = upgradeHeaderKeyIdentity();
        if (keyIdentity === undefined) keyIdentity = now;
        const same = now !== null && now === keyIdentity;
        if (!same) keyChanged = true;
        return same;
      };
      return {
        known: JSON.stringify(Object.fromEntries([...usable].map(([key, entry]) => [key, entry.revision]))),
        inspect(binding, revision, material) {
          const key = `${binding.companyId}/${binding.issueId}/${binding.runId}`;
          if (!material) {
            // The query withholds material only for a revision this read offered.
            const entry = usable.get(key);
            if (entry?.revision !== revision || !sameKey()) return null;
            reused.add(key);
            return entry.identity;
          }
          const before = sameKey();
          const result = inspectUpgradeHeaderMaterial(binding, material);
          const identity = upgradeHeaderIdentity(result.identity);
          if (result.decrypted && before && sameKey()) decrypted.set(key, { revision, identity });
          else decrypted.delete(key);
          return identity;
        },
        finish() {
          // A read that saw the key missing or changed keeps and remembers nothing.
          const current = keyChanged || !keyIdentity ? null : keyIdentity;
          for (const [key, entry] of entries) {
            if (!reused.has(key) || entry.keyIdentity !== current) forget(key);
          }
          for (const [key, answer] of current ? decrypted : []) {
            const size = 2 * (key.length + answer.revision.length + current!.length
              + Object.values(answer.identity ?? {}).reduce((sum, value) => sum + value.length, 0));
            forget(key);
            entries.set(key, { ...answer, keyIdentity: current!, bytes: size });
            bytes += size;
          }
          for (const key of entries.keys()) {
            if (entries.size <= maxEntries && bytes <= maxBytes) break;
            forget(key);
          }
        },
      };
    },
  };
}

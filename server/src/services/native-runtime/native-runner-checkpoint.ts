import { readNativeCheckpointRetirement } from "./native-runner-checkpoint-retirement.js";
import { NATIVE_PREPARATION_FENCING_VERSION, NATIVE_PREPARATION_HANDOFF_VERSION } from "./native-active-runs.js";
import { notifyLiveRunRecovery } from "../live-run-recovery-notifications.js";
import { and, eq, exists, gt, isNull, lte, inArray, notExists, or, sql } from "drizzle-orm";
import { checkpointDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, nativeRunnerCheckpoints, type Db } from "@paperclipai/db";
import { hostname } from "node:os";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { PROCESS_START_REQUESTED } from "../native-local-process-stop.js";
import { nativeGenericWarmAttachmentPublication, type NativeGenericWarmAttachmentPublication } from "./native-generic-warm-attachment.js";
import { nativeSha256 } from "./canonical.js";
import { inspectDurablePrpCheckpointHeader, inspectUnclaimedBootstrapCheckpoint, decodeDurablePrpCheckpoint, type DurablePrpCheckpoint, type DurablePrpControlPlane, type DurableRecoveryIdentity } from "../../vendor/paperclip-runner/index.js";
import { createLocalEncryptedCipher } from "../../secrets/local-encrypted-provider.js";
import { legacyControllerBootId } from "../legacy-controller-lease.js";
import { assertNativeSourceCheckpointConsumer, lockSourceRecoveryCoordinators } from "./native-source-recovery-ownership.js";
import { runnerdStateHasNoProviderTurn, runnerdStateIsIncompleteBootstrap } from "./native-bootstrap-proof.js";
import { nativePreparationPublication, preparationSha256, rebindNativeLaunchMaterials, type NativePreparationPublication } from "./native-preparation-checkpoint.js";

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
    if (!current.resultId || newWork || !task || (task.executionRunId && task.executionRunId !== owner.runId && !successor && !preparingSuccessor)) {
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
  let preparationPublished = false;
  let startDeclared = false;
  let warmPublished = false;
  return async (checkpoint: DurablePrpCheckpoint): Promise<void> => {
    if (checkpoint.runId !== owner.runId) throw new Error("native_runner_checkpoint_binding_mismatch");
    const publication = nativePreparationPublication(checkpoint, owner);
    const warmPublication = nativeGenericWarmAttachmentPublication(checkpoint, owner);
    const changedRecords = new Map(checkpoint.changedRecords);
    const headerText = checkpoint.records.get("header");
    if (headerText && (publication || preparationPublished || warmPublication || warmPublished)) changedRecords.set("header", headerText);
    const changed = encryptParts(owner, changedRecords);
    if (headerText && (publication || warmPublication)) {
      const header = changed.find(row => row.part === "header")!;
      const cipher = createLocalEncryptedCipher("write");
      header.material = cipher.encrypt(JSON.stringify({ companyId: owner.companyId, issueId: owner.issueId,
        runId: owner.runId, part: "header", contents: headerText,
        ...(publication ? { preparationPublication: publication } : {}),
        ...(warmPublication ? { warmAttachmentPublication: warmPublication } : {}) }));
    }
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
      if (publication) {
        const [priorHeader] = await tx.select({ material: nativeRunnerCheckpoints.material }).from(nativeRunnerCheckpoints).where(and(
          eq(nativeRunnerCheckpoints.companyId, owner.companyId), eq(nativeRunnerCheckpoints.runId, owner.runId),
          eq(nativeRunnerCheckpoints.part, "header"))).limit(1);
        const prior = priorHeader && inspectNativePreparationPublication(owner, priorHeader.material)?.publication;
        if (prior) await rebindPreparationLaunchRows(tx as unknown as Db, owner, prior, publication);
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
      if (!startDeclared && owner.runId === owner.authorityRunId) {
        const [run] = await tx.select({ agentId: heartbeatRuns.agentId, attempt: nativeRunFinalizations.attempt,
          version: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativePreparationHandoffVersion'` })
          .from(heartbeatRuns).innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id),
            eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId)))
          .where(and(eq(heartbeatRuns.companyId, owner.companyId), eq(heartbeatRuns.id, owner.runId))).limit(1);
        if (run?.version === NATIVE_PREPARATION_HANDOFF_VERSION) {
          const [declared] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
            eq(heartbeatRunEvents.companyId, owner.companyId), eq(heartbeatRunEvents.runId, owner.runId),
            eq(heartbeatRunEvents.eventType, PROCESS_START_REQUESTED),
            sql`${heartbeatRunEvents.payload}->>'providerAttempt' = ${String(run.attempt)}`)).limit(1);
          if (!declared) await appendHeartbeatRunEvent(tx as unknown as Db, { companyId: owner.companyId, runId: owner.runId,
            agentId: run.agentId, eventType: PROCESS_START_REQUESTED, stream: "system", level: "info",
            message: "Native execution requested; prior local stop evidence no longer applies.",
            payload: { hostname: hostname(), providerAttempt: run.attempt, requestedAt: new Date().toISOString() } });
        }
      }
    });
    previousWork = new Set(checkpoint.workCommandIds);
    preparationPublished = publication !== null;
    startDeclared = true;
    warmPublished = warmPublication !== null;
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
  const [run] = await input.db.select({ version: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativePreparationHandoffVersion'` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.binding.companyId), eq(heartbeatRuns.id, authorityRunId))).limit(1);
  if (run?.version === NATIVE_PREPARATION_HANDOFF_VERSION) input.authority.enablePreparationHandoff();
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
      || checkpoint.recoveryEvidence.runnerInstanceId !== expected.runnerInstanceId
      || checkpoint.recoveryEvidence.normalizedSessionId !== expected.normalizedSessionId) return null;
    // The decoder above validated these canonical v2 records. Rebuild the
    // controller state in memory without writing files under recovery locks.
    const read = (part: string) => {
      const value = checkpoint.records.get(part);
      return value === undefined ? undefined : JSON.parse(value) as Record<string, unknown>;
    };
    const header = read("header");
    const cursor = read("cursor");
    if (!["paperclip.runner.controller-checkpoint.v2", "paperclip.runner.controller-checkpoint.v3"].includes(String(header?.schema)) || !cursor
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
    if (runnerdStateIsIncompleteBootstrap(state)) return "bootstrap_incomplete";
    return runnerdStateHasNoProviderTurn(state) ? "session_opened_without_turn" : null;
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
          isNull(heartbeatRuns.processPid), isNull(heartbeatRuns.processGroupId), isNull(heartbeatRuns.processStartedAt)))));
  return rows.map(row => row.runId);
}

/** Inspect only the bounded encrypted header. Protocol interpretation stays in Runner. */
export function inspectNativeRunnerUpgradeHeader(binding: Binding, material: Record<string, unknown>) {
  try {
    const contents = decryptPart(createLocalEncryptedCipher("read"), binding, "header", material);
    return inspectDurablePrpCheckpointHeader(contents);
  } catch { return null; }
}

export function inspectNativePreparationPublication(binding: Binding, material: Record<string, unknown>) {
  try {
    const envelope = JSON.parse(createLocalEncryptedCipher("read").decrypt(material));
    if (envelope.companyId !== binding.companyId || envelope.issueId !== binding.issueId
      || envelope.runId !== binding.runId || envelope.part !== "header"
      || !inspectDurablePrpCheckpointHeader(envelope.contents)) return null;
    return { contents: envelope.contents as string,
      publication: envelope.preparationPublication as ReturnType<typeof nativePreparationPublication> };
  } catch { return null; }
}

export async function readNativePreparationPublication(db: Pick<Db, "select">, binding: Binding) {
  const parts = await db.select({ part: nativeRunnerCheckpoints.part,
    material: sql<Record<string, unknown> | null>`case when ${nativeRunnerCheckpoints.part} in ('header', 'cursor')
      and pg_column_size(${nativeRunnerCheckpoints.material}) <= ${NATIVE_CHECKPOINT_HEADER_INSPECTION_MAX_BYTES}
      then ${nativeRunnerCheckpoints.material} else null end`,
  }).from(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.companyId, binding.companyId),
    eq(nativeRunnerCheckpoints.issueId, binding.issueId), eq(nativeRunnerCheckpoints.runId, binding.runId))).limit(21);
  if (!parts.length) return { kind: "absent" as const };
  if (parts.length > 20) return null;
  const header = parts.find(part => part.part === "header"), cursor = parts.find(part => part.part === "cursor");
  if (!header?.material || !cursor?.material) return null;
  const inspected = inspectNativePreparationPublication(binding, header.material);
  const publication = inspected?.publication;
  if (!inspected || !publication || publication.schema !== "paperclip.native-preparation-publication.v1"
    || !["preparing", "launching"].includes(publication.kind)
    || publication.identity?.runId !== binding.runId || publication.headerSha256 !== preparationSha256(inspected.contents)
    || publication.partsSha256 !== preparationSha256(JSON.stringify(parts.map(part => part.part).sort()))) return null;
  try {
    const cursorText = decryptPart(createLocalEncryptedCipher("read"), binding, "cursor", cursor.material);
    if (publication.cursorSha256 !== preparationSha256(cursorText)) return null;
    return { kind: "published" as const, publication: publication as NativePreparationPublication, header: inspected.contents };
  } catch { return null; }
}

export async function readNativeCheckpointPublicationIdentity(db: Pick<Db, "execute">, binding: Binding) {
  const [row] = await db.execute<{ header: Record<string, unknown> | null; cursor: Record<string, unknown> | null;
    commands: number; events: number; templates: number; other: number }>(sql`
    with census as (
      select count(*) filter (where part ~ '^command:[0-9]+$')::int as commands,
        count(*) filter (where part ~ '^event:[0-9]+$')::int as events,
        count(*) filter (where part='staged-attachment-template')::int as templates,
        count(*) filter (where part not in ('header','cursor','staged-attachment-template')
          and part !~ '^(command|event):[0-9]+$')::int as other
      from native_runner_checkpoints where company_id=${binding.companyId}::uuid
        and issue_id=${binding.issueId}::uuid and run_id=${binding.runId}::uuid
    ) select case when pg_column_size(h.material)<=${NATIVE_CHECKPOINT_HEADER_INSPECTION_MAX_BYTES} then h.material else null end as header,
      case when pg_column_size(c.material)<=${NATIVE_CHECKPOINT_HEADER_INSPECTION_MAX_BYTES} then c.material else null end as cursor,
      census.* from census
      join native_runner_checkpoints h on h.company_id=${binding.companyId}::uuid and h.issue_id=${binding.issueId}::uuid
        and h.run_id=${binding.runId}::uuid and h.part='header'
      join native_runner_checkpoints c on c.company_id=h.company_id and c.issue_id=h.issue_id and c.run_id=h.run_id and c.part='cursor'`);
  if (!row?.header || !row.cursor || row.other !== 0 || readNativeCheckpointRetirement(row.header, binding)) return null;
  try {
    const cipher = createLocalEncryptedCipher("read"), header = decryptPart(cipher, binding, "header", row.header);
    const identity = inspectDurablePrpCheckpointHeader(header), cursor = JSON.parse(decryptPart(cipher, binding, "cursor", row.cursor));
    const state = JSON.parse(header).state;
    if (!identity || identity.runId !== binding.runId || cursor.commandCount !== row.commands || cursor.eventCount !== row.events
      || row.templates !== (state.stagedRunAttachment?.commandId === null ? 1 : 0)) return null;
    return { identity, header };
  } catch { return null; }
}

export async function readNativeGenericWarmPublication(db: Pick<Db, "select">, binding: Binding) {
  const [row] = await db.select({ material: sql<Record<string, unknown> | null>`case
    when pg_column_size(${nativeRunnerCheckpoints.material})<=${NATIVE_CHECKPOINT_HEADER_INSPECTION_MAX_BYTES}
    then ${nativeRunnerCheckpoints.material} else null end` }).from(nativeRunnerCheckpoints).where(and(
      eq(nativeRunnerCheckpoints.companyId, binding.companyId), eq(nativeRunnerCheckpoints.issueId, binding.issueId),
      eq(nativeRunnerCheckpoints.runId, binding.runId), eq(nativeRunnerCheckpoints.part, "header"))).limit(1);
  if (!row?.material) return null;
  try {
    const envelope = JSON.parse(createLocalEncryptedCipher("read").decrypt(row.material));
    const publication = envelope.warmAttachmentPublication as NativeGenericWarmAttachmentPublication | undefined;
    if (envelope.companyId !== binding.companyId || envelope.issueId !== binding.issueId || envelope.runId !== binding.runId
      || envelope.part !== "header" || !publication || publication.schema !== "paperclip.native-generic-warm-attachment.v1"
      || publication.targetIdentity.runId !== binding.runId || publication.headerSha256 !== preparationSha256(envelope.contents)
      || !inspectDurablePrpCheckpointHeader(envelope.contents)) return null;
    return { publication, header: envelope.contents as string };
  } catch { return null; }
}

async function rebindPreparationLaunchRows(db: Db, scope: Binding, previous: NativePreparationPublication, next: NativePreparationPublication) {
  const [row] = await db.select({ materials: sql<Record<string, unknown>>`jsonb_build_object(
    'nativeRunnerLaunchIntent', case when pg_column_size(${heartbeatRuns.runnerProfileJson}->'nativeRunnerLaunchIntent')<=1048576
      then ${heartbeatRuns.runnerProfileJson}->'nativeRunnerLaunchIntent' else null end,
    'nativeRemoteRunnerLaunchIntent', case when pg_column_size(${heartbeatRuns.runnerProfileJson}->'nativeRemoteRunnerLaunchIntent')<=1048576
      then ${heartbeatRuns.runnerProfileJson}->'nativeRemoteRunnerLaunchIntent' else null end)` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, scope.runId))).limit(1);
  const patch = rebindNativeLaunchMaterials(row?.materials ?? {}, scope, previous, next);
  if (Object.keys(patch).length) await db.update(heartbeatRuns).set({ runnerProfileJson: sql`${heartbeatRuns.runnerProfileJson} || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, scope.runId)));
}

export async function rebindNativePreparationAuthority(db: Db, scope: Binding,
  previous: { bootId: string | null; generation: number; leaseOwner: string | null },
  next: { bootId: string; generation: number; leaseOwner: string }) {
  const [header] = await db.select({ material: nativeRunnerCheckpoints.material }).from(nativeRunnerCheckpoints).where(and(
    eq(nativeRunnerCheckpoints.companyId, scope.companyId), eq(nativeRunnerCheckpoints.issueId, scope.issueId),
    eq(nativeRunnerCheckpoints.runId, scope.runId), eq(nativeRunnerCheckpoints.part, "header"))).limit(1);
  if (!header) return;
  const inspected = inspectNativePreparationPublication(scope, header.material), publication = inspected?.publication;
  const envelope = JSON.parse(createLocalEncryptedCipher("read").decrypt(header.material));
  const warm = envelope.warmAttachmentPublication as NativeGenericWarmAttachmentPublication | undefined;
  if (!publication && !warm) return;
  for (const proof of [publication, warm]) {
    if (proof && (proof.bootId !== previous.bootId || proof.generation !== previous.generation || proof.leaseOwner !== previous.leaseOwner)) {
      throw new Error("native_runner_launch_authority_unproven");
    }
  }
  if (publication) {
    const rebound = { ...publication, bootId: next.bootId, generation: next.generation, leaseOwner: next.leaseOwner };
    await rebindPreparationLaunchRows(db, scope, publication, rebound);
    envelope.preparationPublication = rebound;
  }
  if (warm) {
    if (warm.targetIdentity.runId !== scope.runId || warm.headerSha256 !== preparationSha256(envelope.contents)) {
      throw new Error("native_runner_launch_authority_unproven");
    }
    envelope.warmAttachmentPublication = { ...warm, bootId: next.bootId, generation: next.generation, leaseOwner: next.leaseOwner };
  }
  const material = createLocalEncryptedCipher("write").encrypt(JSON.stringify(envelope));
  await db.update(nativeRunnerCheckpoints).set({ material, updatedAt: new Date() }).where(and(
    eq(nativeRunnerCheckpoints.companyId, scope.companyId), eq(nativeRunnerCheckpoints.runId, scope.runId),
    eq(nativeRunnerCheckpoints.part, "header")));
}
